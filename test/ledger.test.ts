import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
