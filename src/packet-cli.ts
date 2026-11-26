import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildPacket, repositoryPath, type PacketRequest } from "./packet.ts";
import { commitOid, mergeBaseOid, repositoryRoot, reviewGit } from "./review-git.ts";
import { readRules, renderRules } from "./rules.ts";

export function runPacket(cwd: string, args: readonly string[]): void {
  const { values, positionals, tokens } = parseArgs({
    args: [...args],
    allowPositionals: true,
    tokens: true,
    options: {
      pr: { type: "string" }, from: { type: "string" }, to: { type: "string" },
      commit: { type: "string" }, workspace: { type: "boolean" }, files: { type: "boolean" },
      profile: { type: "string" }, json: { type: "boolean" }, out: { type: "string" },
    },
  });
  const seen = new Set<string>();
  let takingFiles = false;
  for (const token of tokens) {
    if (token.kind === "option") {
      if (seen.has(token.name)) throw new Error("A packet option was repeated. Use each option once.");
      seen.add(token.name);
      takingFiles = token.name === "files";
    } else if (token.kind === "positional" && !takingFiles) {
      throw new Error("Unexpected packet path. Place each path after --files.");
    }
  }
  if (values.profile !== undefined && values.profile !== "code") throw new Error("Unsupported profile. Use --profile code.");
  if (values.json && values.out !== undefined) throw new Error("Choose either --json or --out DIR.");
  const subjects = [values.pr !== undefined, values.from !== undefined || values.to !== undefined,
    values.commit !== undefined, values.workspace, values.files].filter(Boolean).length;
  if (subjects > 1) throw new Error("Multiple packet subjects supplied. Choose one subject.");
  let request: PacketRequest;
  if (values.pr !== undefined) request = { kind: "pr", number: values.pr };
  else if (values.from !== undefined || values.to !== undefined) {
    if (!values.from || !values.to) throw new Error("A range needs both endpoints. Pass --from A --to B.");
    request = { kind: "range", base: values.from, head: values.to };
  } else if (values.commit !== undefined) request = { kind: "commit", commit: values.commit };
  else if (values.files) request = { kind: "files", paths: positionals };
  else request = { kind: "workspace" };

  const bundle = buildPacket(cwd, request);
  const json = JSON.stringify(bundle.packet, null, 2);
  if (values.out !== undefined) {
    if (!values.out) throw new Error("Output directory is empty. Pass --out DIR.");
    const destination = resolve(cwd, values.out);
    const created: string[] = [];
    try {
      mkdirSync(destination, { recursive: true });
      for (const [name, text] of Object.entries({
        "packet.json": `${json}\n`,
        "diff.patch": bundle.diff,
        "rules.md": `${bundle.rules}\n`,
        "brief.md": `${bundle.brief}\n`,
      })) {
        const path = resolve(destination, name);
        writeFileSync(path, text, { flag: "wx", mode: 0o600 });
        created.push(path);
      }
    } catch {
      for (const path of created) unlinkSync(path);
      throw new Error("Cannot write packet files. Choose a writable output directory without existing packet files.");
    }
  } else {
    if (values.json && bundle.rulesMissing.some(rule => rule.source === "REVIEW.md")) {
      console.error("arev: REVIEW.md is unavailable at the merge base. Inspect the packet brief for details.");
    }
    console.log(values.json ? json : bundle.brief);
  }
}

export function runRules(cwd: string, args: readonly string[]): void {
  const check = args[0] === "check";
  const paths = check ? args.slice(1) : args;
  if (!paths.length || (check && paths.length !== 1)) throw new Error("Specify paths with arev rules <path...> or arev rules check <path>.");
  const root = repositoryRoot(cwd);
  const head = commitOid(root, "HEAD");
  const defaultRef = ["origin/HEAD", "origin/main", "origin/master"].find(ref =>
    reviewGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).status === 0);
  const base = defaultRef ? mergeBaseOid(root, commitOid(root, defaultRef), head) : head;
  const targets = [...new Set(paths.map(path => repositoryPath(cwd, root, path)))].map(path => ({ path, sides: [path] }));
  const rules = readRules(root, base, targets);
  console.log(`Rules at merge base ${base}:\n\n${renderRules(rules, !check)}`);
}
