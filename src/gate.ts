/**
 * `arev gate`: the merge-time answer to "is this exact head reviewed".
 *
 * It reads only the ledger and git (spec AC4), so the same two inputs give the same answer. V1's one GitHub write is
 * here and only behind `--post`, which runs after a pass and writes the `post` event (AC5).
 */
import { spawnSync } from "node:child_process";
import { EXIT, errorLine } from "@staix/cli-output";
import { Refusal, appendEvent, readLedger, type LedgerEvent, type ReviewRecordV1 } from "./ledger.ts";
import { ledgerEventsView } from "./record.ts";
import { parseReviewMd } from "./review-md.ts";
import { commitOid } from "./review-git.ts";
import { readRules } from "./rules.ts";

/** One gate evaluation: what was gated, what the ledger says, and each condition still open. */
export interface GateResult {
  head: string;
  base?: string;
  record?: string;
  verdict?: ReviewRecordV1["verdict"];
  ok: boolean;
  open: string[];
}

const FULL_OID = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const STATUS_CONTEXT = "arev/gate";

/** The commit a rules file is read from: the record's merge base, else its base. */
function ruleBase(record: ReviewRecordV1): string | undefined {
  const { mergeBase, base } = record.packet.subject;
  return mergeBase ?? base;
}

/**
 * The gate's decision, with no output and no side effect. `head` defaults to the repository's current HEAD.
 */
export function gateReport(cwd: string, options: { head?: string; home?: string } = {}): GateResult {
  const head = options.head ?? commitOid(cwd, "HEAD");
  if (!FULL_OID.test(head)) throw new Refusal(`--head must be a full commit SHA (got ${head})`, "pass the full 40-character head SHA");
  const events = readLedger(cwd, { home: options.home });
  const recordEvent = [...events].reverse().find((event): event is Extract<LedgerEvent, { type: "record" }> =>
    event.type === "record" && event.record.packet.subject.head === head);
  const view = ledgerEventsView(events, head);
  const base = recordEvent ? ruleBase(recordEvent.record) : undefined;
  const open: string[] = [];

  if (!recordEvent) {
    open.push(`no record for head ${head}; run arev record with the report for this head`);
  } else {
    const record = recordEvent.record;
    const reviewer = record.reviewer;
    const implementer = reviewer.implementer;
    const selfReview = implementer !== undefined && implementer === reviewer.id;
    // One read of the base-tree rules: the [gate] settings and the REVIEW.md presence check both come from it (AC2).
    const rules = base === undefined ? undefined : readRules(cwd, base, []).rules;
    const allowed = parseReviewMd(rules ?? []).sameFamily === "allow";
    // Spec AC4: pass iff the reviewer is not the implementer, or the fallback is declared and REVIEW.md allows it.
    if (selfReview && !(reviewer.sameFamilyFallback && allowed)) {
      open.push(`the reviewer ${reviewer.id} is the implementer; a self-review passes only with sameFamilyFallback and [gate] same_family = "allow"`);
    }
    // A declared fallback on someone else's review needs the same setting; on a self-review the condition above names it.
    if (reviewer.sameFamilyFallback && !allowed && !selfReview) {
      open.push(`the reviewer ${reviewer.id} declares a same-family fallback and REVIEW.md does not set [gate] same_family = "allow"`);
    }
    if (view.openBlocking.length) open.push(`blocking findings are open: ${view.openBlocking.join(", ")}`);
    if (!record.call.ok) open.push(`the reviewer call failed${record.call.error ? `: ${record.call.error}` : ""}`);
    // `--light` belongs to the record (spec #1, Decisions 2026-11-26): the reviewer states it, the gate reads it.
    if (record.light !== true && !(rules ?? []).some(rule => rule.name === "REVIEW.md")) {
      open.push(`${base === undefined ? "the record names no base to read REVIEW.md at" : `REVIEW.md is not at the merge base ${base}`}; record the review with --light only when it was made without one`);
    }
  }

  return {
    head,
    ...(base === undefined ? {} : { base }),
    ...(recordEvent ? { record: recordEvent.id, verdict: recordEvent.record.verdict } : {}),
    ok: open.length === 0 && recordEvent !== undefined,
    open,
  };
}

/**
 * Post the `arev/gate` success status for a head the gate just passed. The description names the record, so the status
 * on the commit says which review it stands for. Nothing here decides whether to post.
 */
export function postStatus(head: string, record: string, cwd: string): void {
  const description = `${STATUS_CONTEXT}: record ${record}`;
  if (Buffer.byteLength(description) > 140) {
    throw new Refusal(`the status description would be ${Buffer.byteLength(description)} bytes; a commit status allows 140`,
      "shorten the record id or the context");
  }
  const result = spawnSync("gh", ["api", "--method", "POST", `repos/{owner}/{repo}/statuses/${head}`,
    "-f", "state=success", "-f", `context=${STATUS_CONTEXT}`, "-f", `description=${description}`], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").filter(Boolean)[0] ?? `gh exited ${result.status}`;
    throw new Refusal(`cannot post the ${STATUS_CONTEXT} status on ${head}: ${detail}`,
      "check that gh is authenticated and the token may write commit statuses for this repository");
  }
}

const stderrTty = (): boolean => Boolean(process.stderr.isTTY);

function usageError(message: string): number {
  for (const line of errorLine("arev", message, "", { tty: stderrTty(), next: "arev gate --help" })) console.error(line);
  return EXIT.usage;
}

function failure(error: unknown): number {
  if (!(error instanceof Refusal)) throw error;
  for (const line of errorLine("arev", error.message, "", { tty: stderrTty(), next: error.next })) console.error(line);
  return EXIT.fail;
}

interface Parsed {
  flags: Record<string, string[]>;
}
function parseFlags(args: readonly string[], spec: { value: readonly string[]; boolean: readonly string[] }): Parsed | undefined {
  const flags: Record<string, string[]> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) return undefined;
    const kind = spec.boolean.includes(arg) ? "boolean" : spec.value.includes(arg) ? "value" : undefined;
    if (!kind) return undefined;
    if (kind === "boolean") {
      flags[arg] = [...(flags[arg] ?? []), "true"];
      continue;
    }
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) return undefined;
    flags[arg] = [...(flags[arg] ?? []), next];
    index++;
  }
  return { flags };
}

/** `arev gate [--head SHA] [--post] [--json]`. */
export function gateCommand(cwd: string, args: readonly string[]): number {
  const parsed = parseFlags(args, { value: ["--head"], boolean: ["--post", "--json"] });
  if (!parsed) return usageError("gate takes --head SHA, --post and --json");
  try {
    const result = gateReport(cwd, {
      ...(parsed.flags["--head"]?.at(-1) === undefined ? {} : { head: parsed.flags["--head"]!.at(-1)! }),
    });
    if (parsed.flags["--post"] !== undefined) {
      // No status is ever posted for a head the gate did not pass, and a failing gate posts nothing.
      if (!result.ok || result.record === undefined) {
        if (parsed.flags["--json"] !== undefined) console.log(JSON.stringify(result, null, 2));
        else for (const line of [`gate: fails at ${result.head}`, ...result.open.map(condition => `  ${condition}`)]) console.log(line);
        return EXIT.fail;
      }
      postStatus(result.head, result.record, cwd);
      appendEvent(cwd, { v: 1, type: "post", at: new Date().toISOString(), head: result.head, record: result.record, status: "success" });
    }
    if (parsed.flags["--json"] !== undefined) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`head ${result.head}${result.base ? ` base ${result.base}` : ""}`);
      console.log(`record ${result.record ?? "(none)"}${result.verdict ? ` verdict ${result.verdict}` : ""}`);
      if (result.ok) console.log("gate: passes");
      else for (const line of ["gate: fails", ...result.open.map(condition => `  ${condition}`)]) console.log(line);
      if (parsed.flags["--post"] !== undefined && result.ok && result.record) {
        console.log(`posted ${STATUS_CONTEXT} success on ${result.head} for record ${result.record}`);
      }
    }
    return result.ok ? EXIT.ok : EXIT.fail;
  } catch (error) {
    return failure(error);
  }
}
