import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { canonicalJson, ledgerPath, readLedger, recordId, Refusal, reviewProjectId, secretShaped, appendEvent, type LedgerEvent, type ReviewRecordV1 } from "../src/ledger.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture(): { repo: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "arev-ledger-"));
  roots.push(root);
  const repo = join(root, "repo"), home = join(root, "agenthub");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  return { repo, home };
}

const HEAD = "a".repeat(40);
const resolveEvent = (rationale?: string): LedgerEvent => ({
  v: 1, type: "resolve", at: "2026-11-26T00:00:00.000Z", head: HEAD, finding: "bugs:one", as: "fixed",
  ...(rationale === undefined ? {} : { rationale }),
});

test("the project id is the origin URL normalized to host and path, as amem derives it", () => {
  const { repo } = fixture();
  for (const [origin, expected] of [
    ["https://github.com/STAIxBWLB/Agent-Review.git", "github.com/staixbwlb/agent-review"],
    ["https://github.com/STAIxBWLB/Agent-Review", "github.com/staixbwlb/agent-review"],
    ["git@github.com:STAIxBWLB/Agent-Review.git", "github.com/staixbwlb/agent-review"],
    ["ssh://git@github.com:22/STAIxBWLB/Agent-Review.git", "github.com/staixbwlb/agent-review"],
    ["ssh://git@example.com:2222/team/r.git", "example.com:2222/team/r"],
    ["https://example.com/team/r", "example.com/team/r"],
  ] as const) {
    if (git(repo, ["remote"]).split("\n").includes("origin")) git(repo, ["remote", "set-url", "origin", origin]);
    else git(repo, ["remote", "add", "origin", origin]);
    expect(reviewProjectId(repo), origin).toBe(expected);
  }
  git(repo, ["remote", "remove", "origin"]);
  expect(reviewProjectId(repo)).toMatch(/^repo@[a-f0-9]{8}$/);
});

test("the ledger lives under AGENTHUB_HOME/review/<project-id>/ and never in the worktree", () => {
  const { repo, home } = fixture();
  git(repo, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  expect(ledgerPath(repo, { home })).toBe(join(home, "review", "github.com/owner/repo", "ledger.jsonl"));
  expect(() => ledgerPath(repo, { home: join(repo, "ledger-home") })).toThrow(Refusal);
  expect(() => ledgerPath(repo, { home: join(repo, "ledger-home") })).toThrow("AGENTHUB_HOME resolves inside the reviewed worktree");
});

test("the project key and the worktree check follow the reviewed checkout, not an inherited GIT_DIR", () => {
  const { repo } = fixture();
  // A second repository, named by GIT_DIR/GIT_WORK_TREE as a submodule or a hook would: the ledger must still describe
  // the checkout `arev packet` describes, or the containment rule is checked against the wrong tree.
  const other = join(dirname(repo), "other");
  mkdirSync(other);
  git(other, ["init", "-q", "-b", "main"]);
  git(other, ["remote", "add", "origin", "https://github.com/other/repo.git"]);
  git(repo, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    expect(reviewProjectId(repo)).toBe("github.com/owner/repo");
    expect(() => ledgerPath(repo, { home: join(repo, "ledger-home") })).toThrow("AGENTHUB_HOME resolves inside the reviewed worktree");
    expect(ledgerPath(repo, { home: join(dirname(repo), "agenthub") })).toContain(join("review", "github.com", "owner", "repo"));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("events are appended one JSON line each and an earlier line is never rewritten", () => {
  const { repo, home } = fixture();
  const path = ledgerPath(repo, { home });
  expect(readLedger(repo, { home })).toEqual([]);
  appendEvent(repo, resolveEvent(), { home });
  const first = readFileSync(path, "utf8");
  appendEvent(repo, resolveEvent("settled by the follow-up commit"), { home });
  const second = readFileSync(path, "utf8");
  expect(second.startsWith(first)).toBe(true);
  expect(second.slice(first.length)).toBe(JSON.stringify(resolveEvent("settled by the follow-up commit")) + "\n");
  expect(readLedger(repo, { home })).toEqual([resolveEvent(), resolveEvent("settled by the follow-up commit")]);
});

test("a malformed ledger line is reported with its number and the file is left as it was", () => {
  const { repo, home } = fixture();
  const path = ledgerPath(repo, { home });
  appendEvent(repo, resolveEvent(), { home });
  appendFileSync(path, "{not json}\n");
  const before = readFileSync(path, "utf8");
  expect(() => readLedger(repo, { home })).toThrow("ledger line 2 is not valid JSON");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("a secret-shaped value is refused before it reaches the ledger", () => {
  const { repo, home } = fixture();
  const path = ledgerPath(repo, { home });
  expect(secretShaped("token = abcdefgh1234")).toBe(true);
  expect(secretShaped("fixed in src/ledger.ts:12")).toBe(false);
  expect(() => appendEvent(repo, resolveEvent("token = abcdefgh1234"), { home })).toThrow(Refusal);
  expect(() => appendEvent(repo, resolveEvent("token = abcdefgh1234"), { home })).toThrow("matches a secret pattern");
  expect(readLedger(repo, { home })).toEqual([]);
  expect(() => readFileSync(path, "utf8")).toThrow();
});

test("a secret separated from its key by a tab or a newline is refused, in a nested string too", () => {
  const { repo, home } = fixture();
  // The line-level screen runs on the serialized JSON, where one tab or newline is the two characters `\t` / `\n`. An
  // assignment that separates its key from `:` or `=` with one of them needs that whitespace as whitespace, so the
  // serialized line no longer matches it - and the write would put the value in the ledger and in `show --json`.
  expect(secretShaped(JSON.stringify({ text: "token\t: abcdefgh1" }))).toBe(false);
  for (const text of ["token\t: abcdefgh1", "token\n= abcdefgh1", "password\t: hunter2hunter2", "api_key\n= abcdefgh1"]) {
    expect(() => appendEvent(repo, resolveEvent(text), { home }), JSON.stringify(text)).toThrow("matches a secret pattern");
  }
  // A tab or a newline straight after the colon, and a string nested inside the event, are refused the same way.
  for (const text of ["token:\tabcdefgh1", "token:\nabcdefgh1"]) {
    expect(() => appendEvent(repo, resolveEvent(text), { home }), JSON.stringify(text)).toThrow("matches a secret pattern");
  }
  // A string nested inside the event is screened the same way: here a finding's text.
  const nested: LedgerEvent = {
    v: 1, type: "record", at: "2026-11-26T00:00:00.000Z", id: "e".repeat(64),
    record: {
      v: 1,
      packet: { id: "c".repeat(64), subject: { kind: "range", head: HEAD } },
      reviewer: { id: "claude", modelFamily: "anthropic", started: "self", sameFamilyFallback: false },
      coverage: { reviewed: [], skipped: [] },
      findings: [{ id: "bugs:one", term: "bugs", severity: "blocking", text: "token\t: abcdefgh1", disposition: "open", origin: "introduced" }],
      verdict: "changes_requested",
      call: { ok: true },
    },
  };
  expect(() => appendEvent(repo, nested, { home })).toThrow("matches a secret pattern");
  expect(readLedger(repo, { home })).toEqual([]);
});

test("an origin that does not name a plain repository path is refused, and nothing is written outside review", () => {
  const { repo, home } = fixture();
  git(repo, ["remote", "add", "origin", "https://github.com/../evil.git"]);
  expect(reviewProjectId(repo)).toBe("github.com/../evil");
  expect(() => ledgerPath(repo, { home })).toThrow("does not name a plain repository path");
  expect(() => appendEvent(repo, resolveEvent(), { home })).toThrow(Refusal);
  // An empty segment is refused by the component check alone, and the read path is closed too.
  git(repo, ["remote", "set-url", "origin", "ssh://git@example.com//team/r.git"]);
  expect(reviewProjectId(repo)).toBe("example.com//team/r");
  expect(() => ledgerPath(repo, { home })).toThrow("does not name a plain repository path");
  expect(() => readLedger(repo, { home })).toThrow("does not name a plain repository path");
  expect(existsSync(join(home, "review"))).toBe(false);
});

test("the record id is the sha256 of the canonical JSON, so key order does not change it", () => {
  const record = (findings: ReviewRecordV1["findings"]): ReviewRecordV1 => ({
    v: 1,
    packet: { id: "c".repeat(64), subject: { kind: "range", head: HEAD } },
    reviewer: { id: "claude", modelFamily: "anthropic", started: "self", sameFamilyFallback: false },
    coverage: { reviewed: ["src/a.ts"], skipped: [] },
    findings,
    verdict: "approved",
    call: { ok: true },
  });
  const reordered: ReviewRecordV1 = {
    call: { ok: true },
    verdict: "approved",
    findings: [],
    coverage: { skipped: [], reviewed: ["src/a.ts"] },
    reviewer: { sameFamilyFallback: false, started: "self", modelFamily: "anthropic", id: "claude" },
    packet: { subject: { head: HEAD, kind: "range" }, id: "c".repeat(64) },
    v: 1,
  };
  expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  expect(recordId(record([]))).toBe(recordId(reordered));
  expect(recordId(record([]))).toMatch(/^[a-f0-9]{64}$/);
});
