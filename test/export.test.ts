import { expect, test } from "bun:test";
import { appendEvent } from "../src/ledger.ts";
import { parseReviewFindings } from "../src/findings.ts";
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

for (const [initial, disposition] of [["open", "fixed"], ["fixed", "false_positive"]] as const) {
  test(`hub export applies a later same-PR ${disposition} to an earlier ${initial} finding`, () => {
    const { dir, home, cli, ingest, load, git, write, base, head } = exchangeFixture();
    const savePacket = (head: string) => {
      const { packet } = isolatedPacket(dir, { kind: "range", base, head, pr: 7 });
      appendEvent(dir, { v: 1, type: "packet", at: "2026-11-26T00:00:00Z", packet }, { home });
      return packet.id;
    };
    const report = load("hub");
    const hub = report.hub_review as { findings: ({ id: string } & Record<string, unknown>)[] };
    const original = { ...hub, verdict: "changes_requested",
      findings: hub.findings.map(finding => ({ ...finding, severity: "important", disposition: initial })) };
    expect(ingest("hub", { ...report, packet_id: savePacket(head), hub_review: original }).status).toBe(0);
    expect(JSON.parse(cli("export", "--to", "hub", "--head", head).stdout)).toEqual(original);
    write("src/rules.ts", "rule 5\n");
    git("commit", "-qam", "later head");
    const later = git("rev-parse", "HEAD").trim();
    savePacket(later);
    const resolved = cli("resolve", String(original.findings[0]?.id), "--as", disposition, "--head", later, "--pr", "7",
      ...(disposition === "false_positive" ? ["--evidence", "src/rules.ts:1"] : []));
    expect(resolved.status).toBe(0);

    const shown = cli("show", "--head", head, "--pr", "7", "--json");
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).openBlocking).toEqual([]);
    const exported = cli("export", "--to", "hub", "--head", head);
    expect(exported.status).toBe(0);
    expect(JSON.parse(exported.stdout).findings[0].disposition).toBe(disposition);
    const markdown = cli("export", "--to", "markdown", "--head", head, "--pr", "7");
    expect(markdown.status).toBe(0);
    expect(markdown.stdout).toContain(`(compliance, blocking, ${disposition})`);
    expect(markdown.stdout).toContain(String(original.findings[0]?.id));
    if (initial === "fixed") expect(JSON.parse(shown.stdout).findings[0].disposition).toBe(disposition);
  });
}

test("export selects numbered and no-PR records independently at a shared head", () => {
  const { dir, home, cli, ingest, load, base, head } = exchangeFixture();
  const report = load("hub");
  const hub = report.hub_review as Record<string, unknown>;
  const noPr = { ...hub, note: "no-PR review fixture" };
  const seven = { ...hub, note: "PR 7 review fixture" };
  expect(ingest("hub", { ...report, hub_review: noPr }).status).toBe(0);
  const { packet } = isolatedPacket(dir, { kind: "range", base, head, pr: 7 });
  appendEvent(dir, { v: 1, type: "packet", at: "2026-11-26T00:00:00Z", packet }, { home });
  expect(ingest("hub", { ...report, hub_review: seven, packet_id: packet.id }).status).toBe(0);

  const ambiguous = cli("export", "--to", "hub", "--head", head);
  expect(ambiguous.status).toBe(1);
  expect(ambiguous.stderr).toContain("--pr 7");
  for (const [selector, expected] of [["none", noPr], ["7", seven]] as const) {
    const result = cli("export", "--to", "hub", "--head", head, "--pr", selector);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
  }
});

test("hub export carries an earlier blocking finding into a later review with an empty finding list", () => {
  const { dir, home, cli, ingest, load, git, write, base, head } = exchangeFixture();
  const savePacket = (head: string) => {
    const { packet } = isolatedPacket(dir, { kind: "range", base, head, pr: 7 });
    appendEvent(dir, { v: 1, type: "packet", at: "2026-11-26T00:00:00Z", packet }, { home });
    return packet.id;
  };
  const report = load("hub");
  const hub = report.hub_review as Record<string, unknown>;
  const carried = { id: "bugs:carried", pass: "bugs", severity: "important", disposition: "open",
    path: "src/rules.ts", rationale: "Missing rule validation." };
  expect(ingest("hub", { ...report, packet_id: savePacket(head),
    hub_review: { ...hub, verdict: "changes_requested", findings: [carried] } }).status).toBe(0);

  write("src/rules.ts", "later rule text\n");
  git("commit", "-qam", "later head");
  const later = git("rev-parse", "HEAD").trim();
  const packetId = savePacket(later);
  const laterArgs = { ...hub, note: "Later review", findings: [] };
  expect(ingest("hub", { ...report, head: later, packet_id: packetId, hub_review: laterArgs }).status).toBe(0);
  const shown = cli("show", "--head", later, "--pr", "7", "--json");
  expect(JSON.parse(shown.stdout).openBlocking).toEqual(["bugs:carried"]);
  const output = cli("export", "--to", "hub", "--head", later, "--pr", "7");
  expect(output.status).toBe(0);
  expect(JSON.parse(output.stdout)).toEqual({ ...laterArgs, findings: [carried] });

  const plainReport = { v: 1, packet: { id: packetId, subject: { head: later } },
    reviewer: { id: "fixture-reviewer", modelFamily: "fixture-family", started: "manual", sameFamilyFallback: false },
    coverage: hub.coverage, findings: [], verdict: "approved", call: { ok: true } };
  write("native-report.json", JSON.stringify(plainReport));
  expect(cli("record", "native-report.json").status).toBe(0);
  const native = cli("export", "--to", "hub", "--head", later, "--pr", "7");
  expect(native.status).toBe(0);
  expect(JSON.parse(native.stdout).findings).toEqual([carried]);
});

test("hub export gives a carried OCR finding its text as the rationale it has none of", () => {
  const { dir, home, cli, ingest, load, git, write, base, head } = exchangeFixture();
  const savePacket = (head: string) => {
    const { packet } = isolatedPacket(dir, { kind: "range", base, head, pr: 7 });
    appendEvent(dir, { v: 1, type: "packet", at: "2026-11-26T00:00:00Z", packet }, { home });
    return packet.id;
  };
  // An OCR review at the first head in PR 7, with a blocking finding left open. An OCR import stores the description in
  // `text` alone - the fixture report has no rationale field - which is the shape that lost its words on the way out.
  const ocr = load("ocr");
  const findings = ocr.findings as Record<string, unknown>[];
  expect(findings[0]?.rationale).toBeUndefined();
  const blocking = { ...findings[0], severity: "high", disposition: "open" };
  expect(ingest("ocr", { ...ocr, packet_id: savePacket(head), findings: [blocking] }).status).toBe(0);

  write("src/rules.ts", "later rule text\n");
  git("commit", "-qam", "later head");
  const later = git("rev-parse", "HEAD").trim();
  const packetId = savePacket(later);
  const report = load("hub");
  const hub = report.hub_review as Record<string, unknown>;
  expect(ingest("hub", { ...report, head: later, packet_id: packetId,
    hub_review: { ...hub, verdict: "changes_requested", findings: [] } }).status).toBe(0);

  // The later record has no finding of its own, so every finding exported here is carried: there is no original hub
  // argument to keep the OCR text in, and the rationale is the only field a hub finding has for a description.
  const exported = cli("export", "--to", "hub", "--head", later, "--pr", "7");
  expect(exported.status).toBe(0);
  const [carried] = JSON.parse(exported.stdout).findings as Record<string, unknown>[];
  expect(carried).toMatchObject({ id: "bugs:empty-rules-cache", pass: "bugs", severity: "important", disposition: "open",
    rationale: "> Handle an empty result before caching it." });
  expect(Object.hasOwn(carried!, "text")).toBe(false);
});

// A record accepts a description up to 2048 bytes, and the hub accepts a rationale up to 2048 bytes, both counted in UTF-8
// bytes. Framing spends 2 bytes on every line, so those two bounds are not the same input: these are the descriptions the
// record takes whole and the hub would refuse whole, and the one that fits the hub's bound only after framing.
for (const [label, description, cut] of [
  ["one line at the record's bound", "a".repeat(2048), true],
  ["a cut exactly after a newline", `${"a".repeat(2039)}\n${"b".repeat(7)}`, true],
  ["ten lines just past it once framed", Array.from({ length: 10 }, () => "a".repeat(203)).join("\n"), true],
  ["one multibyte line at the record's bound", `x${"한".repeat(682)}`, true],
  ["one line framed to exactly the bound", "b".repeat(2046), false],
] as const) {
  test(`hub export keeps a carried ${label} inside the hub's rationale bound`, () => {
    const { dir, home, cli, ingest, load, git, write, base, head } = exchangeFixture();
    const savePacket = (head: string) => {
      const { packet } = isolatedPacket(dir, { kind: "range", base, head, pr: 7 });
      appendEvent(dir, { v: 1, type: "packet", at: "2026-11-26T00:00:00Z", packet }, { home });
      return packet.id;
    };
    expect(Buffer.byteLength(description)).toBeLessThanOrEqual(2048);
    const ocr = load("ocr");
    const findings = ocr.findings as Record<string, unknown>[];
    expect(ingest("ocr", { ...ocr, packet_id: savePacket(head),
      findings: [{ ...findings[0], content: description, severity: "high", disposition: "open" }] }).status).toBe(0);

    write("src/rules.ts", "later rule text\n");
    git("commit", "-qam", "later head");
    const later = git("rev-parse", "HEAD").trim();
    const report = load("hub");
    const hub = report.hub_review as Record<string, unknown>;
    expect(ingest("hub", { ...report, head: later, packet_id: savePacket(later),
      hub_review: { ...hub, verdict: "changes_requested", findings: [] } }).status).toBe(0);

    const exported = cli("export", "--to", "hub", "--head", later, "--pr", "7");
    expect(exported.status).toBe(0);
    const exportedFindings = JSON.parse(exported.stdout).findings;
    const [carried] = exportedFindings as { rationale: string }[];
    expect(Buffer.byteLength(carried!.rationale)).toBeLessThanOrEqual(2048);
    if (cut) expect(carried!.rationale.endsWith(" [...]")).toBe(true);
    // This one fits the bound only as a framed line, so the whole description has to survive it.
    else expect(carried!.rationale).toBe(`> ${description}`);
    // The cut lands mid-line, so the check that it is a framed line is that the prefix survives it.
    for (const line of carried!.rationale.split("\n")) expect(line.startsWith("> ")).toBe(true);
    // A cut counted in bytes has to land on a character boundary, or the last character is half of itself.
    expect(Buffer.from(carried!.rationale, "utf8").toString("utf8")).toBe(carried!.rationale);
    // The bound is the hub's, so the export is round-tripped through the hub's own parser rather than measured alone.
    expect(parseReviewFindings(exportedFindings, { person: false, maxNits: 5 })[0]?.rationale).toBe(carried!.rationale);
  });
}

test("hub export bounds the entire findings array without changing authored rationale or finding identity", () => {
  const { base, head, cli, write } = exchangeFixture();
  const packet = JSON.parse(cli("packet", "--from", base, "--to", head, "--json").stdout);
  const findings = Array.from({ length: 32 }, (_, index) => ({
    id: `bugs:aggregate-${index}`, term: "bugs", severity: "blocking", disposition: "open",
    origin: "introduced", path: "src/rules.ts",
    text: Array.from({ length: index === 31 ? 390 : 400 }, () => "a").join("\n"),
  }));
  const authored = { ...findings[0]!, id: "bugs:authored", rationale: "Keep the reviewer rationale." };
  write("native-report.json", JSON.stringify({
    v: 1, packet,
    reviewer: { id: "fixture-reviewer", modelFamily: "fixture-family", started: "manual", sameFamilyFallback: false },
    coverage: { reviewed: ["src/rules.ts"], skipped: [] },
    findings: [...findings, authored], verdict: "changes_requested", call: { ok: true },
  }));
  expect(cli("record", "native-report.json").status).toBe(0);
  const result = cli("export", "--to", "hub");
  expect(result.status, result.stderr).toBe(0);
  const exported = JSON.parse(result.stdout).findings;
  expect(Buffer.byteLength(JSON.stringify(exported))).toBeLessThanOrEqual(64 * 1024);
  const parsed = parseReviewFindings(exported, { person: false, maxNits: 5 });
  expect(parsed.map(({ id, pass, path, severity, disposition }) => ({ id, pass, path, severity, disposition })))
    .toEqual([...findings, authored].map(({ id, path }) => ({ id, path, pass: "bugs", severity: "important", disposition: "open" })));
  expect(parsed.at(-1)?.rationale).toBe(authored.rationale);
  expect(parsed[0]?.rationale?.endsWith(" [...]")).toBe(true);
  expect(parsed[31]?.rationale).toBe(Array.from({ length: 390 }, () => "> a").join("\n"));
});
