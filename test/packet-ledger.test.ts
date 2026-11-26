import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./packet-fixture.ts";

/** A repository with one reviewed change, so `arev packet` has a range to build. */
function reviewedFlow() {
  const repo = fixture();
  const { git, write } = repo;
  write("REVIEW.md", "# Review\nEvery change gets a packet and a record.\n");
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
  const { dir, base, head, cli } = reviewedFlow();
  const built = cli("packet", "--from", base, "--to", head, "--json");
  expect(built.status).toBe(0);
  const packet = JSON.parse(built.stdout) as BuiltPacket;
  expect(packet.subject).toMatchObject({ kind: "range", base, head });
  expect(packet.units.map(unit => unit.path)).toEqual(["src/a.ts"]);

  const file = join(dir, "report.json");
  writeFileSync(file, JSON.stringify(reportFor(packet)));
  const recorded = cli("record", file);
  expect(recorded.stderr).toBe("");
  expect(recorded.status).toBe(0);
  expect(recorded.stdout).toContain("0 finding(s), 0 blocking open");

  const shown = JSON.parse(cli("show", "--json").stdout);
  expect(shown.head).toBe(head);
  expect(shown.packet).toBe(packet.id);
  expect(shown.verdict).toBe("approved");
});

test("a report whose packet id is not the packet arev built for that head is refused", () => {
  const { dir, base, head, cli } = reviewedFlow();
  const packet = JSON.parse(cli("packet", "--from", base, "--to", head, "--json").stdout) as BuiltPacket;
  const file = join(dir, "report.json");
  writeFileSync(file, JSON.stringify(reportFor(packet, { packet: { id: "0".repeat(64), subject: packet.subject } })));

  const refused = cli("record", file);
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
