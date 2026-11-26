/**
 * `arev gate`: the merge-time answer to "is this exact head reviewed".
 *
 * It reads only the ledger and git (spec AC4), so the same two inputs give the same answer. V1's one GitHub write is
 * here and only behind `--post`, which runs after a pass and writes the `post` event (AC5).
 */
import { spawnSync } from "node:child_process";
import { EXIT, errorLine } from "@staix/cli-output";
import { Refusal, appendEvent, githubRepository, readLedger, shown, type LedgerEvent, type ReviewRecordV1 } from "./ledger.ts";
import { PR_NUMBER, ledgerEventsView, threadsAtHead } from "./record.ts";
import { parseReviewMd } from "./review-md.ts";
import { commitOid, mergeBaseOid, reviewGit } from "./review-git.ts";
import { readRules } from "./rules.ts";

/** One gate evaluation: what was gated, what the ledger says, and each condition still open. */
export interface GateResult {
  head: string;
  /** The record's own base: what its packet was built from. */
  base?: string;
  /** The merge base the gate checked the record against: the origin default branch's, right now. */
  mergeBase?: string;
  record?: string;
  /** The review thread the record belongs to, which is the PR a status posted here would speak for. */
  pr?: number;
  verdict?: ReviewRecordV1["verdict"];
  ok: boolean;
  open: string[];
}

const FULL_OID = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const HEX = /^[0-9a-f]{1,64}$/i;
const STATUS_CONTEXT = "arev/gate";
/** The subject kinds a gate can pass: a review of the branch, not of one commit or of uncommitted changes. */
const BRANCH_KINDS = ["range", "pr"];

/** The commit a rules file is read from: the record's merge base, else its base. */
function ruleBase(record: ReviewRecordV1): string | undefined {
  const { mergeBase, base } = record.packet.subject;
  return mergeBase ?? base;
}

/**
 * The merge base of the origin default branch and `head`, read exactly as `arev rules` reads its base: AC4's "current
 * full head and base" is the base the branch would merge into now, not the one its packet was built against.
 */
function currentMergeBase(cwd: string, head: string): string {
  const defaultRef = ["origin/HEAD", "origin/main", "origin/master"].find(ref =>
    reviewGit(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).status === 0);
  if (!defaultRef) {
    throw new Refusal("No origin default branch is available. Fetch origin and set its default branch with git remote set-head origin --auto.",
      "git remote set-head origin --auto");
  }
  return mergeBaseOid(cwd, commitOid(cwd, defaultRef), head);
}

/** A SHA echoed back only when it is one: any other `--head` value is named by its length, never repeated. */
const shownHead = (value: string): string =>
  HEX.test(value) ? ` (got ${value})` : ` (got ${value.length} characters that are not a hexadecimal commit SHA)`;

/**
 * The one line of a failed `gh` call a refusal may print. gh's own text is data read from outside arev, so it is
 * screened like any other untrusted value: a secret-shaped line leaves the exit status as the only detail to name.
 */
const ghDetail = (result: { status: number | null; stdout: string; stderr: string }): string =>
  shown((result.stderr || result.stdout || "").trim().split("\n").filter(Boolean)[0] ?? `gh exited ${result.status}`);

/**
 * The gate's decision, with no output and no side effect. `head` defaults to the repository's current HEAD, and `pr`
 * names the review thread when more than one PR was reviewed at that head; `"none"` names the thread with no PR, which
 * is the exact-head review a packet built without `--pr` produces.
 */
export function gateReport(cwd: string, options: { head?: string; pr?: number | "none"; home?: string } = {}): GateResult {
  const head = options.head ?? commitOid(cwd, "HEAD");
  if (!FULL_OID.test(head)) throw new Refusal(`--head must be a full commit SHA${shownHead(head)}`, "pass the full 40-character head SHA");
  const mergeBase = currentMergeBase(cwd, head);
  const events = readLedger(cwd, { home: options.home });
  // The view owns the choice of review thread, and it refuses a head two PRs share unless `--pr` names one: a gate that
  // picked the newest record at the head would pass a PR on another PR's review of the same commit.
  const view = ledgerEventsView(events, head, options.pr);
  const recordEvent = view.record === undefined ? undefined : events.find((event): event is Extract<LedgerEvent, { type: "record" }> =>
    event.type === "record" && event.id === view.record);
  const base = recordEvent ? ruleBase(recordEvent.record) : undefined;
  const open: string[] = [];

  if (!recordEvent) {
    open.push(`no record for head ${head}; run arev record with the report for this head`);
  } else {
    const record = recordEvent.record;
    const reviewer = record.reviewer;
    const implementer = reviewer.implementer;
    const selfReview = implementer !== undefined && implementer === reviewer.id;
    // AC4 gates the head *and* the base: a record built against a base the branch no longer merges into reviewed a
    // different change, and a workspace or commit record reviewed something that is not this branch.
    const kind = record.packet.subject.kind;
    if (kind === undefined || !BRANCH_KINDS.includes(kind)) {
      open.push(`record subject is ${kind ?? "(unstated)"}; record a range or PR review`);
    }
    const recordedBase = record.packet.subject.mergeBase;
    if (recordedBase !== mergeBase) {
      open.push(`record made against merge base ${recordedBase ?? "(none)"}; current merge base is ${mergeBase}; rerun arev packet`);
    }
    // One read of the base-tree rules: the [gate] settings and the REVIEW.md presence check both come from it (AC2).
    const rules = base === undefined ? undefined : readRules(cwd, base, []).rules;
    const allowed = parseReviewMd(rules ?? []).sameFamily === "allow";
    // AC4 asks whether the reviewer is independent of the implementer, which needs the implementer named: a record
    // without one cannot be checked, so the absence fails rather than passing.
    if (implementer === undefined) {
      open.push("the record names no implementer, so independence cannot be checked; run arev record <report> --implementer <peer>");
    }
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
    mergeBase,
    ...(recordEvent ? {
      record: recordEvent.id,
      verdict: recordEvent.record.verdict,
      ...(recordEvent.record.packet.subject.pr === undefined ? {} : { pr: recordEvent.record.packet.subject.pr }),
    } : {}),
    ok: open.length === 0 && recordEvent !== undefined,
    open,
  };
}

/**
 * The repository a status is posted to: the origin the ledger is keyed to, parsed once in `src/ledger.ts` so
 * `arev packet --pr` reads its PR from the same repository. gh resolves `{owner}/{repo}` itself, from `GH_REPO` or the
 * working directory, and a status sent there names a repository this review did not happen in.
 */
function statusRepository(cwd: string): string {
  const repository = githubRepository(cwd);
  if (repository === undefined) {
    throw new Refusal("a status is posted to the GitHub repository origin names, and this repository's origin does not name one",
      "set origin to the GitHub repository URL (gh repo view --json url prints it)");
  }
  return repository;
}

/** A pull request at a head, as the pulls read reports it: the number, and the base it currently merges into. */
interface PullRequest {
  number: number;
  base?: { sha?: string; ref?: string };
}

/**
 * The open pull requests GitHub says have this commit as their head: a metadata read, and the only gh call besides the
 * status write (AC5). The ledger cannot answer this one - a PR arev never built a packet for is the case it misses.
 */
function openPrsAt(cwd: string, repository: string, head: string): PullRequest[] {
  // `--hostname` is pinned because `GH_HOST` or gh's own default would send this read, and the status write with it, to
  // another host. `--paginate --slurp` reads every page: a second page can hold an open PR at this head too.
  const result = spawnSync("gh", ["api", "--hostname", "github.com", "--paginate", "--slurp", `repos/${repository}/commits/${head}/pulls`],
    { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Refusal(`cannot read the open pull requests at ${head}: ${ghDetail(result)}`,
      "check that gh is authenticated and may read this repository's pull requests");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = undefined; }
  if (!Array.isArray(parsed)) {
    throw new Refusal(`the pull requests at ${head} came back in a shape arev does not read`,
      "run gh auth status, and check that gh api prints JSON for this repository");
  }
  // `--slurp` wraps each page in one array, so a multi-page reply is an array of arrays; a plain array of pull requests
  // is read as the single page it is.
  const pages = parsed.every((page: unknown) => Array.isArray(page)) ? parsed.map((page: unknown) => page as unknown[]) : [parsed as unknown[]];
  const pulls = pages.flatMap((page: unknown[]) => page);
  // The endpoint lists every pull request the commit appears in, which includes one that merely contains it: only a PR
  // whose own head is this commit can inherit a status posted here.
  return pulls.flatMap((pull: unknown) => {
    const item = pull as { number?: unknown; state?: unknown; head?: { sha?: unknown }; base?: { sha?: unknown; ref?: unknown } };
    if (item.state !== "open" || item.head?.sha !== head || typeof item.number !== "number") return [];
    const base = typeof item.base?.sha === "string"
      ? { ...(item.base.sha === undefined ? {} : { sha: item.base.sha }), ...(typeof item.base.ref === "string" ? { ref: item.base.ref } : {}) }
      : undefined;
    return [{ number: item.number, ...(base === undefined ? {} : { base }) }];
  });
}

/**
 * The pull request's current base and the reviewed one are the same change only when their merge bases agree: a PR
 * retargeted after its review carries a record of a different change (AC4 gates the head *and* the base). A base commit
 * this checkout does not hold is refused rather than fetched - a `git fetch` here would be a network call arev does not
 * make - and the next step is the fetch.
 */
function checkBase(cwd: string, result: GateResult, pull: PullRequest): void {
  const fix = `re-review against the PR's current base with arev packet --pr ${pull.number}, then post from the new head`;
  const base = pull.base?.sha;
  if (base === undefined) {
    throw new Refusal(`GitHub reports no base commit for PR ${pull.number}, so the review's merge base cannot be checked against it`, fix);
  }
  // The reply is data, and this value is handed to `rev-parse` and `merge-base` as an argument: only a full commit SHA of
  // either object format is compared, so a value gh returns like `--upload-pack=...` can never be read as an option.
  if (!FULL_OID.test(base)) {
    throw new Refusal(`GitHub reports a base commit for PR ${pull.number} that is not a full commit SHA, so the review's merge base cannot be checked against it`, fix);
  }
  if (reviewGit(cwd, ["rev-parse", "--verify", "-q", `${base}^{commit}`]).status !== 0) {
    throw new Refusal(`the base commit ${base} of PR ${pull.number} is not in this checkout, so the review's merge base cannot be checked against it`,
      "fetch it (git fetch origin) and post again");
  }
  const current = mergeBaseOid(cwd, base, result.head);
  if (current !== result.mergeBase) {
    // The gate checks the default branch's merge base, so re-reviewing against whatever this PR targets now would not
    // pass either: the PR has to target the default branch for the review to be of the change that lands.
    throw new Refusal(`PR ${pull.number} now merges into a base whose merge base is ${current}, and the record was made against ${result.mergeBase ?? "(none)"}, so the review is of a different change`,
      `target PR ${pull.number} at the repository's default branch, then re-review with arev packet --pr ${pull.number} and post from the new head - a stacked PR passes only once its base is the default branch`);
  }
}

/**
 * Post the `arev/gate` success status for a head the gate just passed. The description names the record, so the status
 * on the commit says which review it stands for. Nothing here decides whether to post.
 */
export function postStatus(head: string, record: string, repository: string, cwd: string): void {
  const description = `${STATUS_CONTEXT}: record ${record}`;
  if (Buffer.byteLength(description) > 140) {
    throw new Refusal(`the status description would be ${Buffer.byteLength(description)} bytes; a commit status allows 140`,
      "shorten the record id or the context");
  }
  // The host is pinned for the write as well: `GH_HOST` would otherwise decide where this status lands.
  const result = spawnSync("gh", ["api", "--hostname", "github.com", "--method", "POST", `repos/${repository}/statuses/${head}`,
    "-f", "state=success", "-f", `context=${STATUS_CONTEXT}`, "-f", `description=${description}`], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Refusal(`cannot post the ${STATUS_CONTEXT} status on ${head}: ${ghDetail(result)}`,
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

/** `arev gate [--head SHA] [--pr N|none] [--post] [--json]`. */
export function gateCommand(cwd: string, args: readonly string[]): number {
  const parsed = parseFlags(args, { value: ["--head", "--pr"], boolean: ["--post", "--json"] });
  if (!parsed) return usageError("gate takes --head <sha>, --pr <n|none>, --post and --json");
  // `none` names the thread with no PR, the spelling `show`, `resolve` and the view's own refusals use: a head whose
  // review without a PR shares its SHA with a numbered thread can only be gated by naming that one this way.
  const prFlag = parsed.flags["--pr"]?.at(-1);
  if (prFlag !== undefined && prFlag !== "none" && !PR_NUMBER.test(prFlag)) {
    return usageError("Invalid PR number. Pass a positive integer to --pr, or none for a review with no PR.");
  }
  try {
    const result = gateReport(cwd, {
      ...(parsed.flags["--head"]?.at(-1) === undefined ? {} : { head: parsed.flags["--head"]!.at(-1)! }),
      ...(prFlag === undefined ? {} : { pr: prFlag === "none" ? "none" : Number(prFlag) }),
    });
    // The spec's ledger has a `gate` event, so every evaluation is recorded: never inside the pure decision, and before
    // the post preflight, so an evaluation the preflight refuses is still an answer the ledger holds. The decision reads
    // only record, resolve and packet events, so writing it changes no later answer.
    appendEvent(cwd, {
      v: 1, type: "gate", at: new Date().toISOString(), head: result.head,
      ...(result.mergeBase === undefined ? {} : { base: result.mergeBase }),
      ok: result.ok,
      ...(result.record === undefined ? {} : { record: result.record }),
      ...(result.open.length === 0 ? {} : { open: result.open }),
    });
    // A commit status belongs to the commit, not to the PR: on a head more than one thread reviewed, a success posted
    // from one PR's pass shows on every other PR's checks, which is a status the gate did not pass there. The plain gate
    // still answers for the thread it was asked about; only the post refuses, and it refuses before any GitHub call.
    // The set is deliberately "a packet or a record": a PR that has only built its packet still has checks on this
    // commit, so narrowing this to recorded threads (as the head's ambiguity decision does) would post over it.
    if (parsed.flags["--post"] !== undefined) {
      const threads = threadsAtHead(readLedger(cwd), result.head);
      if (threads.length > 1) {
        throw new Refusal(`head ${result.head} has packets or records in more than one thread (${threads.map(thread => thread === undefined ? "no PR" : `PR ${thread}`).join(", ")}), and a commit status is per commit, so a status posted for one PR shows on the others`,
          "push a distinct commit for each PR and post the gate from that PR's own head");
      }
    }
    // The ledger only knows the pull requests arev built a packet for, and a status lives on the commit: every open PR
    // at this head is read from GitHub, page by page, and one that is not the thread this gate posts for would inherit
    // the status. Both this read and the status write name the repository origin gives and the host github.com, never
    // the ones gh resolves for itself, and the PR's current base is compared with the reviewed merge base.
    // ponytail: a pull request opened on this head after the status is posted still inherits it, and GitHub lists open
    // PRs for this endpoint only while the commit is outside the default branch - a head already on main has no open PR
    // to protect. Both follow from a status being per commit.
    let repository: string | undefined;
    if (parsed.flags["--post"] !== undefined && result.ok && result.record !== undefined) {
      repository = statusRepository(cwd);
      const pulls = openPrsAt(cwd, repository, result.head);
      const others = pulls.filter(pull => pull.number !== result.pr);
      if (others.length > 0) {
        const named = others.map(pull => `PR ${pull.number}`).join(", ");
        throw new Refusal(`head ${result.head} heads open ${named} ${result.pr === undefined ? "and this review names no PR thread" : `besides PR ${result.pr}`}, and a commit status is per commit: a success posted here would satisfy their checks, though the gate did not pass for ${others.length === 1 ? "that PR" : "those PRs"}`,
          "push a distinct commit for each PR and post the gate from that PR's own head");
      }
      // The thread this gate posts for must be the PR that heads the commit now, merging into the reviewed base: a PR
      // retargeted since its review would get a status for a different change.
      if (result.pr !== undefined) {
        const own = pulls.find(pull => pull.number === result.pr);
        if (own === undefined) {
          throw new Refusal(`the gate posts for PR ${result.pr}, and GitHub does not report it open at head ${result.head}`,
            "check that the pull request is open at this head, or post the gate from the commit it now heads");
        }
        checkBase(cwd, result, own);
      }
    }
    if (parsed.flags["--post"] !== undefined) {
      // No status is ever posted for a head the gate did not pass, and a failing gate posts nothing.
      if (!result.ok || result.record === undefined) {
        if (parsed.flags["--json"] !== undefined) console.log(JSON.stringify(result, null, 2));
        else for (const line of [`gate: fails at ${result.head}`, ...result.open.map(condition => `  ${condition}`)]) console.log(line);
        return EXIT.fail;
      }
      postStatus(result.head, result.record, repository!, cwd);
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
