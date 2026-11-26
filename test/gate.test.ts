import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gateReport } from "../src/gate.ts";
import { appendEvent, ledgerPath, recordId, Refusal, type LedgerEvent, type PacketBlock, type ReviewRecordV1 } from "../src/ledger.ts";
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
  reviewer: { id: "claude", modelFamily: "anthropic", started: "self", sameFamilyFallback: false },
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

/** A `gh` that records its arguments instead of making a network call; `FAKE_GH_ERROR` makes it fail. */
function fakeGh(argsPath: string): string {
  const bin = temp("arev-bin-");
  const path = join(bin, "gh");
  writeFileSync(path, [
    "#!/bin/sh",
    `: > ${JSON.stringify(argsPath)}`,
    `for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(argsPath)}; done`,
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

  // Fail closed through the command too: no gate event, and never a status for a head the gate did not judge.
  const refused = run(repo, { AGENTHUB_HOME: home }, "gate", "--head", head, "--post");
  expect(refused.code).toBe(1);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("is reviewed in more than one thread (PR 7, PR 8)");
  expect(refused.stderr).toContain("→ pass --pr 7 or --pr 8 to choose the review thread");
  expect(events(repo, home).filter(event => event.type === "gate" || event.type === "post")).toEqual([]);

  // The flag reaches the decision through the command, and names the record it settled on.
  const threadedRun = run(repo, { AGENTHUB_HOME: home }, "gate", "--head", head, "--pr", "7");
  expect(threadedRun.code).toBe(0);
  expect(threadedRun.stdout).toContain(`record ${sevenId}`);

  const badPr = run(repo, { AGENTHUB_HOME: home }, "gate", "--pr", "seven");
  expect(badPr.code).toBe(2);
  expect(badPr.stderr).toContain("Invalid PR number. Pass a positive integer to --pr.");
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
  // `gh` is never spawned, and neither a post nor a gate event is written for the refused invocation.
  expect(existsSync(args)).toBe(false);
  expect(events(repo, home).filter(event => event.type === "gate" || event.type === "post")).toEqual([]);

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
  expect(events(repo, home).filter(event => event.type === "gate" || event.type === "post")).toEqual([]);
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
  expect(flag.stderr).toContain("gate takes --head <sha>, --pr <n>, --post and --json");

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

  const posted = run(repo, { PATH: `${fakeGh(args)}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home }, "gate", "--post", "--json");
  expect(posted.stderr).toBe("");
  expect(posted.code).toBe(0);
  expect(JSON.parse(posted.stdout)).toMatchObject({ head, ok: true, record: id });

  const argv = readFileSync(args, "utf8").trim().split("\n");
  expect(argv.slice(0, 3)).toEqual(["api", "--method", "POST"]);
  expect(argv[3]).toBe(`repos/{owner}/{repo}/statuses/${head}`);
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
