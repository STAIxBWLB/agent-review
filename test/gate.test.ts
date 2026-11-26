import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gateReport } from "../src/gate.ts";
import { appendEvent, ledgerPath, recordId, Refusal, secretShaped, type LedgerEvent, type PacketBlock, type ReviewRecordV1 } from "../src/ledger.ts";
import { parseReviewRecord } from "../src/record.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function gitOut(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) throw new Error(`${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

interface Fixture { repo: string; home: string; older: string; base: string; head: string }

/**
 * A repository with three commits, so a record for one head can be checked against another. `REVIEW.md` is committed
 * in the oldest commit, so it is at every merge base this fixture can name; `null` leaves it out, which is the case a
 * record made with `--light` exists for. The ledger's home is a sibling of the worktree, never inside it.
 */
function fixture(review: string | null = "# Review\n- Every change is reviewed against its packet.\n"): Fixture {
  const root = temp("arev-gate-");
  const repo = join(root, "repo"), home = join(root, "agenthub");
  mkdirSync(repo);
  gitOut(repo, ["init", "-q", "-b", "main"]);
  gitOut(repo, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  const commit = (files: Record<string, string>, message: string): string => {
    for (const [path, body] of Object.entries(files)) {
      const target = join(repo, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    gitOut(repo, ["add", "."]);
    gitOut(repo, ["commit", "-qm", message]);
    return gitOut(repo, ["rev-parse", "HEAD"]);
  };
  const older = commit({ ...(review === null ? {} : { "REVIEW.md": review }), "src/a.ts": "export const a = 1;\n" }, "older");
  const base = commit({ "src/a.ts": "export const a = 2;\n" }, "base");
  const head = commit({ "src/a.ts": "export const a = 3;\n" }, "head");
  // The gate reads its merge base the way `arev rules` does, from the origin default branch, so the fixture gives the
  // remote one: `base` is upstream, which makes a packet built from `base` be at the current merge base.
  gitOut(repo, ["update-ref", "refs/remotes/origin/main", base]);
  gitOut(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  return { repo, home, older, base, head };
}

/** Move the origin default branch, so a test can check a record against a base that has since moved. */
function upstream(repo: string, sha: string): void {
  gitOut(repo, ["update-ref", "refs/remotes/origin/main", sha]);
}

const PACKET = "d".repeat(64);
type Subject = PacketBlock["subject"];

const packetFor = (subject: Subject): PacketBlock => ({
  id: PACKET,
  profile: "code",
  subject,
  units: [{ path: "src/a.ts", status: "M", insertions: 1, deletions: 0 }],
  rules: [{ name: "REVIEW.md", sha256: "e".repeat(64), appliesTo: ["src/a.ts"] }],
});

const reportFor = (subject: Subject, changes: Record<string, unknown> = {}) => ({
  v: 1,
  packet: { id: PACKET, subject },
  reviewer: { id: "claude", modelFamily: "anthropic", started: "self", implementer: "codex", sameFamilyFallback: false },
  coverage: { reviewed: ["src/a.ts"], skipped: [] },
  findings: [],
  verdict: "approved",
  call: { ok: true },
  ...changes,
});

/** The record a reviewer files for a packet, through the real validator, so a test can only seed what it accepts. */
const recordFor = (subject: Subject, changes: Record<string, unknown> = {}, options: { light?: boolean } = {}): ReviewRecordV1 =>
  parseReviewRecord(reportFor(subject, changes), { packet: packetFor(subject), ...(options.light ? { light: true } : {}) });

const blocking = (changes: Record<string, unknown> = {}) => ({
  id: "bugs:open-one", term: "bugs", severity: "blocking", disposition: "open", origin: "introduced",
  text: "the review did not read src/a.ts", ...changes,
});

/** Append the packet, the record and any later events a case needs, and return the record's id. */
function seed(options: { repo: string; home: string; subject: Subject; record: ReviewRecordV1; extra?: LedgerEvent[] }): string {
  const { repo, home, subject, record, extra = [] } = options;
  const id = recordId(record);
  appendEvent(repo, { v: 1, type: "packet", at: "2026-01-01T00:00:00.000Z", packet: packetFor(subject) }, { home });
  appendEvent(repo, { v: 1, type: "record", at: "2026-01-01T00:00:01.000Z", id, record }, { home });
  for (const event of extra) appendEvent(repo, event, { home });
  return id;
}

/**
 * A `gh` that records its arguments instead of making a network call: the status write's to `argsPath`, the pull-request
 * read's to `argsPath.read`. `FAKE_GH_PULLS` is the JSON the read returns - a page array when the case exercises
 * pagination - `FAKE_GH_READ_ERROR` makes the read fail, `FAKE_GH_ERROR` makes the write fail, and `FAKE_GH_HANG_READ` /
 * `FAKE_GH_HANG_WRITE` make that call sit there until the gate gives up on its timeout. Two knobs are the shapes a
 * killed call does not cover: `FAKE_GH_STUBBORN_READ` ignores the signal and exits 0, which `spawnSync` still reports
 * as a timeout, and `FAKE_GH_FLOOD_WRITE` prints more than the write's buffer keeps, which fills `maxBuffer` on a call
 * that also exits 0.
 */
function fakeGh(argsPath: string): string {
  const bin = temp("arev-bin-");
  const path = join(bin, "gh");
  writeFileSync(path, [
    "#!/bin/sh",
    'case "$*" in',
    "  *repos/*/pulls*)",
    `    for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(argsPath)}.read; done`,
    '    if [ -n "$FAKE_GH_HANG_READ" ]; then sleep 25; fi',
    "    if [ -n \"$FAKE_GH_STUBBORN_READ\" ]; then trap '' TERM; sleep 16; exit 0; fi",
    '    if [ -n "$FAKE_GH_READ_ERROR" ]; then printf "%s\\n" "$FAKE_GH_READ_ERROR" >&2; exit 1; fi',
    '    printf \'%s\' "${FAKE_GH_PULLS:-[]}"',
    "    exit 0 ;;",
    "esac",
    `: > ${JSON.stringify(argsPath)}`,
    `for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(argsPath)}; done`,
    'if [ -n "$FAKE_GH_HANG_WRITE" ]; then sleep 25; fi',
    'if [ -n "$FAKE_GH_FLOOD_WRITE" ]; then head -c 40000 /dev/zero | tr \'\\0\' x; exit 0; fi',
    'if [ -n "$FAKE_GH_ERROR" ]; then printf "%s\\n" "$FAKE_GH_ERROR" >&2; exit 1; fi',
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return bin;
}

function run(cwd: string, env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, [resolve(import.meta.dir, "../bin/arev.js"), ...args],
    { cwd, encoding: "utf8", env: { ...GIT_ENV, ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const events = (repo: string, home: string): LedgerEvent[] => {
  const path = ledgerPath(repo, { home });
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as LedgerEvent);
};

/**
 * The gate and post events, in file order. An evaluation the post preflight refuses is still an answer the ledger holds,
 * so it leaves one `gate` event and no `post` event; only a refusal by the decision itself leaves neither.
 */
const gating = (repo: string, home: string): LedgerEvent[] =>
  events(repo, home).filter(event => event.type === "gate" || event.type === "post");

test("the gate passes a head whose review is complete", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base };
  const id = seed({ repo, home, subject, record: recordFor(subject) });

  const result = gateReport(repo, { head, home });
  expect(result).toEqual({ head, base, mergeBase: base, record: id, verdict: "approved", ok: true, open: [] });
  // Same inputs, same answer: the gate reads the ledger and git only (AC4).
  expect(gateReport(repo, { head, home })).toEqual(result);
  // The head defaults to the repository's own HEAD.
  expect(gateReport(repo, { home })).toEqual(result);
  expect(() => gateReport(repo, { head: "abc1234", home })).toThrow("--head must be a full commit SHA");
  // A `--head` that is not hexadecimal is named by its length, never echoed: the argument is the caller's text.
  const refusal = (value: string) => {
    try {
      gateReport(repo, { head: value, home });
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };
  expect(refusal(`ghp_${"a".repeat(36)}`)).toBe("--head must be a full commit SHA (got 40 characters that are not a hexadecimal commit SHA)");
});

test("a head with no record fails, and a record for an older head never passes", () => {
  const { repo, older, base, head, home } = fixture();
  const empty = gateReport(repo, { head, home });
  expect(empty).toMatchObject({ head, ok: false, open: [`no record for head ${head}; run arev record with the report for this head`] });
  expect(empty.base).toBeUndefined();
  expect(empty.record).toBeUndefined();

  // A record for the middle commit passes there and nowhere later: the gate never reads the newest record. The remote's
  // upstream is still `older`, so the record's own merge base is the current one for that head.
  upstream(repo, older);
  const subject: Subject = { kind: "range", base: older, head: base, mergeBase: older };
  const id = seed({ repo, home, subject, record: recordFor(subject) });

  expect(gateReport(repo, { head, home })).toMatchObject({ head, ok: false, open: [`no record for head ${head}; run arev record with the report for this head`] });
  expect(gateReport(repo, { head: base, home })).toEqual({ head: base, base: older, mergeBase: older, record: id, verdict: "approved", ok: true, open: [] });
});

test("an open blocking finding fails the gate by name until a disposition settles it", () => {
  const { repo, base, head } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base };
  const gated = (...extra: LedgerEvent[]) => {
    const home = temp("arev-hub-");
    seed({ repo, home, subject, record: recordFor(subject, { findings: [blocking()], verdict: "changes_requested" }), extra });
    return gateReport(repo, { head, home });
  };
  const resolve = (as: "fixed" | "false_positive" | "accepted", more: Partial<Extract<LedgerEvent, { type: "resolve" }>> = {}): LedgerEvent =>
    ({ v: 1, type: "resolve", at: "2026-01-02T00:00:00.000Z", head, finding: "bugs:open-one", as, ...more });

  const open = gated();
  expect(open.ok).toBe(false);
  expect(open.open).toEqual(["blocking findings are open: bugs:open-one"]);

  expect(gated(resolve("fixed", { evidence: ["src/a.ts:3"] })).open).toEqual([]);
  expect(gated(resolve("fixed", { evidence: ["src/a.ts:3"] })).ok).toBe(true);
  expect(gated(resolve("false_positive", { evidence: ["bun test test/findings.test.ts"] })).ok).toBe(true);
  expect(gated(resolve("accepted", { rationale: "the person accepted the risk" })).ok).toBe(true);
  // Round 10's scope: with no PR named, a resolve counts at its own exact head, so one written at an unrelated head
  // settles nothing here: a resolve is not a statement about reviews it never named.
  const elsewhere = gated({ ...resolve("fixed"), head: "f".repeat(40) } as LedgerEvent);
  expect(elsewhere.open).toEqual(["blocking findings are open: bugs:open-one"]);
  // Inside one PR thread the resolve counts wherever the branch moved, which is what `resolve` writes on the event.
  const threaded: Subject = { ...subject, pr: 7 };
  const gatedThread = (...extra: LedgerEvent[]) => {
    const home = temp("arev-hub-");
    seed({ repo, home, subject: threaded, record: recordFor(threaded, { findings: [blocking()], verdict: "changes_requested" }), extra });
    return gateReport(repo, { head, home });
  };
  expect(gatedThread().open).toEqual(["blocking findings are open: bugs:open-one"]);
  expect(gatedThread({ ...resolve("fixed"), head: "f".repeat(40), pr: 7 } as LedgerEvent).open).toEqual([]);
});

test("a self-review needs both the fallback and [gate] same_family = allow; a declared fallback needs allow", () => {
  const denying = fixture();
  const allowing = fixture('# Review\n[gate]\nsame_family = "allow"\n');
  const at = (repo: string, base: string, head: string) => ({ kind: "range" as const, base, head, mergeBase: base });
  const gated = (repo: string, base: string, head: string, reviewer: Record<string, unknown>) => {
    const home = temp("arev-hub-"), subject: Subject = at(repo, base, head);
    seed({ repo, home, subject, record: recordFor(subject, { reviewer }) });
    return gateReport(repo, { head, home });
  };
  const selfReview = { id: "codex", modelFamily: "openai", started: "self", implementer: "codex", sameFamilyFallback: true };
  const fallback = { id: "claude", modelFamily: "anthropic", started: "self", implementer: "codex", sameFamilyFallback: true };

  const bare = gated(denying.repo, denying.base, denying.head, { id: "codex", modelFamily: "openai", started: "self", implementer: "codex", sameFamilyFallback: false });
  expect(bare.ok).toBe(false);
  expect(bare.open).toEqual(['the reviewer codex is the implementer; a self-review passes only with sameFamilyFallback and [gate] same_family = "allow"']);

  const denied = gated(denying.repo, denying.base, denying.head, selfReview);
  expect(denied.ok).toBe(false);
  // A self-review's one message names the whole requirement, fallback included.
  expect(denied.open).toEqual(['the reviewer codex is the implementer; a self-review passes only with sameFamilyFallback and [gate] same_family = "allow"']);

  expect(gated(allowing.repo, allowing.base, allowing.head, selfReview).ok).toBe(true);

  const declared = gated(denying.repo, denying.base, denying.head, fallback);
  expect(declared.open).toEqual(['the reviewer claude declares a same-family fallback and REVIEW.md does not set [gate] same_family = "allow"']);
  expect(gated(allowing.repo, allowing.base, allowing.head, fallback).ok).toBe(true);
});

test("a failed reviewer call fails the gate", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base };
  seed({ repo, home, subject, record: recordFor(subject, {
    findings: [blocking({ disposition: "fixed", evidence: ["src/a.ts:3"] })],
    call: { ok: false, error: "the reviewer call timed out" },
  }) });
  const result = gateReport(repo, { head, home });
  expect(result.ok).toBe(false);
  expect(result.open).toEqual(["the reviewer call failed: the reviewer call timed out"]);
});

test("a head two PRs share refuses without --pr, and each PR gates on its own record", () => {
  const { repo, base, head, home } = fixture();
  const seven: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  const eight: Subject = { kind: "range", base, head, mergeBase: base, pr: 8 };
  const sevenId = seed({ repo, home, subject: seven, record: recordFor(seven) });
  const eightId = seed({ repo, home, subject: eight, record: recordFor(eight, {
    findings: [blocking({ id: "bugs:eight-only" })], verdict: "changes_requested",
  }) });

  // One commit reviewed by two PRs: the newest record at the head is whichever was written last, so a gate that read it
  // would pass PR 7 on PR 8's changes_requested or fail PR 8 on PR 7's approval. The gate refuses instead.
  const outcome = (pr?: number): { message: string; next: string } | string => {
    try {
      gateReport(repo, { head, home, ...(pr === undefined ? {} : { pr }) });
      return "passed";
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { message: error.message, next: error.next };
    }
  };
  expect(outcome()).toEqual({
    message: `head ${head} is reviewed in more than one thread (PR 7, PR 8), so arev cannot tell which review you mean`,
    next: "pass --pr 7 or --pr 8 to choose the review thread",
  });
  // A --pr the head knows nothing about is refused too, rather than answered with an empty review of it.
  expect(outcome(9)).toEqual({
    message: `no packet or record at head ${head} belongs to PR 9`,
    next: "pass --pr 7 or --pr 8 for this head",
  });

  // With the thread named, each PR reads only its own record, verdict and open findings.
  expect(gateReport(repo, { head, home, pr: 7 })).toMatchObject({ head, ok: true, record: sevenId, verdict: "approved", open: [] });
  expect(gateReport(repo, { head, home, pr: 8 })).toMatchObject({
    head, ok: false, record: eightId, verdict: "changes_requested", open: ["blocking findings are open: bugs:eight-only"],
  });

  // Fail closed through the command too: never a status for a head the gate did not judge.
  const refusedArgs = join(home, "gh-args.txt");
  const refused = run(repo, { PATH: `${fakeGh(refusedArgs)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home }, "gate", "--head", head, "--post");
  expect(refused.code).toBe(1);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("is reviewed in more than one thread (PR 7, PR 8)");
  expect(refused.stderr).toContain("→ pass --pr 7 or --pr 8 to choose the review thread");
  // With a `gh` on PATH that records every call, the stub proves none was made, so the case stays offline even if the
  // guard stops refusing.
  expect(existsSync(refusedArgs)).toBe(false);
  expect(existsSync(`${refusedArgs}.read`)).toBe(false);
  // This refusal is the decision's own, before any evaluation exists to record, so there is no gate event either.
  expect(gating(repo, home)).toEqual([]);

  // The flag reaches the decision through the command, and names the record it settled on.
  const threadedRun = run(repo, { AGENTHUB_HOME: home }, "gate", "--head", head, "--pr", "7");
  expect(threadedRun.code).toBe(0);
  expect(threadedRun.stdout).toContain(`record ${sevenId}`);

  const badPr = run(repo, { AGENTHUB_HOME: home }, "gate", "--pr", "seven");
  expect(badPr.code).toBe(2);
  expect(badPr.stderr).toContain("Invalid PR number. Pass a positive integer to --pr, or none for a review with no PR.");
});

test("a review with no PR is a thread of its own, named --pr none", () => {
  const { repo, base, head, home } = fixture();
  const plain: Subject = { kind: "range", base, head, mergeBase: base };
  const seven: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  const plainId = seed({ repo, home, subject: plain, record: recordFor(plain) });
  const sevenId = seed({ repo, home, subject: seven, record: recordFor(seven, {
    findings: [blocking({ id: "bugs:seven-only" })], verdict: "changes_requested",
  }) });

  // The two threads share the SHA, so the default read refuses, spelling the no-PR thread the way the view does.
  const outcome = (): { message: string; next: string } | string => {
    try {
      gateReport(repo, { head, home });
      return "passed";
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { message: error.message, next: error.next };
    }
  };
  expect(outcome()).toEqual({
    message: `head ${head} is reviewed in more than one thread (no PR, PR 7), so arev cannot tell which review you mean`,
    next: "pass --pr none or --pr 7 to choose the review thread",
  });

  // Each named thread reads only its own record: the no-PR review is its own head's, never PR 7's at the same SHA.
  expect(gateReport(repo, { head, home, pr: "none" })).toMatchObject({ head, ok: true, record: plainId, verdict: "approved", open: [] });
  expect(gateReport(repo, { head, home, pr: 7 })).toMatchObject({
    head, ok: false, record: sevenId, verdict: "changes_requested", open: ["blocking findings are open: bugs:seven-only"],
  });

  // The spelling the refusal printed is one the command accepts, so its next step is a command that runs.
  const named = run(repo, { AGENTHUB_HOME: home }, "gate", "--pr", "none");
  expect(named.code).toBe(0);
  expect(named.stdout).toContain(`record ${plainId}`);
  expect(named.stdout).toContain("gate: passes");
});

test("--post refuses a head more than one thread reviewed, because a commit status is per commit", () => {
  const { repo, base, head, home } = fixture();
  const seven: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  const eight: Subject = { kind: "range", base, head, mergeBase: base, pr: 8 };
  const sevenId = seed({ repo, home, subject: seven, record: recordFor(seven) });
  seed({ repo, home, subject: eight, record: recordFor(eight, {
    findings: [blocking({ id: "bugs:eight-only" })], verdict: "changes_requested",
  }) });

  // PR 7's gate passes, and that is the trap: a status lives on the commit, so posting PR 7's success would satisfy a
  // required check on PR 8, whose own review at this head was changes_requested. The post refuses before any GitHub call.
  const args = join(home, "gh-args.txt");
  const refused = run(repo, { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home }, "gate", "--pr", "7", "--post");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(`head ${head} has packets or records in more than one thread (PR 7, PR 8), and a commit status is per commit, so a status posted for one PR shows on the others`);
  expect(refused.stderr).toContain("→ push a distinct commit for each PR and post the gate from that PR's own head");
  // `gh` is never spawned. The evaluation is recorded before the preflight that refused the write, and the write it
  // refused is not.
  expect(existsSync(args)).toBe(false);
  const recorded = gating(repo, home);
  expect(recorded.map(event => event.type)).toEqual(["gate"]);
  expect(recorded[0]).toMatchObject({ head, ok: true, record: sevenId });

  // The question without --post is unchanged: the named thread gates on its own record and says which one.
  const answered = run(repo, { AGENTHUB_HOME: home }, "gate", "--pr", "7");
  expect(answered.code).toBe(0);
  expect(answered.stdout).toContain(`record ${sevenId}`);
  expect(answered.stdout).toContain("gate: passes");
});

test("--post refuses a shared head even when the other thread has only built its packet", () => {
  const { repo, base, head, home } = fixture();
  const seven: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  const eight: Subject = { kind: "range", base, head, mergeBase: base, pr: 8 };
  seed({ repo, home, subject: seven, record: recordFor(seven) });
  // PR 8 built its packet for this head and has not recorded a review yet: its checks still live on this commit, so a
  // success posted from PR 7 would satisfy them. The set is "a packet or a record", never a record alone.
  appendEvent(repo, { v: 1, type: "packet", at: "2026-01-01T00:00:02.000Z", packet: packetFor(eight) }, { home });

  const args = join(home, "gh-args.txt");
  const refused = run(repo, { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home }, "gate", "--pr", "7", "--post");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(`head ${head} has packets or records in more than one thread (PR 7, PR 8)`);
  expect(existsSync(args)).toBe(false);
  // The packet-only thread refused the write after the evaluation, so the gate event stands and no post follows it.
  const recorded = gating(repo, home);
  expect(recorded.map(event => event.type)).toEqual(["gate"]);
  expect(recorded[0]).toMatchObject({ head, ok: true });
});

test("--post refuses a head an open PR heads where the ledger knows only one thread", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  seed({ repo, home, subject, record: recordFor(subject) });

  // PR 8 heads the same commit and arev never built a packet for it, so the ledger cannot see it: only GitHub can. The
  // closed PR and the open PR with another head are not threads this status can leak onto.
  const args = join(home, "gh-args.txt");
  const pulls = JSON.stringify([
    { number: 7, state: "open", head: { sha: head }, base: { sha: base } },
    { number: 8, state: "open", head: { sha: head } },
    { number: 6, state: "closed", head: { sha: head } },
    { number: 5, state: "open", head: { sha: "a".repeat(40) } },
  ]);
  const refused = run(repo, { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, FAKE_GH_PULLS: pulls }, "gate", "--pr", "7", "--post");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(`head ${head} heads open PR 8 besides PR 7, and a commit status is per commit: a success posted here would satisfy their checks, though the gate did not pass for that PR`);
  expect(refused.stderr).toContain("→ push a distinct commit for each PR and post the gate from that PR's own head");
  // The metadata read happened; the status write never did. The evaluation is in the ledger, the post it refused is not.
  expect(readFileSync(`${args}.read`, "utf8")).toContain(`repos/owner/repo/commits/${head}/pulls`);
  expect(existsSync(args)).toBe(false);
  const recorded = gating(repo, home);
  expect(recorded.map(event => event.type)).toEqual(["gate"]);
  expect(recorded[0]).toMatchObject({ head, ok: true });

  // The same head with only its own PR open posts, so the guard is the other PR and not the read itself.
  const only = run(repo, { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, FAKE_GH_PULLS: JSON.stringify([{ number: 7, state: "open", head: { sha: head }, base: { sha: base } }]) }, "gate", "--pr", "7", "--post");
  expect(only.stderr).toBe("");
  expect(only.code).toBe(0);

  // A review that names no PR thread is not that pull request's pass either, so it cannot turn it green.
  const plain = fixture();
  const unthreaded: Subject = { kind: "range", base: plain.base, head: plain.head, mergeBase: plain.base };
  seed({ repo: plain.repo, home: plain.home, subject: unthreaded, record: recordFor(unthreaded) });
  const plainArgs = join(plain.home, "gh-args.txt");
  const unowned = run(plain.repo,
    { PATH: `${fakeGh(plainArgs)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: plain.home, FAKE_GH_PULLS: JSON.stringify([{ number: 8, state: "open", head: { sha: plain.head } }]) },
    "gate", "--post");
  expect(unowned.code).toBe(1);
  expect(unowned.stderr).toContain("and this review names no PR thread");
  expect(existsSync(plainArgs)).toBe(false);
});

test("a status goes to the repository origin names, and a non-GitHub origin refuses the post", () => {
  const { repo, base, head, home } = fixture();
  gitOut(repo, ["remote", "set-url", "origin", "https://gitlab.com/owner/repo.git"]);
  const subject: Subject = { kind: "range", base, head, mergeBase: base };
  // The ledger the gate reads is keyed by origin, so the record is seeded under the origin this case gates from.
  seed({ repo, home, subject, record: recordFor(subject) });
  const args = join(home, "gh-args.txt");
  const refused = run(repo, { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, GH_REPO: "owner/repo" }, "gate", "--post");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("a status is posted to the GitHub repository origin names, and this repository's origin does not name one");
  expect(refused.stderr).toContain("→ set origin to the GitHub repository URL (gh repo view --json url prints it)");
  // Even with gh able to resolve a repository for itself, neither call is made.
  expect(existsSync(args)).toBe(false);
  expect(existsSync(`${args}.read`)).toBe(false);
  // The evaluation happened; only the write it was refused after is missing.
  expect(gating(repo, home).map(event => event.type)).toEqual(["gate"]);
});

test("both gh calls name github.com, so GH_HOST cannot redirect the read or the status", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  const id = seed({ repo, home, subject, record: recordFor(subject) });
  const args = join(home, "gh-args.txt");
  const pulls = JSON.stringify([{ number: 7, state: "open", head: { sha: head }, base: { sha: base } }]);

  const posted = run(repo,
    { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, GH_HOST: "elsewhere.example", FAKE_GH_PULLS: pulls },
    "gate", "--post");
  expect(posted.stderr).toBe("");
  expect(posted.code).toBe(0);

  // The environment names another host for gh, and neither call is sent there: the read and the write each pin the host.
  const argv = (path: string): string[] => readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  expect(argv(`${args}.read`))
    .toEqual(["api", "--hostname", "github.com", "--paginate", "--slurp", `repos/owner/repo/commits/${head}/pulls`]);
  expect(argv(args).slice(0, 3)).toEqual(["api", "--hostname", "github.com"]);
  expect(argv(args)).toContain(`repos/owner/repo/statuses/${head}`);
  expect(argv(args)).toContain(`description=arev/gate: record ${id}`);
});

test("--post reads every page of the pulls reply, so an open PR on page 2 still refuses", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  seed({ repo, home, subject, record: recordFor(subject) });
  const args = join(home, "gh-args.txt");
  // `gh api --paginate --slurp` prints one array per page: PR 8 heads this commit on the second one.
  const pages = JSON.stringify([
    [{ number: 7, state: "open", head: { sha: head }, base: { sha: base } }],
    [{ number: 8, state: "open", head: { sha: head }, base: { sha: base } }],
  ]);
  const refused = run(repo,
    { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, FAKE_GH_PULLS: pages }, "gate", "--pr", "7", "--post");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(`head ${head} heads open PR 8 besides PR 7, and a commit status is per commit`);
  // The status write never happened; the evaluation that preceded it is in the ledger, the post is not.
  expect(existsSync(args)).toBe(false);
  expect(gating(repo, home).map(event => event.type)).toEqual(["gate"]);
});

test("--post re-checks the review's merge base against the PR's own base, so a retargeted PR is never posted", () => {
  const { repo, older, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  seed({ repo, home, subject, record: recordFor(subject) });
  const args = join(home, "gh-args.txt");
  const posted = (baseSha: string) => run(repo,
    { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, FAKE_GH_PULLS: JSON.stringify([{ number: 7, state: "open", head: { sha: head }, base: { sha: baseSha } }]) },
    "gate", "--pr", "7", "--post");

  // The PR now merges into `older`, whose merge base with this head is `older`, not the `base` the record was made
  // against: the record reviewed a different change than the one this PR would land.
  const retargeted = posted(older);
  expect(retargeted.code).toBe(1);
  expect(retargeted.stderr).toContain(`PR 7 now merges into a base whose merge base is ${older}, and the record was made against ${base}, so the review is of a different change`);
  expect(retargeted.stderr).toContain(`→ re-review the PR as it now merges with arev packet --pr 7 and post from the new head - the PR's merge base must equal the reviewed one`);
  // No status is posted for the different change.
  expect(existsSync(args)).toBe(false);

  // A base this checkout does not hold is refused with the step that fetches it, never a fetch of arev's own.
  const absent = "9".repeat(40);
  const unfetched = posted(absent);
  expect(unfetched.code).toBe(1);
  expect(unfetched.stderr).toContain(`the base commit ${absent} of PR 7 is not in this checkout`);
  expect(unfetched.stderr).toContain("→ fetch it (git fetch origin) and post again");
  expect(existsSync(args)).toBe(false);

  // The reply's value is data that `rev-parse` and `merge-base` take as an argument, so only a full commit SHA is
  // passed on: an option-shaped value never reaches git, and neither does a prefix git would happily resolve.
  const injected = posted("--upload-pack=touch /tmp/pwned");
  expect(injected.code).toBe(1);
  expect(injected.stderr).toContain("GitHub reports a base commit for PR 7 that is not a full commit SHA");
  expect(injected.stderr).toContain("→ re-review against the PR's current base with arev packet --pr 7");
  expect(injected.stderr).not.toContain("upload-pack");
  expect(existsSync(args)).toBe(false);
  const abbreviated = posted(base.slice(0, 12));
  expect(abbreviated.code).toBe(1);
  expect(abbreviated.stderr).toContain("GitHub reports a base commit for PR 7 that is not a full commit SHA");
  expect(existsSync(args)).toBe(false);

  // And a PR whose reply names no base commit cannot be checked against the record's base at all.
  const unbased = run(repo,
    { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, FAKE_GH_PULLS: JSON.stringify([{ number: 7, state: "open", head: { sha: head } }]) },
    "gate", "--pr", "7", "--post");
  expect(unbased.code).toBe(1);
  expect(unbased.stderr).toContain("GitHub reports no base commit for PR 7");
  expect(existsSync(args)).toBe(false);

  // The reviewed base is the PR's own base once: the check passes and the status is written.
  const unchanged = posted(base);
  expect(unchanged.stderr).toBe("");
  expect(unchanged.code).toBe(0);
  expect(existsSync(args)).toBe(true);
});

test("a record that names no implementer fails the gate, because independence cannot be checked", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base };
  seed({ repo, home, subject, record: recordFor(subject, {
    reviewer: { id: "claude", modelFamily: "anthropic", started: "self", sameFamilyFallback: false },
  }) });
  const result = gateReport(repo, { head, home });
  expect(result.ok).toBe(false);
  // The absence is not a pass: a reviewer whose implementer is unknown cannot be shown to be someone else.
  expect(result.open).toEqual(["the record names no implementer, so independence cannot be checked; run arev record <report> --implementer <peer>"]);
});

test("REVIEW.md must be at the merge base unless the record says --light", () => {
  const { repo, base, head } = fixture(null);
  const subject: Subject = { kind: "range", base, head, mergeBase: base };
  // Each home holds one record, because the gate reads the newest record for the head.
  const gated = (light: boolean) => {
    const home = temp("arev-hub-");
    const id = seed({ repo, home, subject, record: recordFor(subject, {}, { light }) });
    return { id, ...gateReport(repo, { head, home }) };
  };

  const strict = gated(false);
  expect(strict.ok).toBe(false);
  expect(strict.open).toEqual([`REVIEW.md is not at the merge base ${base}; record the review with --light only when it was made without one`]);

  // The flag lives on the record (spec #1, Decisions 2026-11-26): the reviewer states it there, and the gate reads it.
  const light = gated(true);
  expect(light).toMatchObject({ head, base, ok: true, open: [] });
  expect(light.record).toBe(light.id);
});

test("a record made against an old merge base fails and names both bases", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base };
  seed({ repo, home, subject, record: recordFor(subject) });
  expect(gateReport(repo, { head, home }).ok).toBe(true);

  // The branch now merges into `head` itself, so the record's base is no longer the current one: AC4 gates the base too.
  upstream(repo, head);
  const moved = gateReport(repo, { head, home });
  expect(moved.ok).toBe(false);
  expect(moved.open).toEqual([`record made against merge base ${base}; current merge base is ${head}; rerun arev packet`]);
  // The record's own base is still reported, beside the one the gate checked against.
  expect(moved).toMatchObject({ base, mergeBase: head });
});

test("a workspace or commit record fails even at the current merge base", () => {
  const { repo, head } = fixture();
  // The branch has moved and its own head is upstream, so the base condition is satisfied and only the kind is wrong.
  upstream(repo, head);
  const at = (kind: string): Subject => ({ kind, base: head, head, mergeBase: head });
  const gated = (kind: string) => {
    const home = temp("arev-hub-");
    const subject = at(kind);
    seed({ repo, home, subject, record: recordFor(subject) });
    return gateReport(repo, { head, home });
  };

  // A workspace record reviewed uncommitted changes, and a commit record reviewed one commit: neither reviewed the branch.
  expect(gated("workspace").open).toEqual(["record subject is workspace; record a range or PR review"]);
  expect(gated("workspace").ok).toBe(false);
  expect(gated("commit").open).toEqual(["record subject is commit; record a range or PR review"]);
});

test("every evaluation appends a gate event, and two runs agree", () => {
  const { repo, older, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base };
  const id = seed({ repo, home, subject, record: recordFor(subject) });

  const first = run(repo, { AGENTHUB_HOME: home }, "gate", "--json");
  const second = run(repo, { AGENTHUB_HOME: home }, "gate", "--json");
  expect(first.code).toBe(0);
  expect(second.code).toBe(0);
  // The same ledger and git state give the same answer, and writing the gate event does not change the next one.
  expect(second.stdout).toBe(first.stdout);
  expect(JSON.parse(first.stdout)).toMatchObject({ head, ok: true, record: id });

  const failed = run(repo, { AGENTHUB_HOME: home }, "gate", "--json", "--head", older);
  expect(failed.code).toBe(1);

  const gates = events(repo, home).filter((event): event is Extract<LedgerEvent, { type: "gate" }> => event.type === "gate");
  expect(gates).toHaveLength(3);
  expect(gates.slice(0, 2).map(({ head: at, base: from, ok, record, open }) => ({ at, from, ok, record, open })))
    .toEqual([{ at: head, from: base, ok: true, record: id, open: undefined }, { at: head, from: base, ok: true, record: id, open: undefined }]);
  expect(gates[2]).toMatchObject({ head: older, ok: false, open: [`no record for head ${older}; run arev record with the report for this head`] });
});

test("the gate takes no --light flag, and a bad [gate] setting refuses by name", () => {
  const { repo, base, head, home } = fixture(null);
  const subject: Subject = { kind: "range", base, head, mergeBase: base };
  seed({ repo, home, subject, record: recordFor(subject, {}, { light: true }) });

  // The light record passes with no flag anywhere on the command line; the flag is not accepted at all.
  expect(run(repo, { AGENTHUB_HOME: home }, "gate", "--head", head).code).toBe(0);
  const flag = run(repo, { AGENTHUB_HOME: home }, "gate", "--light");
  expect(flag.code).toBe(2);
  expect(flag.stderr).toContain("gate takes --head <sha>, --pr <n|none>, --post and --json");

  // A key arev does not read is refused from REVIEW.md itself, through the one parser both commands use.
  const typo = fixture('# Review\n[gate] same_famly = "allow"\n');
  const typoSubject: Subject = { kind: "range", base: typo.base, head: typo.head, mergeBase: typo.base };
  const typoHome = temp("arev-hub-");
  seed({ repo: typo.repo, home: typoHome, subject: typoSubject, record: recordFor(typoSubject) });
  expect(() => gateReport(typo.repo, { head: typo.head, home: typoHome })).toThrow("REVIEW.md sets [gate] same_famly, which arev does not read");
});

test("gate --post sets the arev/gate status on the full head and writes the post event", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base };
  const id = seed({ repo, home, subject, record: recordFor(subject) });
  const args = join(home, "gh-args.txt");

  const posted = run(repo, { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, GH_REPO: "someone/elsewhere" }, "gate", "--post", "--json");
  expect(posted.stderr).toBe("");
  expect(posted.code).toBe(0);
  expect(JSON.parse(posted.stdout)).toMatchObject({ head, ok: true, record: id });

  // The pull requests at this head were read first, from the same repository the status goes to.
  expect(readFileSync(`${args}.read`, "utf8")).toContain(`repos/owner/repo/commits/${head}/pulls`);
  const argv = readFileSync(args, "utf8").trim().split("\n");
  expect(argv.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "--method", "POST"]);
  // The target comes from origin, not from gh: `GH_REPO` names another repository in this environment, and the status
  // still goes to the repository the ledger and the review are keyed to.
  expect(argv[5]).toBe(`repos/owner/repo/statuses/${head}`);
  expect(argv).toContain("state=success");
  expect(argv).toContain("context=arev/gate");
  expect(argv).toContain(`description=arev/gate: record ${id}`);

  const posted_ = events(repo, home).at(-1);
  expect(posted_).toMatchObject({ type: "post", head, record: id, status: "success" });

  const shown = run(repo, { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home }, "gate", "--post");
  expect(shown.stderr).toBe("");
  expect(shown.code).toBe(0);
  expect(shown.stdout).toContain(`posted arev/gate success on ${head} for record ${id}`);
});

test("a gate that fails posts nothing, and a failed write is not recorded as posted", () => {
  const failing = fixture();
  const emptyArgs = join(failing.home, "gh-args.txt");
  const env = (args: string, more: Record<string, string> = {}) =>
    ({ PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: failing.home, ...more });

  const nothing = run(failing.repo, env(emptyArgs), "gate", "--post", "--head", failing.head);
  expect(nothing.code).toBe(1);
  expect(nothing.stdout).toContain("gate: fails at");
  expect(existsSync(emptyArgs)).toBe(false);
  expect(events(failing.repo, failing.home).some(event => event.type === "post")).toBe(false);

  // A record that exists and still fails: the case a post-on-pass guard that only checked for a record would miss.
  const subject: Subject = { kind: "range", base: failing.base, head: failing.head, mergeBase: failing.base };
  seed({ repo: failing.repo, home: failing.home, subject, record: recordFor(subject, { findings: [blocking()], verdict: "changes_requested" }) });
  const openArgs = join(failing.home, "gh-open.txt");
  const open = run(failing.repo, env(openArgs), "gate", "--post", "--head", failing.head);
  expect(open.code).toBe(1);
  expect(open.stdout).toContain("blocking findings are open: bugs:open-one");
  expect(existsSync(openArgs)).toBe(false);
  expect(events(failing.repo, failing.home).some(event => event.type === "post")).toBe(false);

  const passing = fixture();
  const passingSubject: Subject = { kind: "range", base: passing.base, head: passing.head, mergeBase: passing.base };
  const id = seed({ repo: passing.repo, home: passing.home, subject: passingSubject, record: recordFor(passingSubject) });
  const args = join(passing.home, "gh-args.txt");
  const refused = run(passing.repo,
    { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: passing.home, FAKE_GH_ERROR: "HTTP 403: Resource not accessible by integration" },
    "gate", "--post");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(`cannot post the arev/gate status on ${passing.head}`);
  expect(refused.stderr).toContain("HTTP 403: Resource not accessible by integration");
  expect(refused.stderr).toContain("gh is authenticated");
  expect(events(passing.repo, passing.home).some(event => event.type === "post" && event.record === id)).toBe(false);
});

test("a secret-shaped gh diagnostic is withheld from both refusals and from the ledger", () => {
  // gh's stderr is data read from outside arev, so it is screened like a path or a report field: a token-shaped line
  // leaves `<withheld>` where the detail was. The plain 403 above is the other half of that pair, still echoed.
  const token = `ghp_${"A".repeat(36)}`;
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  seed({ repo, home, subject, record: recordFor(subject) });
  const args = join(home, "gh-args.txt");
  const env = (more: Record<string, string>) => ({ PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, ...more });
  // The whole ledger, not just the events a reader parses: no line of it may carry the token.
  const ledgerText = () => readFileSync(ledgerPath(repo, { home }), "utf8");

  // The read of the open pull requests fails with the token on stderr.
  const read = run(repo, env({ FAKE_GH_READ_ERROR: `HTTP 401: bad credentials (${token})` }), "gate", "--pr", "7", "--post");
  expect(read.code).toBe(1);
  expect(read.stderr).toContain(`cannot read the open pull requests at ${head}: <withheld>`);
  expect(read.stderr).not.toContain(token);
  expect(ledgerText()).not.toContain(token);
  // The evaluation that ran before the preflight is in the ledger; the status write is not.
  expect(gating(repo, home).map(event => event.type)).toEqual(["gate"]);

  // The status write fails with the token on stderr, after the read succeeded and listed only this PR.
  const write = run(repo,
    { ...env({ FAKE_GH_ERROR: `HTTP 403: Resource not accessible by integration (${token})` }),
      FAKE_GH_PULLS: JSON.stringify([{ number: 7, state: "open", head: { sha: head }, base: { sha: base } }]) },
    "gate", "--pr", "7", "--post");
  expect(write.code).toBe(1);
  expect(write.stderr).toContain(`cannot post the arev/gate status on ${head}: <withheld>`);
  expect(write.stderr).not.toContain(token);
  expect(ledgerText()).not.toContain(token);
  expect(gating(repo, home).map(event => event.type)).toEqual(["gate", "gate"]);
});

test("a gh read that runs out of time is refused on its bound, with the retry, and posts nothing", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  seed({ repo, home, subject, record: recordFor(subject) });
  const args = join(home, "gh-args.txt");
  // The stub sits there until the gate's own 15 s bound kills it, which is the case a status check in a hook meets on a
  // network that never answers: the gate gives up and says so, rather than leaving the hook waiting.
  const read = run(repo, { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, FAKE_GH_HANG_READ: "1" }, "gate", "--pr", "7", "--post");
  expect(read.code).toBe(1);
  expect(read.stderr).toContain(`cannot read the open pull requests at ${head}: gh did not answer within 15 s`);
  // The retry names the head this run gated and the thread it was asked about, so it gates the same subject rather than
  // whatever HEAD points at when someone runs it.
  expect(read.stderr).toContain(`→ retry arev gate --post --head ${head} --pr 7 once github.com is reachable from this machine`);
  // Nothing about a killed call is invented: the evaluation is in the ledger, the status write never happened.
  expect(gating(repo, home).map(event => event.type)).toEqual(["gate"]);
}, 25_000);

test("a status write that runs out of time is refused on the same bound, after a read that succeeded", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  seed({ repo, home, subject, record: recordFor(subject) });
  const args = join(home, "gh-args.txt");
  const write = run(repo,
    { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, FAKE_GH_HANG_WRITE: "1",
      FAKE_GH_PULLS: JSON.stringify([{ number: 7, state: "open", head: { sha: head }, base: { sha: base } }]) },
    "gate", "--post");
  expect(write.code).toBe(1);
  expect(write.stderr).toContain(`cannot post the arev/gate status on ${head}: gh did not answer within 15 s`);
  // Run without `--pr`, so the retry names the head alone: the flag is added when it was given, never invented.
  expect(write.stderr).toContain(`→ retry arev gate --post --head ${head} once github.com is reachable from this machine`);
  expect(gating(repo, home).map(event => event.type)).toEqual(["gate"]);
}, 25_000);

test("a gh call that ignores the signal it was sent is still a refused call, not an empty answer", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  seed({ repo, home, subject, record: recordFor(subject) });
  const args = join(home, "gh-args.txt");
  // A child that ignores the signal exits 0 on its own, and `spawnSync` reports the timeout in `error` beside that
  // status. Read by status alone, this call would look like a successful read of an empty list - the gate would then
  // post on a list it never got. Measured on Bun 1.4.4 with this stub: status 0, signal null, error.code ETIMEDOUT,
  // after the child's own 16 s rather than the gate's 15 - the bound fires, the exit comes later, and only the error
  // says so.
  const read = run(repo,
    { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, FAKE_GH_STUBBORN_READ: "1" },
    "gate", "--pr", "7", "--post");
  expect(read.code).toBe(1);
  expect(read.stderr).toContain(`cannot read the open pull requests at ${head}: gh did not answer within 15 s`);
  expect(read.stderr).toContain(`→ retry arev gate --post --head ${head} --pr 7 once github.com is reachable from this machine`);
  expect(gating(repo, home).map(event => event.type)).toEqual(["gate"]);
}, 25_000);

test("a gh reply over the buffer is refused by its size, and the next step is not the retry", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  seed({ repo, home, subject, record: recordFor(subject) });
  const args = join(home, "gh-args.txt");
  // A reply that fills `maxBuffer` also exits 0 (measured on Bun 1.4.4: status 0, error.code ENOBUFS, stdout a prefix),
  // so the same status-first read would hand the truncated text on as an answer. The cause is size, not the network: a
  // retry returns the same reply, which is why the next step here is a repair and the detail names the bytes.
  const write = run(repo,
    { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, FAKE_GH_FLOOD_WRITE: "1",
      FAKE_GH_PULLS: JSON.stringify([{ number: 7, state: "open", head: { sha: head }, base: { sha: base } }]) },
    "gate", "--post");
  expect(write.code).toBe(1);
  expect(write.stderr).toContain(`cannot post the arev/gate status on ${head}: gh printed more than the 32000 bytes this call keeps`);
  expect(write.stderr).toContain("does not get smaller");
  expect(write.stderr).not.toContain("retry arev gate");
  expect(gating(repo, home).map(event => event.type)).toEqual(["gate"]);
});

test("a pulls reply larger than a metadata read's bound is read, not refused by size", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  const id = seed({ repo, home, subject, record: recordFor(subject) });
  const args = join(home, "gh-args.txt");
  // The endpoint returns whole pull request objects, bodies included: one real open pull request measured 19,779 bytes
  // for a 3,574-byte body, so a metadata-sized bound refuses an ordinary list. This reply is over 32 KB and has to be
  // read - the gate passes and posts, rather than failing on the size of a reply it did not need in full.
  const pulls = JSON.stringify([{ number: 7, state: "open", head: { sha: head }, base: { sha: base }, body: "b".repeat(44_000) }]);
  expect(pulls.length).toBeGreaterThan(32_000);
  const posted = run(repo, { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, FAKE_GH_PULLS: pulls }, "gate", "--post");
  expect(posted.stderr).toBe("");
  expect(posted.code).toBe(0);
  expect(posted.stdout).toContain(`posted arev/gate success on ${head} for record ${id}`);
  expect(gating(repo, home).map(event => event.type)).toEqual(["gate", "post"]);
});

test("a diagnostic carrying URL userinfo is withheld, and the pattern does not swallow an ordinary URL", () => {
  const { repo, base, head, home } = fixture();
  const subject: Subject = { kind: "range", base, head, mergeBase: base, pr: 7 };
  seed({ repo, home, subject, record: recordFor(subject) });
  const args = join(home, "gh-args.txt");
  // A remote or a diagnostic can carry the credential in the URL rather than in a token-shaped value, which is the shape
  // no earlier pattern caught.
  const credential = "https://oauth2:ghs-Sup3rS3cretValue@github.com/owner/repo";
  const refused = run(repo,
    { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home, FAKE_GH_READ_ERROR: `HTTP 401: bad credentials for ${credential}` },
    "gate", "--pr", "7", "--post");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(`cannot read the open pull requests at ${head}: <withheld>`);
  expect(refused.stderr).not.toContain("Sup3rS3cretValue");

  // The colon before the `@` is what makes a URL a credential: a scheme with a user but no password is not one, and
  // neither is a host:port, so an ssh remote and an ordinary https URL keep passing through the screen.
  expect(secretShaped(credential)).toBe(true);
  expect(secretShaped("ssh://git@github.com/owner/repo")).toBe(false);
  expect(secretShaped("git@github.com:owner/repo")).toBe(false);
  expect(secretShaped("https://github.com:443/owner/repo")).toBe(false);
  expect(secretShaped("https://github.com/owner/repo")).toBe(false);
  // The two edges the first pattern missed, each pinned against the look-alike that must keep passing: an empty user
  // name is still a password in the authority, and an `@` in the query after a port is the query's, not userinfo.
  expect(secretShaped("https://:ghs-Sup3rS3cretValue@github.com/owner/repo")).toBe(true);
  expect(secretShaped("https://example.org:443?to=a@b")).toBe(false);
  expect(secretShaped("https://example.org/x?to=a@b")).toBe(false);
});
