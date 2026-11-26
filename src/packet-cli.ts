import { closeSync, mkdirSync, openSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EXIT, errorLine } from "@staix/cli-output";
import { Refusal, appendEvent } from "./ledger.ts";
import { buildPacket, repositoryPath, type PacketRequest } from "./packet.ts";
import { parseReviewMd, type ReviewMdSettings } from "./review-md.ts";
import { commitOid, mergeBaseOid, repositoryRoot, reviewGit } from "./review-git.ts";
import { readRules, renderRules } from "./rules.ts";

export class PacketUsageError extends Error {}

function packetArgs(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      allowPositionals: true,
      tokens: true,
      options: {
        pr: { type: "string" }, from: { type: "string" }, to: { type: "string" },
        commit: { type: "string" }, workspace: { type: "boolean" }, files: { type: "boolean" },
        profile: { type: "string" }, json: { type: "boolean" }, out: { type: "string" },
      },
    });
  } catch {
    throw new PacketUsageError("Invalid packet options. Use arev packet --help for accepted options and values.");
  }
}

export function runPacket(cwd: string, args: readonly string[]): number | void {
  const { values, positionals, tokens } = packetArgs(args);
  const seen = new Set<string>();
  let takingFiles = false;
  for (const token of tokens) {
    if (token.kind === "option") {
      if (seen.has(token.name)) throw new PacketUsageError("A packet option was repeated. Use each option once.");
      seen.add(token.name);
      takingFiles = token.name === "files";
    } else if (token.kind === "positional" && !takingFiles) {
      throw new PacketUsageError("Unexpected packet path. Place each path after --files.");
    }
  }
  if (values.profile !== undefined && values.profile !== "code") throw new PacketUsageError("Unsupported profile. Use --profile code.");
  if (values.out === "") throw new PacketUsageError("Output directory is empty. Pass --out DIR.");
  if (values.files && !positionals.length) throw new PacketUsageError("No file scope given. Pass paths after --files.");
  if (values.pr !== undefined && !/^[1-9][0-9]*$/.test(values.pr)) {
    throw new PacketUsageError("Invalid PR number. Pass a positive integer to --pr.");
  }
  if (values.json && values.out !== undefined) throw new PacketUsageError("Choose either --json or --out DIR.");
  const subjects = [values.pr !== undefined, values.from !== undefined || values.to !== undefined,
    values.commit !== undefined, values.workspace, values.files].filter(Boolean).length;
  if (subjects > 1) throw new PacketUsageError("Multiple packet subjects supplied. Choose one subject.");
  let request: PacketRequest;
  if (values.pr !== undefined) request = { kind: "pr", number: values.pr };
  else if (values.from !== undefined || values.to !== undefined) {
    if (!values.from || !values.to) throw new PacketUsageError("A range needs both endpoints. Pass --from A --to B.");
    request = { kind: "range", base: values.from, head: values.to };
  } else if (values.commit !== undefined) request = { kind: "commit", commit: values.commit };
  else if (values.files) request = { kind: "files", paths: positionals };
  else request = { kind: "workspace" };

  const bundle = buildPacket(cwd, request);
  // `arev record` validates a report against the packet arev builds for that head, and the ledger's packet event is
  // where that packet is kept, so it is written before the reviewer can hold a packet.json without one. REVIEW.md's
  // settings are read from the same merge-base rule text the packet was built from, and the cap is kept with the event
  // so the report is checked against the REVIEW.md this packet was built under.
  let settings: ReviewMdSettings;
  try {
    settings = parseReviewMd(readRules(repositoryRoot(cwd), bundle.packet.subject.mergeBase, []).rules);
  } catch (error) {
    // The next step is the REVIEW.md line to change, not this command's help, so the refusal is printed as it stands.
    if (!(error instanceof Refusal)) throw error;
    for (const line of errorLine("arev", error.message, "", { tty: Boolean(process.stderr.isTTY), next: error.next })) console.error(line);
    return EXIT.fail;
  }
  appendEvent(cwd, { v: 1, type: "packet", at: new Date().toISOString(), packet: bundle.packet, review: { advisory_cap: settings.advisoryCap } });
  const json = JSON.stringify(bundle.packet, null, 2);
  if (values.out !== undefined) {
    const destination = resolve(cwd, values.out);
    const created: string[] = [];
    let createdRoot: string | undefined;
    try {
      createdRoot = mkdirSync(destination, { recursive: true });
      for (const [name, text] of Object.entries({
        "packet.json": `${json}\n`,
        "diff.patch": bundle.diff,
        "rules.md": `${bundle.rules}\n`,
        "brief.md": `${bundle.brief}\n`,
      })) {
        const path = resolve(destination, name);
        const file = openSync(path, "wx", 0o600);
        created.push(path);
        try { writeFileSync(file, text); }
        finally { closeSync(file); }
      }
    } catch {
      for (const path of created) {
        try { unlinkSync(path); } catch { /* Preserve the original write failure. */ }
      }
      if (createdRoot) {
        for (let dir = destination; ; dir = dirname(dir)) {
          try { rmdirSync(dir); } catch { break; }
          if (dir === createdRoot) break;
        }
      }
      throw new Error("Cannot write packet files. Choose a writable output directory without existing packet files.");
    }
  } else {
    if (values.json && bundle.rulesMissing.some(rule => rule.source === "REVIEW.md")) {
      console.error("arev: REVIEW.md is unavailable at the merge base. Rerun without --json or use --out DIR for the brief.");
    }
    console.log(values.json ? json : bundle.brief);
  }
}

export function runRules(cwd: string, args: readonly string[]): void {
  const check = args[0] === "check";
  const paths = check ? args.slice(1) : args;
  if (!paths.length || paths.some(path => path.startsWith("-")) || (check && paths.length !== 1)) {
    throw new PacketUsageError("Specify paths with arev rules <path...> or arev rules check <path>.");
  }
  const root = repositoryRoot(cwd);
  const head = commitOid(root, "HEAD");
  const defaultRef = ["origin/HEAD", "origin/main", "origin/master"].find(ref =>
    reviewGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).status === 0);
  if (!defaultRef) {
    throw new Error("No origin default branch is available. Fetch origin and set its default branch with git remote set-head origin --auto.");
  }
  const base = mergeBaseOid(root, commitOid(root, defaultRef), head);
  const targets = [...new Set(paths.map(path => repositoryPath(cwd, root, path)))].map(path => ({ path, sides: [path] }));
  const rules = readRules(root, base, targets);
  console.log(`Rules at merge base ${base}:\n\n${renderRules(rules, !check)}`);
}
