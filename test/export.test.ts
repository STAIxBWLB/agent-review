import { expect, test } from "bun:test";
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
