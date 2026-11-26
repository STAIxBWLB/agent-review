import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reviewProjectId } from "../src/ledger.ts";
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
function reviewedFlow(review = "# Review\nEvery change gets a packet and a record.\n", env: NodeJS.ProcessEnv = {}) {
  const repo = fixture(env);
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

test("a REVIEW.md section past the 32,000-byte display cut still sets the advisory cap", () => {
  // 1,000 rule lines are 44,000 bytes, so the file's own tail is past the point the display and the brief are cut at.
  const long = `# Review\n${"- Every change is reviewed against its packet.\n".repeat(1_000)}\n[review] advisory_cap = 2\n`;
  expect(Buffer.byteLength(long)).toBeGreaterThan(32_000);
  const { base, head, cli } = reviewedFlow(long);
  const packet = JSON.parse(cli("packet", "--from", base, "--to", head, "--json").stdout) as BuiltPacket;
  const advisories = [0, 1, 2].map(index => ({
    id: `bugs:advisory-${index}`, term: "bugs", severity: "advisory", disposition: "open", origin: "introduced", text: `advisory ${index}`,
  }));
  const refused = cli("record", report(reportFor(packet, { findings: advisories, verdict: "changes_requested" })));
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("3 advisory findings exceed the cap of 2");
});

test("a failed --out export leaves no packet event behind", () => {
  const { base, head, dir, cli } = reviewedFlow();
  // An existing packet.json makes the export refuse after it wrote nothing, so the packet never reaches a reviewer.
  const out = join(dir, "packets");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "packet.json"), "written by an earlier run\n");
  const failed = cli("packet", "--from", base, "--to", head, "--out", out);
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("Cannot write packet files");
  // The export that did not happen is not a packet in the ledger: only the packet a reviewer holds is recorded.
  expect(cli("show").stdout).toContain("no review ledger");
  const delivered = join(dir, "delivered");
  expect(cli("packet", "--from", base, "--to", head, "--out", delivered).status).toBe(0);
  expect(JSON.parse(cli("show", "--json").stdout).packet).toMatch(/^[a-f0-9]{64}$/);
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

test("arev packet --pr N names the PR in the packet's subject, and the report written from it records", () => {
  const bin = mkdtempSync(join(tmpdir(), "arev-gh-"));
  scratch.push(bin);
  // A fake `gh` keeps this offline: `--pr` reads the base and head from it, and the values are the fixture's own commits,
  // which the command validates as full OIDs before using them.
  const { base, head, cli } = reviewedFlow("# Review\n", { PATH: `${bin}:${process.env.PATH ?? ""}` });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '{"baseRefOid":"${base}","headRefOid":"${head}"}'\n`, { mode: 0o755 });
  const built = cli("packet", "--pr", "7", "--json");
  expect(built.status).toBe(0);
  const packet = JSON.parse(built.stdout) as BuiltPacket & { subject: { pr?: number } };
  expect(packet.subject).toMatchObject({ kind: "range", base, head, pr: 7 });

  // The packet event carries the thread, and `record`'s rebuild has to reproduce it: a rebuild that dropped `pr` would
  // build a different id and refuse this report.
  const recorded = cli("record", report(reportFor(packet)));
  expect(recorded.stderr).toBe("");
  expect(recorded.status).toBe(0);
  const shown = JSON.parse(cli("show", "--json").stdout);
  expect(shown.packet).toBe(packet.id);
  expect(shown.head).toBe(head);
});

test("a resolve names its own PR, so a head with a packet but no record settles only that PR", () => {
  const bin = mkdtempSync(join(tmpdir(), "arev-gh-"));
  const home = mkdtempSync(join(tmpdir(), "arev-home-"));
  scratch.push(bin, home);
  const { dir, git, write, base, head, cli } = reviewedFlow("# Review\n", { PATH: `${bin}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home });
  // A fake `gh` sets only the refs: each call answers with the head this test is about to packet, so nothing leaves the
  // machine and two PRs can be reviewed in one ledger.
  const gh = (ref: string) => writeFileSync(join(bin, "gh"),
    `#!/bin/sh\nprintf '{"baseRefOid":"${base}","headRefOid":"${ref}"}'\n`, { mode: 0o755 });
  const commit = (body: string, message: string) => {
    write("src/a.ts", body);
    git("add", ".");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD").trim();
  };
  const second = commit("export const a = 3;\n", "second head"), third = commit("export const a = 4;\n", "third head");
  const blocking = { id: "bugs:cross-pr", term: "bugs", severity: "blocking", disposition: "open", origin: "introduced", text: "the same defect is reported in both PRs" };

  // PR 7 reports it at its first head, PR 8 reports it at its own head.
  gh(head);
  const firstPacket = JSON.parse(cli("packet", "--pr", "7", "--json").stdout) as BuiltPacket;
  expect(cli("record", report(reportFor(firstPacket, { findings: [blocking], verdict: "changes_requested" }))).status).toBe(0);
  gh(second);
  const otherPacket = JSON.parse(cli("packet", "--pr", "8", "--json").stdout) as BuiltPacket;
  // A second id only this PR reports, so the resolve below can be refused for the thread alone rather than for existence.
  const otherOnly = { ...blocking, id: "bugs:other-only", text: "only the other PR reports this" };
  expect(cli("record", report(reportFor(otherPacket, { findings: [blocking, otherOnly], verdict: "changes_requested" }))).status).toBe(0);

  // PR 7 moves to a third head: a packet with no record of its own, which is where the resolve is made.
  gh(third);
  expect(cli("packet", "--pr", "7", "--json").status).toBe(0);
  // An id this PR never reported is refused, so the resolve cannot reach past its own thread.
  const unknown = cli("resolve", "bugs:nowhere", "--head", third, "--as", "fixed");
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain("no record of PR 7 reports the finding bugs:nowhere");
  // An id the other PR alone reports is refused here too, so the check is this head\x27s thread, not the whole ledger.
  const elsewhere = cli("resolve", "bugs:other-only", "--head", third, "--as", "fixed");
  expect(elsewhere.status).toBe(1);
  expect(elsewhere.stderr).toContain("no record of PR 7 reports the finding bugs:other-only");

  const resolved = cli("resolve", "bugs:cross-pr", "--head", third, "--as", "fixed");
  expect(resolved.stderr).toBe("");
  expect(resolved.status).toBe(0);
  // The event carries the thread it was made in, which is what a replay matches: the head alone would settle PR 7's id
  // in PR 8 as well, because both report it.
  const ledger = readFileSync(join(home, "review", ...reviewProjectId(dir).split("/"), "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(ledger.filter((event: { type: string }) => event.type === "resolve").at(-1)).toMatchObject({ finding: "bugs:cross-pr", head: third, pr: 7 });

  expect(JSON.parse(cli("show", "--head", third, "--json").stdout).openBlocking).toEqual([]);
  const other = JSON.parse(cli("show", "--head", second, "--json").stdout);
  expect(other.openBlocking).toEqual(["bugs:cross-pr", "bugs:other-only"]);
  expect(other.counts).toMatchObject({ openImportant: 2, fixed: 0 });
});

test("two PRs share one head, so each report records against its own packet and show and resolve need --pr", () => {
  const bin = mkdtempSync(join(tmpdir(), "arev-gh-"));
  const home = mkdtempSync(join(tmpdir(), "arev-home-"));
  scratch.push(bin, home);
  const { dir, git, write, base, head, cli } = reviewedFlow("# Review\n", { PATH: `${bin}:${process.env.PATH ?? ""}`, AGENTHUB_HOME: home });
  // One branch opened against two bases: both PRs review this same head, so each has its own packet there. The fake `gh`
  // answers with the head the next `arev packet` is about, so nothing leaves the machine.
  const gh = (ref: string) => writeFileSync(join(bin, "gh"),
    `#!/bin/sh\nprintf '{"baseRefOid":"${base}","headRefOid":"${ref}"}'\n`, { mode: 0o755 });
  gh(head);
  const seven = JSON.parse(cli("packet", "--pr", "7", "--json").stdout) as BuiltPacket;
  const eight = JSON.parse(cli("packet", "--pr", "8", "--json").stdout) as BuiltPacket;
  expect(seven.subject).toMatchObject({ pr: 7 });
  expect(eight.subject).toMatchObject({ pr: 8 });
  expect(seven.id).not.toBe(eight.id);

  const sevenOnly = { id: "bugs:seven-only", term: "bugs", severity: "blocking", disposition: "open", origin: "introduced", text: "only PR 7 reports this" };
  const eightOnly = { ...sevenOnly, id: "bugs:eight-only", text: "only PR 8 reports this" };
  // PR 7's packet is the older event for this head, and PR 8's is the newest: a lookup by head would record PR 7's report
  // against PR 8's packet, which its own packet id refuses.
  expect(cli("record", report(reportFor(seven, { findings: [sevenOnly], verdict: "changes_requested" }))).stderr).toBe("");
  expect(cli("record", report(reportFor(eight, { findings: [eightOnly], verdict: "changes_requested" }))).stderr).toBe("");
  const ledger = readFileSync(join(home, "review", ...reviewProjectId(dir).split("/"), "ledger.jsonl"), "utf8")
    .split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(ledger.filter((event: { type: string }) => event.type === "record").map((event: { record: { packet: { id: string } } }) => event.record.packet.id))
    .toEqual([seven.id, eight.id]);

  // No default read is right for a shared head, so it is refused with the candidates rather than answered with the newest.
  const ambiguous = cli("show", "--head", head, "--json");
  expect(ambiguous.status).toBe(1);
  expect(ambiguous.stderr).toContain(`head ${head} is reviewed in more than one thread (PR 7, PR 8)`);
  expect(ambiguous.stderr).toContain("pass --pr 7 or --pr 8 to choose the review thread");
  // With `--pr` each reads only its own thread, and a PR with nothing at the head is refused rather than shown empty.
  const mine = JSON.parse(cli("show", "--head", head, "--pr", "7", "--json").stdout);
  expect(mine).toMatchObject({ head, pr: 7, packet: seven.id });
  expect(mine.openBlocking).toEqual(["bugs:seven-only"]);
  const theirs = JSON.parse(cli("show", "--head", head, "--pr", "8", "--json").stdout);
  expect(theirs).toMatchObject({ head, pr: 8, packet: eight.id });
  expect(theirs.openBlocking).toEqual(["bugs:eight-only"]);
  const nothing = cli("show", "--head", head, "--pr", "9", "--json");
  expect(nothing.status).toBe(1);
  expect(nothing.stderr).toContain(`no packet or record at head ${head} belongs to PR 9`);

  // resolve follows the same rule: ambiguous without --pr, refused in the wrong thread, and settled in its own.
  const noPr = cli("resolve", "bugs:seven-only", "--as", "fixed");
  expect(noPr.status).toBe(1);
  expect(noPr.stderr).toContain("is reviewed in more than one thread");
  const wrongThread = cli("resolve", "bugs:seven-only", "--pr", "8", "--as", "fixed");
  expect(wrongThread.status).toBe(1);
  expect(wrongThread.stderr).toContain("no record of PR 8 reports the finding bugs:seven-only");
  expect(cli("resolve", "bugs:seven-only", "--pr", "7", "--as", "fixed").status).toBe(0);
  expect(JSON.parse(cli("show", "--head", head, "--pr", "7", "--json").stdout).openBlocking).toEqual([]);
  expect(JSON.parse(cli("show", "--head", head, "--pr", "8", "--json").stdout).openBlocking).toEqual(["bugs:eight-only"]);

  // Two more heads, PR 7 then PR 8, so `resolve --pr 7` without --head can be shown to read PR 7's own newest record
  // rather than the ledger's newest, which by then is PR 8's.
  const commit = (body: string, message: string) => {
    write("src/a.ts", body);
    git("add", ".");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD").trim();
  };
  const sevenNext = commit("export const a = 5;\n", "PR 7 second head");
  gh(sevenNext);
  const sevenSecond = JSON.parse(cli("packet", "--pr", "7", "--json").stdout) as BuiltPacket;
  expect(cli("record", report(reportFor(sevenSecond, { findings: [sevenOnly], verdict: "changes_requested" }))).status).toBe(0);
  const eightNext = commit("export const a = 6;\n", "PR 8 second head");
  gh(eightNext);
  const eightSecond = JSON.parse(cli("packet", "--pr", "8", "--json").stdout) as BuiltPacket;
  expect(cli("record", report(reportFor(eightSecond, { findings: [eightOnly], verdict: "changes_requested" }))).status).toBe(0);
  const backToSeven = cli("resolve", "bugs:seven-only", "--pr", "7", "--as", "fixed");
  expect(backToSeven.stdout).toContain(`at ${sevenNext}`);
  expect(JSON.parse(cli("show", "--head", sevenNext, "--json").stdout).openBlocking).toEqual([]);
});

test("a report whose packet id is not in the ledger is refused, and one whose head disagrees with its packet too", () => {
  const { base, head, cli } = reviewedFlow();
  const packet = JSON.parse(cli("packet", "--from", base, "--to", head, "--json").stdout) as BuiltPacket;
  // The report names the packet it was written from, so an id no packet event carries is refused by that id.
  const unknown = cli("record", report(reportFor(packet, { packet: { id: "0".repeat(64), subject: packet.subject } })));
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain(`no packet ${"0".repeat(64)} is in the ledger`);
  expect(unknown.stderr).toContain("arev packet --pr N --out DIR");

  // The head the report states is checked against the packet its id names, not the other way round.
  const movedHead = cli("record", report(reportFor(packet, { packet: { id: packet.id, subject: { ...packet.subject, head: base } } })));
  expect(movedHead.status).toBe(1);
  expect(movedHead.stderr).toContain(`the packet ${packet.id} is for head ${head}, not ${base}`);

  // A report with no packet id at all is refused before any lookup, rather than searched for by an undefined id.
  const noId = cli("record", report(reportFor(packet, { packet: { subject: packet.subject } })));
  expect(noId.status).toBe(1);
  expect(noId.stderr).toContain("has no packet id at packet.id");
});

test("a refusal that reaches the command's catch prints its own next step, not the command's help", () => {
  const { base, head, git, cli } = reviewedFlow();
  // The ledger path is refused while the packet event is written, after the packet itself was built, so this refusal
  // leaves the packet command through `src/cli.ts`: `arev packet --help` would answer nothing here.
  git("remote", "add", "origin", "https://github.com/../evil.git");
  const refused = cli("packet", "--from", base, "--to", head, "--json");
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("the origin remote does not name a plain repository path");
  expect(refused.stderr).toContain("set origin to a plain host/owner/repo URL, or remove it to key the ledger by the working tree");
  expect(refused.stderr).not.toContain("arev packet --help");
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

test("a workspace or files packet refuses an --out directory inside the reviewed worktree", () => {
  const { dir, write, cli } = reviewedFlow();
  write("src/a.ts", "export const a = 9;\n");
  // Both subjects count every uncommitted path, so the bundle they wrote there would be a change in the packet they
  // describe: `record`'s rebuild would refuse the report written from it.
  for (const subject of [["--workspace"], ["--files", "src/a.ts"]]) {
    const refused = cli("packet", ...subject, "--out", join(dir, "bundle"));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("The --out directory is inside the reviewed worktree");
    expect(refused.stderr).toContain("choose a directory outside the worktree");
  }
  expect(existsSync(join(dir, "bundle"))).toBe(false);
});

test("a packet whose event cannot be written leaves no bundle behind", () => {
  const home = mkdtempSync(join(tmpdir(), "arev-hub-broken-"));
  scratch.push(home);
  const { base, head, dir, cli } = reviewedFlow("# Review\n", { AGENTHUB_HOME: home });
  // A directory where the ledger file belongs makes the append fail after the bundle has been written.
  const ledger = join(home, "review", ...reviewProjectId(dir).split("/"), "ledger.jsonl");
  mkdirSync(ledger, { recursive: true });
  const out = join(dirname(dir), "bundle");
  scratch.push(out);
  const failed = cli("packet", "--from", base, "--to", head, "--out", out);
  expect(failed.status).toBe(1);
  // The bundle goes with the event: nobody can report against it, and a retry would hit the exclusive open.
  expect(existsSync(out)).toBe(false);
  rmSync(ledger, { recursive: true, force: true });
  expect(cli("packet", "--from", base, "--to", head, "--out", out).status).toBe(0);
  expect(existsSync(join(out, "packet.json"))).toBe(true);
});
