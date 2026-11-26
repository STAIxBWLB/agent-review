import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gateReport, parseGateSection } from "../src/gate.ts";
import { appendEvent, ledgerPath, recordId, type LedgerEvent, type PacketBlock, type ReviewRecordV1 } from "../src/ledger.ts";
import { parseReviewRecord } from "../src/record.ts";
import type { RuleText } from "../src/rules.ts";

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
 * in the oldest commit, so it is at every merge base this fixture can name; `null` leaves it out, which is the case
 * `--light` exists for. The ledger's home is a sibling of the worktree, never inside it.
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
  return { repo, home, older, base, head };
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
const recordFor = (subject: Subject, changes: Record<string, unknown> = {}): ReviewRecordV1 =>
  parseReviewRecord(reportFor(subject, changes), { packet: packetFor(subject), person: false });

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

const rule = (text: string): RuleText[] => [{ name: "REVIEW.md", sha256: "e".repeat(64), appliesTo: [], text }];

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
  expect(result).toEqual({ head, base, record: id, verdict: "approved", ok: true, open: [] });
  // Same inputs, same answer: the gate reads the ledger and git only (AC4).
  expect(gateReport(repo, { head, home })).toEqual(result);
  // The head defaults to the repository's own HEAD.
  expect(gateReport(repo, { home })).toEqual(result);
  expect(() => gateReport(repo, { head: "abc1234", home })).toThrow("--head must be a full commit SHA");
});

test("a head with no record fails, and a record for an older head never passes", () => {
  const { repo, older, base, head, home } = fixture();
  const empty = gateReport(repo, { head, home });
  expect(empty).toMatchObject({ head, ok: false, open: [`no record for head ${head}; run arev record with the report for this head`] });
  expect(empty.base).toBeUndefined();
  expect(empty.record).toBeUndefined();

  // A record for the middle commit passes there and nowhere later: the gate never reads the newest record.
  const subject: Subject = { kind: "range", base: older, head: base, mergeBase: older };
  const id = seed({ repo, home, subject, record: recordFor(subject) });

  expect(gateReport(repo, { head, home })).toMatchObject({ head, ok: false, open: [`no record for head ${head}; run arev record with the report for this head`] });
  expect(gateReport(repo, { head: base, home })).toEqual({ head: base, base: older, record: id, verdict: "approved", ok: true, open: [] });
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
  // An explicit disposition settles its id for every head (the ported lifecycle's rule), so settling elsewhere counts.
  const elsewhere = gated({ ...resolve("fixed"), head: "f".repeat(40) } as LedgerEvent);
  expect(elsewhere.open).toEqual([]);
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

test("REVIEW.md must be at the merge base unless the gate is told --light", () => {
  const { repo, base, head, home } = fixture(null);
  const subject: Subject = { kind: "range", base, head, mergeBase: base };
  const id = seed({ repo, home, subject, record: recordFor(subject) });

  const strict = gateReport(repo, { head, home });
  expect(strict.ok).toBe(false);
  expect(strict.open).toEqual([`REVIEW.md is not at the merge base ${base}; pass --light only when the review was made without one`]);

  const light = gateReport(repo, { head, home, light: true });
  expect(light).toMatchObject({ head, base, record: id, ok: true, open: [] });
});

test("[gate] same_family is read from REVIEW.md, and absent means deny", () => {
  expect(parseGateSection([])).toEqual({ sameFamily: "deny" });
  expect(parseGateSection(rule("# Review\n"))).toEqual({ sameFamily: "deny" });
  expect(parseGateSection(rule('# Review\n[gate] same_family = "allow"\n'))).toEqual({ sameFamily: "allow" });
  expect(parseGateSection(rule('# Review\n[gate]\nsame_family = "allow"\n'))).toEqual({ sameFamily: "allow" });
  expect(parseGateSection(rule('# Review\n- [gate] same_family = "deny"\n'))).toEqual({ sameFamily: "deny" });
  // The section closes on a blank line or the next heading, so a key below it is not a gate setting.
  expect(parseGateSection(rule('[gate]\n\nsame_family = "allow"\n'))).toEqual({ sameFamily: "deny" });

  // A key arev does not read is refused by name, because a typo would silently leave the guard off.
  expect(() => parseGateSection(rule('[gate] same_famly = "allow"\n'))).toThrow("sets [gate] same_famly, which arev does not read");
  expect(() => parseGateSection(rule('[gate] same_family = "allw"\n'))).toThrow('REVIEW.md sets [gate] same_family = "allw"');
  expect(() => parseGateSection(rule("[gate] allow\n"))).toThrow('is not "key = value"');
  expect(() => parseGateSection(rule('[gate]\nsame_family = "allow"\nsame_family = "deny"\n'))).toThrow("sets [gate] same_family twice");
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
