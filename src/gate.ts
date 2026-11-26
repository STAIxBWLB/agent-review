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
 * The bound both gh calls take for time, the same one `arev packet --pr` gives its own `gh pr view` (src/packet.ts): a
 * metadata read or a status write that has not answered in fifteen seconds is a network that is not going to, and the
 * gate is meant to be runnable in a hook.
 *
 * The bound is a hard return because both calls pass `killSignal: "SIGKILL"`: `spawnSync`'s default signal is SIGTERM,
 * and a child that ignores it keeps the call inside `spawnSync` until that child exits on its own (measured on Bun
 * 1.4.4: a 500 ms bound returned after 2013 ms, with `status: 0` and the timeout in `error`). With SIGKILL the same
 * probe returns at 502 ms with `status: null`, `signal: "SIGKILL"` and `error.code: "ETIMEDOUT"`.
 */
const GH_TIMEOUT_MS = 15_000;
const GH_KILL_SIGNAL = "SIGKILL" as const;
/**
 * A status write answers with one small object, so its reply bound stays narrow. The pulls read cannot: the endpoint
 * returns whole pull request objects, bodies included - one open pull request with a 3,574-byte body measured 19,779
 * bytes - so two of them overflow a metadata-sized bound. It takes the bound every git read in `src/review-git.ts`
 * takes instead. A reply over either bound is refused by its size, never as a timeout: the same call returns the same.
 */
const GH_WRITE_MAX_BUFFER = 32_000;
const GH_READ_MAX_BUFFER = 16 * 1024 * 1024;

/** One finished `gh` call. A bound `spawnSync` enforced, and a buffer it filled, arrive as `error`, not as a status. */
interface GhCall {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal?: string | null;
}

const errorCode = (call: GhCall): string | undefined => (call.error as NodeJS.ErrnoException | undefined)?.code;

/**
 * A refused call, whichever way it says so, and read before the status: a child that ignores the signal it is sent
 * exits 0 while `spawnSync` still reports `ETIMEDOUT`, and a reply that filled `maxBuffer` exits 0 as well. Testing
 * `status !== 0` alone would read both as a success - the first as an answer that never came, the second by handing a
 * truncated reply to `JSON.parse`.
 */
const failed = (call: GhCall): boolean => call.error !== undefined || call.status !== 0;

/**
 * A call that ran out of its bound: the error code, or - only when the call carries no error of its own - the signal
 * that ended it. The signal cannot decide on its own: a reply that fills `maxBuffer` also ends with the child signalled
 * (measured: `ENOBUFS` beside `SIGTERM`), and reading that as a timeout would name a bound it never reached.
 */
const timedOut = (call: GhCall): boolean =>
  errorCode(call) === "ETIMEDOUT" ||
  (call.error === undefined && (call.signal === "SIGTERM" || call.signal === "SIGKILL"));

/** A reply that reached `maxBuffer`, where what came back is a prefix of it. */
const overBuffer = (call: GhCall): boolean => errorCode(call) === "ENOBUFS";

/**
 * What a refusal may say about a failed `gh` call: the bound it ran out of, the buffer it filled, or gh's own first
 * line through `shown`, because that line is data read from outside arev.
 */
const ghDetail = (call: GhCall, maxBuffer: number): string =>
  timedOut(call) ? `gh did not answer within ${GH_TIMEOUT_MS / 1000} s`
    : overBuffer(call) ? `gh printed more than the ${maxBuffer} bytes this call keeps`
      : shown((call.stderr || call.stdout || "").trim().split("\n").filter(Boolean)[0] ?? `gh exited ${call.status}`);


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
function openPrsAt(cwd: string, repository: string, head: string, retry: string): PullRequest[] {
  // `--hostname` is pinned because `GH_HOST` or gh's own default would send this read, and the status write with it, to
  // another host. `--paginate --slurp` reads every page: a second page can hold an open PR at this head too.
  const result = spawnSync("gh", ["api", "--hostname", "github.com", "--paginate", "--slurp", `repos/${repository}/commits/${head}/pulls`],
    { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: GH_READ_MAX_BUFFER, killSignal: GH_KILL_SIGNAL });
  if (failed(result)) {
    throw new Refusal(`cannot read the open pull requests at ${head}: ${ghDetail(result, GH_READ_MAX_BUFFER)}`,
      timedOut(result) ? retry
        : overBuffer(result) ? `read the same list by hand (gh api --hostname github.com --paginate --slurp repos/${repository}/commits/${head}/pulls); the reply is larger than arev keeps, and the same read returns the same list`
          : "check that gh is authenticated and may read this repository's pull requests");
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
    // The gate compares the record's merge base with the one this base has right now, whatever branch the PR targets:
    // a base on another branch that merges into the same commit is the same change, so a mismatch is the change moving.
    throw new Refusal(`PR ${pull.number} now merges into a base whose merge base is ${current}, and the record was made against ${result.mergeBase ?? "(none)"}, so the review is of a different change`,
      `re-review the PR as it now merges with arev packet --pr ${pull.number} and post from the new head - the PR's merge base must equal the reviewed one`);
  }
}

/**
 * Post the `arev/gate` success status for a head the gate just passed. The description names the record, so the status
 * on the commit says which review it stands for. Nothing here decides whether to post.
 */
export function postStatus(head: string, record: string, repository: string, cwd: string, retry: string): void {
  const description = `${STATUS_CONTEXT}: record ${record}`;
  if (Buffer.byteLength(description) > 140) {
    throw new Refusal(`the status description would be ${Buffer.byteLength(description)} bytes; a commit status allows 140`,
      "shorten the record id or the context");
  }
  // The host is pinned for the write as well: `GH_HOST` would otherwise decide where this status lands.
  const result = spawnSync("gh", ["api", "--hostname", "github.com", "--method", "POST", `repos/${repository}/statuses/${head}`,
    "-f", "state=success", "-f", `context=${STATUS_CONTEXT}`, "-f", `description=${description}`],
    { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: GH_WRITE_MAX_BUFFER, killSignal: GH_KILL_SIGNAL });
  if (failed(result)) {
    // A write that ran out of time may still have landed: the request reached GitHub and only the answer is missing, so
    // the status is looked for before the same one is written again. The lookup has to name this write's record: an
    // older arev/gate status can sit on the same head under the same context for a different review, and its presence
    // would read as this write landing.
    throw new Refusal(`cannot post the ${STATUS_CONTEXT} status on ${head}: ${ghDetail(result, GH_WRITE_MAX_BUFFER)}`,
      timedOut(result) ? `check for an existing ${STATUS_CONTEXT} status on ${head} whose description names record ${record} (gh api --hostname github.com repos/${repository}/commits/${head}/statuses) - a write that ran out of time may already have landed, and another record's status carries the same context, so ${retry}`
        : overBuffer(result) ? "check with gh auth status that the token may write commit statuses for this repository; gh's reply to the same write does not get smaller"
          : "check that gh is authenticated and the token may write commit statuses for this repository");
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
    // The retry a timed-out call is answered with names the subject this run gated, so it gates the same one: `--head`
    // is the resolved full OID (validated above, so it is echoed only as the SHA it is), and `--pr` is passed through
    // when the run was given one, `none` included.
    const retry = ["retry arev gate --post", `--head ${result.head}`, ...(prFlag === undefined ? [] : [`--pr ${prFlag}`]),
      "once github.com is reachable from this machine"].join(" ");
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
      const pulls = openPrsAt(cwd, repository, result.head, retry);
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
      postStatus(result.head, result.record, repository!, cwd, retry);
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
