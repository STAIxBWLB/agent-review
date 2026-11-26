import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { canonicalJson, ledgerPath, readLedger, recordId, Refusal, reviewProjectId, secretShaped, appendEvent, type LedgerEvent, type PacketBlock, type ReviewRecordV1 } from "../src/ledger.ts";

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

test("a worktree whose path ends in a space is compared as it is, so a ledger inside it is still refused", () => {
  const root = mkdtempSync(join(tmpdir(), "arev-ledger-space-"));
  roots.push(root);
  // `rev-parse --show-toplevel` prints this path with its trailing space; stripping the whole output would compare
  // against a different, non-existent root and let the ledger sit inside the worktree it would then travel with.
  const repo = join(root, "repo ");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  expect(reviewProjectId(repo)).toMatch(/^repo @[a-f0-9]{8}$/);
  expect(ledgerPath(repo, { home: join(root, "agenthub") })).toBe(join(root, "agenthub", "review", reviewProjectId(repo), "ledger.jsonl"));
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

test("a packet event at the 500-file ceiling fits its own bound, and so does a record of the same packet", () => {
  const { repo, home } = fixture();
  // The largest packet a supported subject builds: 500 units with 160-byte paths, and three rules that each applied to
  // all of them (REVIEW.md plus two rule files under it), which is what `MAX_FILES` in src/packet.ts allows.
  const unitPath = (index: number) => `src/${String(index).padStart(3, "0")}/${"d".repeat(151)}.ts`;
  const units = Array.from({ length: 500 }, (_, index) => ({ path: unitPath(index), status: "M", insertions: 12, deletions: 3 }));
  const rules = ["REVIEW.md", "docs/review.md", ".github/review.md"].map(name => ({ name, sha256: "e".repeat(64), appliesTo: units.map(unit => unit.path) }));
  const packet: PacketBlock = { id: "d".repeat(64), subject: { kind: "range", base: HEAD, head: "b".repeat(40), mergeBase: HEAD }, units, rules };
  appendEvent(repo, { v: 1, type: "packet", at: "2026-11-26T00:00:00.000Z", review: { advisory_cap: 5 }, packet }, { home });
  // A record embeds the packet it was validated against beside a coverage list of the same paths, so it is the second
  // event that reaches this size. Full coverage, as a recorded review of that packet necessarily has.
  appendEvent(repo, {
    v: 1, type: "record", at: "2026-11-26T00:00:01.000Z", id: "f".repeat(64),
    record: {
      v: 1, packet,
      reviewer: { id: "claude", modelFamily: "anthropic", started: "self", sameFamilyFallback: false },
      coverage: { reviewed: units.map(unit => unit.path), skipped: [] },
      findings: [], verdict: "approved", call: { ok: true },
    },
  }, { home });
  const [packetLine, recordLine] = readFileSync(ledgerPath(repo, { home }), "utf8").trim().split("\n");
  // Over the bound every other event keeps and under the one these two carry: this is the size a supported subject reaches.
  for (const [name, line] of [["packet", packetLine], ["record", recordLine]] as const) {
    expect(Buffer.byteLength(line!), name).toBeGreaterThan(256 * 1024);
    expect(Buffer.byteLength(line!), name).toBeLessThan(1024 * 1024);
  }
});

test("a record of the largest packet and the largest report fits the record bound, which the packet bound would refuse", () => {
  const { repo, home } = fixture();
  // The issue's shape: the 500-unit ceiling with 400-byte paths, two rules covering all of them, and a report that
  // covers every unit while skipping half of them with a 600-byte reason. The embedded packet alone is under the packet
  // bound, and the record is the sum of that packet and the report - over the 1 MiB a record used to be held to.
  const unitPath = (index: number) => `src/${String(index).padStart(3, "0")}/${"d".repeat(391)}.ts`;
  const units = Array.from({ length: 500 }, (_, index) => ({ path: unitPath(index), status: "M", insertions: 1, deletions: 1 }));
  const rules = ["REVIEW.md", "docs/review.md"].map(name => ({ name, sha256: "e".repeat(64), appliesTo: units.map(unit => unit.path) }));
  const packet: PacketBlock = { id: "d".repeat(64), subject: { kind: "range", base: HEAD, head: "b".repeat(40), mergeBase: HEAD }, units, rules };
  appendEvent(repo, {
    v: 1, type: "record", at: "2026-11-26T00:00:01.000Z", id: "f".repeat(64),
    record: {
      v: 1, packet,
      reviewer: { id: "claude", modelFamily: "anthropic", started: "self", sameFamilyFallback: false },
      coverage: {
        reviewed: units.map(unit => unit.path),
        skipped: units.slice(0, 250).map(unit => ({ path: unit.path, reason: "s".repeat(600) })),
      },
      findings: [], verdict: "approved", call: { ok: true },
    },
  }, { home });
  const line = readFileSync(ledgerPath(repo, { home }), "utf8").trim();
  // Measured on the written line: over the packet event's 1 MiB (the bound a record was held to before this change) and
  // under the record's own packet + report bound.
  expect(Buffer.byteLength(line)).toBeGreaterThan(1024 * 1024);
  expect(Buffer.byteLength(line)).toBeLessThan(2 * 1024 * 1024);
});

test("an event over its own bound is refused, and the refusal names the event type", () => {
  const { repo, home } = fixture();
  expect(() => appendEvent(repo, resolveEvent("x".repeat(300 * 1024)), { home })).toThrow("the resolve event exceeds 262144 bytes");
  // Each of the two larger bounds belongs to its own event, and each refusal names itself.
  expect(() => appendEvent(repo, {
    v: 1, type: "packet", at: "2026-11-26T00:00:00.000Z",
    packet: { id: "d".repeat(64), subject: { kind: "range", base: HEAD, head: HEAD, mergeBase: HEAD }, units: [{ path: "x".repeat(1024 * 1024) }] },
  }, { home })).toThrow("the packet event exceeds 1048576 bytes");
  // A record is bounded by its packet plus the report it carries, so only a payload over both is refused.
  expect(() => appendEvent(repo, {
    v: 1, type: "record", at: "2026-11-26T00:00:00.000Z", id: "f".repeat(64),
    record: {
      v: 1,
      packet: { id: "d".repeat(64), subject: { kind: "range", base: HEAD, head: HEAD, mergeBase: HEAD }, units: [{ path: "x".repeat(1024 * 1024) }] },
      reviewer: { id: "claude", modelFamily: "anthropic", started: "self", sameFamilyFallback: false },
      coverage: { reviewed: [], skipped: [{ path: "src/a.ts", reason: "x".repeat(2 * 1024 * 1024) }] },
      findings: [], verdict: "approved", call: { ok: true },
    },
  }, { home })).toThrow("the record event exceeds 2097152 bytes");
  expect(existsSync(ledgerPath(repo, { home }))).toBe(false);
});

test("a checkout whose worktree root cannot be read refuses the ledger rather than skipping the containment check", () => {
  const root = mkdtempSync(join(tmpdir(), "arev-ledger-broken-"));
  roots.push(root);
  // A `.git` entry git itself cannot read: `rev-parse --show-toplevel` fails, and the containment check would be skipped.
  // The marker is what separates that from the supported case of a plain directory outside any repository, which the
  // next assertion keeps readable - `arev show` exits 0 there with its no-ledger line.
  const broken = join(root, "broken");
  mkdirSync(broken);
  writeFileSync(join(broken, ".git"), "gitdir: /nonexistent/gitdir\n");
  expect(() => ledgerPath(broken, { home: join(root, "agenthub") }))
    .toThrow("so where the ledger lives cannot be checked");
  // A marker that exists but cannot be followed is the same checkout: a `.git` symlink whose target is gone reads as
  // absent to a stat that follows links, and skipping the check there is the fail-open this signal exists to close.
  const unlinked = join(root, "unlinked");
  mkdirSync(unlinked);
  symlinkSync(join(root, "gone"), join(unlinked, ".git"));
  expect(() => ledgerPath(unlinked, { home: join(root, "agenthub") }))
    .toThrow("so where the ledger lives cannot be checked");
  // The search runs to the filesystem root, so distance does not turn the same checkout into "no marker": a fixed
  // ancestor count would stop short of the marker here and skip the check, one level further away from the same hole.
  const deep = join(unlinked, ...Array.from({ length: 70 }, (_, index) => `d${index}`));
  mkdirSync(deep, { recursive: true });
  expect(() => ledgerPath(deep, { home: join(root, "agenthub") }))
    .toThrow("so where the ledger lives cannot be checked");
  const outside = join(root, "plain");
  mkdirSync(outside);
  expect(ledgerPath(outside, { home: join(root, "agenthub") })).toContain(join("review"));
});

test("a repository without an origin keeps one ledger across its linked worktrees", () => {
  const { repo } = fixture();
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"]);
  const linked = join(dirname(repo), "linked");
  git(repo, ["worktree", "add", "-q", linked]);
  expect(git(repo, ["remote"])).toBe("");
  // The common git dir is the same in every worktree, so both checkouts key the same ledger; the worktree root alone
  // would give each its own.
  expect(reviewProjectId(linked)).toBe(reviewProjectId(repo));
  expect(reviewProjectId(repo)).toMatch(/^repo@[a-f0-9]{8}$/);
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
