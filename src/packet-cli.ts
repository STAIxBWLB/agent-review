import { closeSync, mkdirSync, openSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { EXIT, errorLine } from "@staix/cli-output";
import { deniedReportPath } from "./deny.ts";
import { Refusal, appendEvent, comparablePath } from "./ledger.ts";
import { buildPacket, packetBrief, packetResult, repositoryPath, type PacketBundle, type PacketRequest } from "./packet.ts";
import { parseReviewMd, type ReviewMdSettings } from "./review-md.ts";
import { commitOid, mergeBaseOid, repositoryRoot, reviewGit } from "./review-git.ts";
import { readRules, renderRules } from "./rules.ts";

/** Read the settings for the authoritative tree the packet uses. */
export function packetSettings(cwd: string, bundle: PacketBundle): ReviewMdSettings {
  return parseReviewMd(readRules(repositoryRoot(cwd), bundle.packet.subject.mergeBase, []).rules);
}

export function appendPacketEvent(cwd: string, bundle: PacketBundle, settings: ReviewMdSettings): void {
  appendEvent(cwd, { v: 1, type: "packet", at: new Date().toISOString(), packet: bundle.packet,
    review: { advisory_cap: settings.advisoryCap } });
}

export class PacketUsageError extends Error {}

/** A refusal whose own next step is the fix, printed as it stands rather than behind this command's help. */
function refuse(error: Refusal): number {
  for (const line of errorLine("arev", error.message, "", { tty: Boolean(process.stderr.isTTY), next: error.next })) console.error(line);
  return EXIT.fail;
}

/** Whether a destination is the worktree or inside it, comparing resolved paths so a symlinked root still matches. */
function insideWorktree(root: string, destination: string): boolean {
  const base = comparablePath(root), candidate = comparablePath(destination);
  return candidate === base || candidate.startsWith(base + sep);
}

function packetArgs(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      allowPositionals: true,
      tokens: true,
      options: {
        pr: { type: "string" }, from: { type: "string" }, to: { type: "string" },
        commit: { type: "string" }, workspace: { type: "boolean" }, files: { type: "boolean" },
        profile: { type: "string" }, contract: { type: "string" }, json: { type: "boolean" }, out: { type: "string" },
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
  if (values.contract === "" || (values.contract !== undefined && values.pr !== undefined)) {
    throw new PacketUsageError("Pass --contract FILE only without --pr.");
  }
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

  const root = repositoryRoot(cwd);
  // A workspace or files subject counts every uncommitted path in the worktree, so a bundle `--out` writes there is
  // itself a change: `arev record` rebuilds the packet and would refuse the report for the bundle just delivered.
  if (values.out !== undefined && (request.kind === "workspace" || request.kind === "files") &&
      insideWorktree(root, resolve(cwd, values.out))) {
    return refuse(new Refusal("The --out directory is inside the reviewed worktree, so this packet would count its own bundle as a change",
      "choose a directory outside the worktree"));
  }

  const bundle = buildPacket(cwd, request, { contractFile: values.contract });
  // `arev record` validates a report against the packet arev builds for that head, and the ledger's packet event is
  // where that packet is kept, so the event is written before this command returns, whatever it delivered. REVIEW.md's
  // settings are read from the whole merge-base rule text the packet was built from, and the cap is kept with the event
  // so the report is checked against the REVIEW.md this packet was built under.
  let settings: ReviewMdSettings;
  try {
    settings = packetSettings(root, bundle);
  } catch (error) {
    // The next step is the REVIEW.md line to change, not this command's help, so the refusal is printed as it stands.
    if (!(error instanceof Refusal)) throw error;
    return refuse(error);
  }
  const json = JSON.stringify(bundle.packet, null, 2);
  // Removes exactly what this call created, so a bundle is never left behind without the event that describes it.
  let discard = (): void => {};
  if (values.out !== undefined) {
    const destination = resolve(cwd, values.out);
    const created: string[] = [];
    let createdRoot: string | undefined;
    discard = () => {
      for (const path of created.splice(0)) {
        try { unlinkSync(path); } catch { /* Preserve the original failure. */ }
      }
      if (createdRoot === undefined) return;
      for (let dir = destination; ; dir = dirname(dir)) {
        try { rmdirSync(dir); } catch { break; }
        if (dir === createdRoot) break;
      }
      createdRoot = undefined;
    };
    try {
      createdRoot = mkdirSync(destination, { recursive: true });
      for (const [name, text] of Object.entries({
        "packet.json": `${json}\n`,
        "diff.patch": bundle.diff,
        "rules.md": `${bundle.rules}\n`,
        "brief.md": `${packetBrief(bundle, "file")}\n`,
        ...(bundle.contractText === undefined ? {} : { "contract.md": bundle.contractText }),
      })) {
        const path = resolve(destination, name);
        const file = openSync(path, "wx", 0o600);
        created.push(path);
        try { writeFileSync(file, text); }
        finally { closeSync(file); }
      }
    } catch {
      discard();
      throw new Error("Cannot write packet files. Choose a writable output directory without existing packet files.");
    }
  }
  // The event is written once the packet is delivered, and before this command returns: a failed `--out` export leaves
  // no event behind, so it cannot make the report for the packet the reviewer actually holds look stale. The reverse
  // holds too - an event that cannot be written takes the bundle with it, because nobody could record a report for it
  // and a retry would find the exclusive files already there.
  try {
    appendPacketEvent(cwd, bundle, settings);
  } catch (error) {
    discard();
    throw error;
  }
  if (values.out !== undefined) return;
  if (values.json && bundle.rulesMissing.some(rule => rule.source === "REVIEW.md")) {
    console.error("arev: REVIEW.md is unavailable at the merge base. Rerun without --json or use --out DIR for the brief.");
  }
  if (values.json) {
    console.log(bundle.contractText === undefined ? json : JSON.stringify(packetResult(bundle), null, 2));
  } else {
    console.log(packetBrief(bundle, "inline"));
    if (bundle.contractText !== undefined) process.stdout.write(`\n${bundle.contractText}`);
  }
}

export function runRules(cwd: string, args: readonly string[]): void {
  const check = args[0] === "check";
  const paths = check ? args.slice(1) : args;
  if (!paths.length || paths.some(path => path.startsWith("-")) || (check && paths.length !== 1)) {
    throw new PacketUsageError("Specify paths with arev rules <path...> or arev rules check <path>.");
  }
  const { base, rules } = rulesForPaths(cwd, paths);
  // A denied path contributes no rule, so the block is the empty one and the reader cannot tell an unknown path from a
  // withheld one. The line names the denial; it counts the paths instead of echoing them, because a supplied path is the
  // caller's untrusted text and this is output. The same predicate keeps them out of `Applies to:` in rulesForPaths, so
  // the count and the block cannot disagree about which spellings are withheld.
  const withheld = paths.filter(path => deniedReportPath(path)).length;
  const denied = withheld === 0
    ? []
    : [`${withheld} supplied ${withheld === 1 ? "path is" : "paths are"} withheld as denied, so no rule applies to ${withheld === 1 ? "it" : "them"}.`];
  console.log([`Rules at merge base ${base}:`, ...denied, renderRules(rules, !check)].join("\n\n"));
}

/** Resolve paths and read the trusted base rules for the CLI and MCP. */
export function rulesForPaths(cwd: string, paths: readonly string[]) {
  const root = repositoryRoot(cwd);
  const head = commitOid(root, "HEAD");
  const defaultRef = ["origin/HEAD", "origin/main", "origin/master"].find(ref =>
    reviewGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).status === 0);
  if (!defaultRef) {
    throw new Refusal("No origin default branch is available.",
      "Fetch origin and set its default branch with git remote set-head origin --auto.");
  }
  const base = mergeBaseOid(root, commitOid(root, defaultRef), head);
  // The rule reader screens with the case-sensitive isDenied, so a denied path spelled differently - folded case or
  // width, or a backslash separator - would reach `Applies to:` and take the root rule while the caller is told the path
  // is withheld. Every supplied spelling is matched here the way the packet matches it, before it becomes a rule target.
  const reviewable = paths.filter(path => !deniedReportPath(path));
  const targets = [...new Set(reviewable.map(path => repositoryPath(cwd, root, path)))].map(path => ({ path, sides: [path] }));
  const rules = readRules(root, base, targets);
  return { base, rules };
}
