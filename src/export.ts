import { parseArgs } from "node:util";
import { PacketUsageError } from "./packet-cli.ts";
import { frame } from "./frame.ts";
import { assertSafeExchange } from "./import.ts";
import { readLedger, type LedgerEvent, type ReviewRecordV1 } from "./ledger.ts";
import { PR_NUMBER, ledgerEventsView, type ReviewView, type ThreadSelector } from "./record.ts";
import { commitOid } from "./review-git.ts";

type RecordEvent = Extract<LedgerEvent, { type: "record" }>;
type EffectiveFinding = ReviewView["findings"][number];

const HUB_TEXT_MAX = 2048;
const HUB_FINDINGS_MAX = 64 * 1024;
const HUB_TEXT_MARKER = " [...]";
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** Cut a framed rationale on a UTF-8 boundary, keeping the marker on the last quoted line. */
function truncateFramed(text: string, limit: number, measure: (value: string) => number): string {
  const body = text.endsWith(HUB_TEXT_MARKER) ? text.slice(0, -HUB_TEXT_MARKER.length) : text;
  const chars = [...body];
  const marked = (length: number) => `${chars.slice(0, length).join("").trimEnd() || ">"}${HUB_TEXT_MARKER}`;
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const middle = Math.ceil((lo + hi) / 2);
    if (measure(marked(middle)) <= limit) lo = middle;
    else hi = middle - 1;
  }
  return marked(lo);
}

function framedRationale(body: string): string {
  const framed = frame(body);
  return Buffer.byteLength(framed) <= HUB_TEXT_MAX ? framed : truncateFramed(framed, HUB_TEXT_MAX, Buffer.byteLength);
}

type FilledRationale = { rationale: string };

/** Apply the Hub's compact JSON cap by trimming only rationales filled during this export. */
function boundHubFindings<T>(findings: T[], filled: FilledRationale[]): T[] {
  let excess = jsonBytes(findings) - HUB_FINDINGS_MAX;
  if (excess <= 0) return findings;
  const longestFirst = filled.map(finding => ({ finding, size: jsonBytes(finding.rationale) }))
    .sort((a, b) => b.size - a.size);
  for (const { finding, size } of longestFirst) {
    const shortened = truncateFramed(finding.rationale, size - excess, jsonBytes);
    const saved = size - jsonBytes(shortened);
    if (saved <= 0) continue;
    finding.rationale = shortened;
    excess -= saved;
    if (excess <= 0) return findings;
  }
  throw new Error("Hub findings exceed 64 KiB after trimming generated rationales. Shorten the authored finding text or export a narrower review.");
}

/**
 * One finding as a hub argument. A hub argument has no field for the description, and `rationale` is where the hub reads
 * one, so that is the field this fills: OCR and brief imports store the description in `text` alone, and a finding
 * carried forward from an earlier review has no matching original hub argument to take words from. Dropping `text` here
 * exported such a finding with its id, path and disposition and nothing said about it.
 *
 * A rationale already on the finding is left exactly as it is, and the substitution is framed because the hub reads that
 * field as untrusted text, within that field's bound.
 */
function hubFinding(finding: EffectiveFinding, filled: FilledRationale[]) {
  const { text, evidence: _evidence, ...args } = finding;
  if (finding.rationale !== undefined || text === undefined) return args;
  const generated = { ...args, rationale: framedRationale(text) };
  filled.push(generated);
  return generated;
}

function exportHub(event: RecordEvent, view: ReviewView): unknown {
  const { record, source } = event;
  const filled: FilledRationale[] = [];
  const original = source?.format === "hub" ? source.report.hub_review : undefined;
  if (original && typeof original === "object" && !Array.isArray(original)) {
    const args = original as Record<string, unknown>;
    if (!Array.isArray(args.findings) && view.findings.length === 0) return original;
    const originalFindings = new Map((Array.isArray(args.findings) ? args.findings : []).map(item => [item?.id, item]));
    const baseline = new Map(record.findings.map(finding => [finding.id, finding]));
    const findings = view.findings.map(current => {
      const item = originalFindings.get(current.id);
      const previous = baseline.get(current.id);
      if (!item || !previous) return hubFinding(current, filled);
      return {
        ...item,
        ...(previous.term === current.pass ? {} : { pass: current.pass }),
        ...((previous.severity === "blocking" ? "important" : "nit") === current.severity ? {} : { severity: current.severity }),
        ...(previous.disposition === current.disposition ? {} : { disposition: current.disposition }),
        ...(previous.rationale === current.rationale ? {} : { rationale: current.rationale }),
      };
    });
    return { ...args, findings: boundHubFindings(findings, filled) };
  }

  const sourceNote = source?.report.note;
  const note = [
    ...(typeof sourceNote === "string" ? [sourceNote] : []),
    ...view.findings.flatMap(finding => finding.text === undefined ? [] : [`${finding.id}: ${finding.text}`]),
  ].join("\n") || `Review recorded for ${record.packet.subject.head}.`;
  const findings = view.findings.map(finding => hubFinding(finding, filled));
  return { verdict: record.verdict, note, coverage: record.coverage, findings: boundHubFindings(findings, filled) };
}

function renderFinding(finding: EffectiveFinding): string {
  const line = finding.anchor?.selectors.find(selector => selector.kind === "lineRange");
  const path = finding.path ?? finding.anchor?.path;
  const location = path && line ? `${path}:${line.startLine}${line.endLine === line.startLine ? "" : `-${line.endLine}`}` : path;
  return frame([
    `${finding.id} (${finding.pass}, ${finding.severity === "important" ? "blocking" : "advisory"}, ${finding.disposition})`,
    location,
    finding.text,
    finding.rationale,
    ...(finding.evidence ?? []),
  ].filter(Boolean).join("\n"));
}

function renderMarkdown(record: ReviewRecordV1, view: ReviewView, source?: RecordEvent["source"]): string {
  const subject = record.packet.subject;
  return [
    "# Review record",
    frame([
      `Head: ${subject.head}`,
      `Base: ${subject.base ?? "unavailable"}`,
      `Merge base: ${subject.mergeBase ?? "unavailable"}`,
      `Packet: ${record.packet.id}`,
      `Record: ${view.record ?? "unavailable"}`,
      `Reviewer: ${record.reviewer.id} (${record.reviewer.model ?? record.reviewer.modelFamily})`,
      `Verdict: ${record.verdict}`,
      `Call: ${record.call.ok ? "succeeded" : "failed"}`,
      ...(record.call.error ? [record.call.error] : []),
      ...(record.light ? ["Mode: light"] : []),
      ...(source ? [`Imported from: ${source.format}`] : []),
    ].join("\n")),
    "## Coverage",
    frame([
      ...record.coverage.reviewed.map(path => `Reviewed: ${path}`),
      ...record.coverage.skipped.map(({ path, reason }) => `Skipped: ${path} (${reason})`),
    ].join("\n") || "No paths recorded."),
    "## Findings",
    ...(view.findings.length ? view.findings.map(renderFinding) : ["> No findings recorded."]),
  ].join("\n\n");
}

export function exportCommand(cwd: string, args: readonly string[]): void {
  const usage = "Choose arev export --to hub|markdown [--head SHA] [--pr N|none].";
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], allowPositionals: true, tokens: true,
      options: { to: { type: "string" }, head: { type: "string" }, pr: { type: "string" } } });
  } catch {
    throw new PacketUsageError(usage);
  }
  const { values, positionals, tokens } = parsed;
  const flags = tokens.filter(token => token.kind === "option").map(token => token.name);
  if ((values.to !== "hub" && values.to !== "markdown") || positionals.length !== 0 ||
      flags.length !== new Set(flags).size) {
    throw new PacketUsageError(usage);
  }
  const pr = values.pr;
  if (pr !== undefined && pr !== "none" && (!PR_NUMBER.test(pr) || !Number.isSafeInteger(Number(pr)))) {
    throw new PacketUsageError("Pass a positive integer to --pr, or none for a review with no PR.");
  }
  const thread: ThreadSelector | undefined = pr === undefined || pr === "none" ? pr : Number(pr);
  const events = readLedger(cwd);
  const head = values.head === undefined ? undefined : commitOid(cwd, values.head);
  const view = ledgerEventsView(events, head, thread, { includeSettled: true });
  const event = events.findLast((item): item is RecordEvent =>
    item.type === "record" && item.id === view.record && item.record.packet.subject.head === view.head);
  if (!event) throw new Error("No review record matches the head. Import or record a review first.");
  if (values.to === "hub") {
    const output = exportHub(event, view);
    assertSafeExchange(output);
    console.log(JSON.stringify(output, null, 2));
  } else {
    assertSafeExchange({ reviewer: event.record.reviewer, call: event.record.call,
      coverage: event.record.coverage, findings: view.findings });
    console.log(renderMarkdown(event.record, view, event.source));
  }
}
