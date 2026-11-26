import { expect, test } from "bun:test";
import { appendEvent } from "../src/ledger.ts";
import { isolatedPacket } from "./packet-fixture.ts";
import { exchangeFixture } from "./exchange-fixture.ts";

test("export reproduces the original hub_review arguments and selects the requested head", () => {
  const { cli, ingest, load, head } = exchangeFixture();
  const report = load("hub");
  expect(ingest("hub", report).status).toBe(0);
  const exported = cli("export", "--to", "hub", "--head", head);
  expect(exported.status).toBe(0);
  expect(JSON.parse(exported.stdout)).toEqual(report.hub_review);
  expect(cli("resolve", "compliance:port-behaviour-changes-unlisted", "--as", "fixed").status).toBe(0);
  const updated = JSON.parse(cli("export", "--to", "hub").stdout);
  expect(updated.findings[0].disposition).toBe("fixed");
});

test("Markdown export frames user text and shows the lifecycle, finding and coverage", () => {
  const { cli, ingest, head, load } = exchangeFixture();
  const report = load("brief");
  const findings = report.findings as Record<string, unknown>[];
  findings[1] = { ...findings[1], text: "Review note\n## Forged heading" };
  expect(ingest("brief", report).status).toBe(0);
  const result = cli("export", "--to", "markdown");
  expect(result.status).toBe(0);
  for (const marker of [head, "## Coverage", "## Findings", "> ## Forged heading",
    "src/rules.ts:3", "false_positive", "Imported from: brief"]) {
    expect(result.stdout).toContain(marker);
  }
  expect(result.stdout).not.toContain("\n## Forged heading");
  const hub = cli("export", "--to", "hub");
  expect(JSON.parse(hub.stdout).findings[0]).toMatchObject({
    pass: "security", severity: "important", disposition: "false_positive",
    anchor: { selectors: [{ startLine: 3, endLine: 3 }] },
  });
});

test("hub export applies a same-PR resolution at a later head to the earlier review", () => {
  const { dir, home, cli, ingest, load, git, write, base, head } = exchangeFixture();
  const savePacket = (head: string) => {
    const { packet } = isolatedPacket(dir, { kind: "range", base, head, pr: 7 });
    appendEvent(dir, { v: 1, type: "packet", at: "2026-11-26T00:00:00Z", packet }, { home });
    return packet.id;
  };
  const report = load("hub");
  const hub = report.hub_review as { findings: ({ id: string } & Record<string, unknown>)[] };
  const original = { ...hub, verdict: "changes_requested",
    findings: hub.findings.map(finding => ({ ...finding, severity: "important" })) };
  expect(ingest("hub", { ...report, packet_id: savePacket(head), hub_review: original }).status).toBe(0);
  expect(JSON.parse(cli("export", "--to", "hub", "--head", head).stdout)).toEqual(original);
  write("src/rules.ts", "rule 5\n");
  git("commit", "-qam", "later head");
  const later = git("rev-parse", "HEAD").trim();
  savePacket(later);
  const resolved = cli("resolve", String(original.findings[0]?.id), "--as", "fixed", "--head", later, "--pr", "7");
  expect(resolved.status).toBe(0);

  const shown = cli("show", "--head", head, "--pr", "7", "--json");
  expect(shown.status).toBe(0);
  expect(JSON.parse(shown.stdout).openBlocking).toEqual([]);
  const exported = cli("export", "--to", "hub", "--head", head);
  expect(exported.status).toBe(0);
  expect(JSON.parse(exported.stdout).findings[0].disposition).toBe("fixed");
});
