import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./packet-fixture.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A report is written outside the fixture repository: a workspace subject counts every uncommitted file, so a report
 * dropped into the tree it describes would change the very packet it is validated against.
 */
function report(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "arev-reports-"));
  scratch.push(dir);
  const path = join(dir, "report.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

/** A repository with one reviewed change, so `arev packet` has a range to build. */
function reviewedFlow(review = "# Review\nEvery change gets a packet and a record.\n") {
  const repo = fixture();
  const { git, write } = repo;
  write("REVIEW.md", review);
  write("src/a.ts", "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  write("src/a.ts", "export const a = 2;\nexport const b = 3;\n");
  git("add", ".");
  git("commit", "-qm", "head");
  return { ...repo, base, head: git("rev-parse", "HEAD").trim() };
}

type BuiltPacket = { id: string; subject: Record<string, unknown>; units: { path: string }[] };

/** The report a reviewer writes from `packet.json`, with every packet unit covered. */
function reportFor(packet: BuiltPacket, changes: Record<string, unknown> = {}) {
  return {
    v: 1,
    packet: { id: packet.id, subject: packet.subject },
    reviewer: { id: "claude", modelFamily: "anthropic", started: "self", sameFamilyFallback: false },
    coverage: { reviewed: packet.units.map(unit => unit.path), skipped: [] },
    findings: [],
    verdict: "approved",
    call: { ok: true },
    ...changes,
  };
}

test("arev packet writes the packet event, so arev record accepts the report written from it", () => {
  const { base, head, cli } = reviewedFlow();
  const built = cli("packet", "--from", base, "--to", head, "--json");
  expect(built.status).toBe(0);
  const packet = JSON.parse(built.stdout) as BuiltPacket;
  expect(packet.subject).toMatchObject({ kind: "range", base, head });
  expect(packet.units.map(unit => unit.path)).toEqual(["src/a.ts"]);

  const recorded = cli("record", report(reportFor(packet)));
  expect(recorded.stderr).toBe("");
  expect(recorded.status).toBe(0);
  expect(recorded.stdout).toContain("0 finding(s), 0 blocking open");

  const shown = JSON.parse(cli("show", "--json").stdout);
  expect(shown.head).toBe(head);
  expect(shown.packet).toBe(packet.id);
  expect(shown.verdict).toBe("approved");
});

test("the packet event keeps REVIEW.md's advisory_cap, so the report is capped by the file at the merge base", () => {
  const { base, head, cli } = reviewedFlow("# Review\n\n[review] advisory_cap = 2\n");
  const packet = JSON.parse(cli("packet", "--from", base, "--to", head, "--json").stdout) as BuiltPacket;
  const advisories = [0, 1, 2].map(index => ({
    id: `bugs:advisory-${index}`, term: "bugs", severity: "advisory", disposition: "open", origin: "introduced", text: `advisory ${index}`,
  }));
  const refused = cli("record", report(reportFor(packet, { findings: advisories, verdict: "changes_requested" })));
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("3 advisory findings exceed the cap of 2");
});

test("a REVIEW.md section arev does not read refuses the packet and writes no packet event", () => {
  const unknownKey = reviewedFlow("# Review\n\n[review] advisory_capp = 3\n");
  const key = unknownKey.cli("packet", "--from", unknownKey.base, "--to", unknownKey.head, "--json");
  expect(key.status).toBe(1);
  expect(key.stderr).toContain("REVIEW.md sets [review] advisory_capp, which arev does not read");
  expect(key.stderr).toContain("REVIEW.md [review] accepts only advisory_cap");

  const badValue = reviewedFlow('# Review\n\n[review] advisory_cap = "many"\n');
  const value = badValue.cli("packet", "--from", badValue.base, "--to", badValue.head, "--json");
  expect(value.status).toBe(1);
  expect(value.stderr).toContain('REVIEW.md sets [review] advisory_cap = "many"');
  expect(value.stderr).toContain("set advisory_cap to a number in 0-64");

  // Both are read before the event is written, so a refused packet leaves the ledger empty.
  expect(key.stdout + value.stdout).toBe("");
  expect(badValue.cli("show").stdout).toContain("no review ledger");
});

test("a report whose packet id is not the packet arev built for that head is refused", () => {
  const { base, head, cli } = reviewedFlow();
  const packet = JSON.parse(cli("packet", "--from", base, "--to", head, "--json").stdout) as BuiltPacket;
  const refused = cli("record", report(reportFor(packet, { packet: { id: "0".repeat(64), subject: packet.subject } })));

  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain(`the report's packet id is not the packet for head ${head}`);
  expect(refused.stderr).toContain("arev packet --pr N --out DIR");
});

test("a packet is recorded once per invocation and the ledger stays append-only", () => {
  const { base, head, cli } = reviewedFlow();
  expect(cli("packet", "--from", base, "--to", head, "--json").status).toBe(0);
  const first = JSON.parse(cli("show", "--json").stdout);
  expect(first.packet).toMatch(/^[a-f0-9]{64}$/);

  expect(cli("packet", "--from", base, "--to", head, "--json").status).toBe(0);
  const second = JSON.parse(cli("show", "--json").stdout);
  expect(second.packet).toBe(first.packet);
});

test("a workspace packet rebuilds to itself while the tree has not moved", () => {
  const { write, cli } = reviewedFlow();
  write("src/a.ts", "export const a = 9;\n");
  const built = cli("packet", "--workspace", "--json");
  expect(built.status).toBe(0);
  const packet = JSON.parse(built.stdout) as BuiltPacket;
  expect(packet.units.map(unit => unit.path)).toEqual(["src/a.ts"]);

  const recorded = cli("record", report(reportFor(packet)));
  expect(recorded.stderr).toBe("");
  expect(recorded.status).toBe(0);
});

test("a workspace report is refused when the tree moved after arev packet", () => {
  const { write, cli } = reviewedFlow();
  write("src/a.ts", "export const a = 9;\n");
  const built = cli("packet", "--workspace", "--json");
  expect(built.status).toBe(0);
  const packet = JSON.parse(built.stdout) as BuiltPacket;
  const file = report(reportFor(packet));

  // Same HEAD, later tree: the packet arev builds for this head is not the one the report was written from.
  write("src/a.ts", "export const a = 9;\nexport const c = 4;\n");
  write("src/c.ts", "export const c = 5;\n");
  const refused = cli("record", file);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("the packet changed since arev packet");
  expect(refused.stderr).toContain(`is what arev builds for head ${packet.subject.head} now`);
  expect(refused.stderr).toContain("rerun arev packet and rewrite the report");
});

test("a workspace report written inside the worktree is itself a change and is refused", () => {
  const { dir, write, cli } = reviewedFlow();
  write("src/a.ts", "export const a = 9;\n");
  const packet = JSON.parse(cli("packet", "--workspace", "--json").stdout) as BuiltPacket;

  const inside = join(dir, "report.json");
  writeFileSync(inside, JSON.stringify(reportFor(packet)));
  const refused = cli("record", inside);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("the packet changed since arev packet");
  expect(refused.stderr).toContain("keep the report outside the worktree");
});
