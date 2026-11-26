import { parseArgs } from "node:util";
import { PacketUsageError } from "./packet-cli.ts";
import { frame } from "./frame.ts";
import { assertSafeExchange } from "./import.ts";
import { readLedger, type LedgerEvent, type RecordFinding, type ReviewRecordV1 } from "./ledger.ts";
import { ledgerEventsView, type ReviewView } from "./record.ts";
import { commitOid } from "./review-git.ts";

type RecordEvent = Extract<LedgerEvent, { type: "record" }>;
type EffectiveFinding = ReviewView["findings"][number];

function hubFinding(finding: RecordFinding, effective?: EffectiveFinding) {
  const { id, term, severity, path, anchor, rationale, disposition, origin } = finding;
  return {
    id, pass: term, severity: severity === "blocking" ? "important" : "nit",
    disposition: effective?.disposition ?? disposition,
    ...(path === undefined ? {} : { path }),
    ...(anchor === undefined ? {} : { anchor }),
    ...((effective?.rationale ?? rationale) === undefined ? {} : { rationale: effective?.rationale ?? rationale }),
    ...(severity === "blocking" && term === "security" && origin !== "indeterminate" ? { origin } : {}),
  };
}

function exportHub(event: RecordEvent, events: LedgerEvent[], view: ReviewView): unknown {
  const { record, source } = event;
  const original = source?.format === "hub" ? source.report.hub_review : undefined;
  if (original && typeof original === "object" && !Array.isArray(original)) {
    const changes = events.slice(events.lastIndexOf(event) + 1).filter(item =>
      item.type === "resolve" && item.head === record.packet.subject.head && item.pr === record.packet.subject.pr);
    if (!changes.length) return original;
    const args = original as Record<string, unknown>;
    if (Array.isArray(args.findings)) {
      return { ...args, findings: args.findings.map(item => {
        const changed = changes.findLast(change => change.type === "resolve" && change.finding === item?.id);
        return changed?.type === "resolve" ? {
          ...item, disposition: changed.as,
          ...(changed.rationale === undefined ? {} : { rationale: changed.rationale }),
        } : item;
      }) };
    }
    return original;
  }

  const sourceNote = source?.report.note;
  const note = [
    ...(typeof sourceNote === "string" ? [sourceNote] : []),
    ...record.findings.map(finding => `${finding.id}: ${finding.text}`),
  ].join("\n") || `Review recorded for ${record.packet.subject.head}.`;
  const findings = record.findings.map(finding => hubFinding(finding,
    view.findings.find(effective => effective.id === finding.id)));
  return { verdict: record.verdict, note, coverage: record.coverage, findings };
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
  const usage = "Choose arev export --to hub|markdown [--head SHA].";
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], allowPositionals: true, tokens: true,
      options: { to: { type: "string" }, head: { type: "string" } } });
  } catch {
    throw new PacketUsageError(usage);
  }
  const { values, positionals, tokens } = parsed;
  const flags = tokens.filter(token => token.kind === "option").map(token => token.name);
  if ((values.to !== "hub" && values.to !== "markdown") || positionals.length !== 0 ||
      flags.length !== new Set(flags).size) {
    throw new PacketUsageError(usage);
  }
  const events = readLedger(cwd);
  const head = values.head === undefined ? undefined : commitOid(cwd, values.head);
  const view = ledgerEventsView(events, head);
  const event = events.findLast((item): item is RecordEvent =>
    item.type === "record" && item.id === view.record && item.record.packet.subject.head === view.head);
  if (!event) throw new Error("No review record matches the head. Import or record a review first.");
  if (values.to === "hub") {
    const output = exportHub(event, events, view);
    assertSafeExchange(output);
    console.log(JSON.stringify(output, null, 2));
  } else {
    assertSafeExchange({ reviewer: event.record.reviewer, call: event.record.call,
      coverage: event.record.coverage, findings: view.findings });
    console.log(renderMarkdown(event.record, view, event.source));
  }
}
