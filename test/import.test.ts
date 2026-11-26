import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appendEvent, ledgerPath, readLedger } from "../src/ledger.ts";
import { isolatedPacket } from "./packet-fixture.ts";
import { exchangeFixture } from "./exchange-fixture.ts";

test("OCR import preserves the semantic ID, path, line range, category and disposition", () => {
  const { cli, ingest, dir, home, load } = exchangeFixture();
  const imported = ingest("ocr");
  expect(imported.status).toBe(0);
  const event = readLedger(dir, { home }).at(-1);
  expect(event?.type === "record" && event.source).toEqual({ format: "ocr", report: load("ocr") });
  const show = cli("show", "--json");
  expect(show.status).toBe(0);
  expect(JSON.parse(show.stdout).findings).toMatchObject([{
    id: "bugs:empty-rules-cache", pass: "bugs", severity: "important", path: "src/rules.ts",
    disposition: "fixed", anchor: { selectors: [{ kind: "lineRange", startLine: 2, endLine: 3 }] },
  }]);
});

test("brief import maps P0-P3 to the two record severities and retains dispositions", () => {
  const { cli, ingest } = exchangeFixture();
  const result = ingest("brief");
  expect(result.status).toBe(0);
  const shown = JSON.parse(cli("show", "--json").stdout);
  expect(shown.findings).toMatchObject([
    { id: "security:unscoped-rule-source", pass: "security", severity: "important",
      disposition: "false_positive", origin: "pre_existing", evidence: ["src/rules.ts:6"],
      anchor: { selectors: [{ startLine: 3, endLine: 3 }] } },
    { id: "compliance:document-rule-order", severity: "nit", disposition: "open",
      anchor: { selectors: [{ startLine: 4, endLine: 4 }] } },
  ]);
});

test("import refuses mismatched subjects, omitted coverage and secret fields before writing", () => {
  const { cli, ingest, load } = exchangeFixture();
  const report = load("ocr");
  const badBase = ingest("ocr", { ...report, base_commit: "0".repeat(40) });
  const noCoverage = ingest("ocr", { ...report, coverage: { reviewed: [], skipped: [] } });
  const secret = ingest("ocr", { ...report, metadata: { password: "fixture-sensitive-canary" } });
  expect(badBase.status).toBe(1);
  expect(badBase.stderr).toContain("base differs");
  expect(noCoverage.status).toBe(1);
  expect(noCoverage.stderr).toContain("coverage omits");
  expect(noCoverage.stderr).toContain("arev import --from ocr 'report.json'");
  expect(secret.status).toBe(1);
  expect(secret.stderr).toContain("credential field");
  expect(secret.stderr).not.toContain("fixture-sensitive-canary");
  expect(cli("export", "--to", "hub").status).toBe(1);
});

test("Markdown brief imports labelled findings from the prose report", () => {
  const { cli, write, dir, home, head, base } = exchangeFixture();
  const markdown = readFileSync(new URL("./fixtures/exchange/brief.md", import.meta.url), "utf8");
  const metadata = { head, base, call: { ok: true },
    reviewer: { id: "brief-reviewer", modelFamily: "fixture-family" },
    coverage: { reviewed: ["src/rules.ts"], skipped: [] } };
  write("review.md", "```json\n" + JSON.stringify(metadata) + "\n```\n" + markdown);
  const result = cli("import", "--from", "brief", "review.md");
  expect(result.status).toBe(0);
  const event = readLedger(dir, { home }).at(-1);
  if (event?.type !== "record") throw new Error("missing record");
  expect(event.source?.report.markdown).toBe(markdown);
  expect(event.record.findings).toMatchObject([
    { id: "bugs:rule-result-explanation", severity: "advisory", disposition: "fixed",
      origin: "introduced", anchor: { selectors: [{ startLine: 2, endLine: 3 }] } },
    { id: "compliance:brief-rule-precedence", severity: "advisory", disposition: "open",
      anchor: { selectors: [{ startLine: 4, endLine: 4 }] } },
  ]);
});

test("import enforces the advisory cap recorded from the base rule", () => {
  const { cli, ingest } = exchangeFixture("Review fixture\n\n[review]\nadvisory_cap = 0\n");
  const result = ingest("brief");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("advisory findings exceed the cap of 0");
  expect(cli("export", "--to", "hub").status).toBe(1);
});

test("import screens decoded JSON before a report value reaches a refusal", () => {
  const { cli, ingest, load } = exchangeFixture();
  const report = load("ocr");
  const value = "token\t: fixture-decoded-canary";
  const rejected = ingest("ocr", { ...report, reviewer: value });
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain("secret-shaped value");
  expect(rejected.stderr).not.toContain("fixture-decoded-canary");
  expect(cli("export", "--to", "hub").status).toBe(1);
});

test("import refuses a report that claims an accepted finding", () => {
  const { cli, ingest, load } = exchangeFixture();
  const report = load("ocr");
  const findings = report.findings as Record<string, unknown>[];
  const rejected = ingest("ocr", { ...report, findings: [
    { ...findings[0], disposition: "accepted", rationale: "fixture rationale" },
  ] });
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain("accepted is the person's decision");
  expect(cli("export", "--to", "hub").status).toBe(1);
});

test("missing import files and invalid exchange usage have actionable exit codes", () => {
  const { cli } = exchangeFixture();
  const missing = cli("import", "--from", "ocr", "missing-report-canary.json");
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("Pass the path of a readable report file");
  expect(missing.stderr).not.toContain("missing-report-canary");
  for (const args of [["import", "--from"], ["import", "--from", "unknown", "report.json"],
    ["export", "--to", "unknown"], ["export", "--to", "hub", "--unknown"]]) {
    const result = cli(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`arev ${args[0]} --help`);
  }
});

test("import uses the packet ID to select the correct review thread", () => {
  const { dir, home, head, base, load, ingest } = exchangeFixture();
  for (const pr of [7, 8]) {
    const { packet } = isolatedPacket(dir, { kind: "range", base, head, pr });
    appendEvent(dir, { v: 1, type: "packet", at: "2026-11-26T00:00:00Z", packet }, { home });
  }
  const input = load("ocr");
  const { packet_id: originalPacketId, ...legacyReport } = input;
  if (typeof originalPacketId !== "string") throw new Error("missing fixture packet ID");
  const refused = ingest("ocr", legacyReport);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("Supply packet_id");
  expect(ingest("ocr", { ...legacyReport, packet_id: originalPacketId }).status).toBe(0);
  const recorded = readLedger(dir, { home }).at(-1);
  expect(recorded?.type).toBe("record");
  if (recorded?.type !== "record") throw new Error("missing record");
  expect(recorded.record.packet.id).toBe(originalPacketId);
  expect(recorded.record.packet.subject.pr).toBeUndefined();
});

test("denied finding paths are rejected after normalization, leaving the ledger unchanged", () => {
  const { dir, home, ingest, load } = exchangeFixture();
  const ledger = ledgerPath(dir, { home });
  const before = readFileSync(ledger);
  const report = load("ocr");
  const findings = report.findings as Record<string, unknown>[];
  for (const location of [{ path: " .env " }, { path: "./.env" }, { path: ".ENV" }, { path: ".ＥＮＶ" },
    { path: undefined, location: " ./private.key :1" }]) {
    const result = ingest("ocr", { ...report, findings: [{ ...findings[0], ...location }] });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/denied path|path is invalid or denied/);
    expect(readFileSync(ledger)).toEqual(before);
  }
});

test("compound credential keys in hub arguments are refused before they enter the ledger", () => {
  const { dir, home, ingest, load, cli } = exchangeFixture();
  const ledger = ledgerPath(dir, { home });
  const before = readFileSync(ledger);
  const report = load("hub");
  const hub = report.hub_review as Record<string, unknown>;
  for (const key of ["client_secret", "clientSecret", "private_key", "api key"]) {
    const rejected = ingest("hub", { ...report, hub_review: { ...hub, [key]: "dummy-canary-value" } });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("credential field");
    expect(rejected.stderr).not.toContain("dummy-canary-value");
    expect(readFileSync(ledger)).toEqual(before);
  }
  expect(cli("export", "--to", "hub").status).toBe(1);
});

test("ordinary author metadata is retained without triggering the credential screen", () => {
  const { dir, home, ingest, load } = exchangeFixture();
  expect(ingest("ocr", { ...load("ocr"), author: "fixture author" }).status).toBe(0);
  const event = readLedger(dir, { home }).at(-1);
  expect(event?.type === "record" && event.source?.report.author).toBe("fixture author");
});
