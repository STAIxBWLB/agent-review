import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";
import { parseArgs } from "node:util";
import { deniedReportPath, foldPathSegment } from "./deny.ts";
import { appendEvent, readLedger, recordId, Refusal, secretShaped, shown, type LedgerEvent, type ReviewSource } from "./ledger.ts";
import { PacketUsageError } from "./packet-cli.ts";
import { parseReviewRecord, requireCurrentPacket } from "./record.ts";

type Row = Record<string, unknown>;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_SOURCE_BYTES = 128 * 1024;
const SENSITIVE_KEY = /secret|password|passwd|token|apikey|privatekey|credential|authorization|oauth|^auth$/;
const credentialKey = (key: string) => SENSITIVE_KEY.test(foldPathSegment(key).replace(/[_-]/g, ""));

function invalid(message: string): never {
  throw new Refusal(shown(message), "correct the input report and run arev import again");
}

function requireRow(raw: unknown, field: string): Row {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(`${field} must be a JSON object`);
  return raw as Row;
}

function requireRows(raw: unknown, field: string): unknown[] {
  if (!Array.isArray(raw)) invalid(`${field} must be an array`);
  return raw;
}

export function assertSafeExchange(value: unknown): void {
  const pending = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (secretShaped(item) || deniedReportPath(item)) {
        throw new Error("The review exchange contains a denied path or secret-shaped value. Remove it before exchanging the report.");
      }
    } else if (item && typeof item === "object") {
      for (const [key, entry] of Object.entries(item)) {
        if (credentialKey(key) && entry != null && entry !== "") {
          throw new Error("The review exchange contains a credential field. Remove it before exchanging the report.");
        }
        pending.push(key, entry);
      }
    }
  }
}

/** The brief host asks for prose. Import a findings section with explicit JSON review metadata above it. */
function markdownBrief(metadata: Row, markdown: string): Row {
  for (const field of ["head", "base"] as const) {
    const label = new RegExp(`^\\s*(?:[-*] +)?(?:\\*\\*)?${field}(?:\\*\\*)?:(?:\\*\\*)?\\s*` + "`?([a-f0-9]{40,64})", "im");
    const reported = label.exec(markdown)?.[1];
    if (reported !== undefined && reported !== metadata[field]) invalid(`The Markdown ${field} differs from its metadata`);
  }
  const section = /^(#{1,6})[ 	]+Findings\b.*$/im.exec(markdown);
  if (!section) invalid("A Markdown brief needs a Findings heading");
  const body = markdown.slice(section.index + section[0].length);
  const following = new RegExp(`^#{1,${section[1]!.length}}[ \t]+`, "m").exec(body);
  const lines = body.slice(0, following?.index ?? body.length);
  const rows = [...lines.matchAll(/^[ \t]*(?:[-*] +)?(?:\*\*)?(P[0-3])(?:[.:)]|[ \t])+[ \t]*(?:\*\*)?[ \t]*(.+)$/gm)];
  if (!rows.length) invalid("The Findings section has no P0-P3 entries; list findings explicitly or mark each priority None");
  const empty = new Set<string>();
  const findings = rows.flatMap((row, index) => {
    const priority = row[1]!;
    const title = row[2]!.replace(/\*\*/g, "").trim();
    if (/^none[.!]?$/i.test(title)) { empty.add(priority); return []; }
    const block = lines.slice(row.index ?? 0, rows[index + 1]?.index ?? lines.length).trim();
    const location = /`([^\n`]+:\d+(?:-\d+)?)`/.exec(block)?.[1] ??
      /(?:^|[\s(])([A-Za-z_./][A-Za-z0-9_./-]*:\d+(?:-\d+)?)(?=[\s,.):]|$)/.exec(block)?.[1];
    const id = /\bid:[ \t]*`?([A-Za-z0-9._:-]+)/i.exec(block)?.[1];
    const disposition = /\bdisposition:[ \t]*`?(open|fixed|false_positive|accepted)\b/i.exec(block)?.[1];
    const origin = /\borigin:[ \t]*`?(introduced|pre[-_]existing|indeterminate)\b/i.exec(block)?.[1];
    const category = /\bcategory:[ \t]*`?(bug|security|compliance)\b/i.exec(block)?.[1];
    const rationale = /^rationale:[ \t]*(.+)$/im.exec(block)?.[1];
    const evidence = [...block.matchAll(/^evidence:[ \t]*(.+)$/gim)].map(match => match[1]!);
    return [{ priority, title, text: block, location, id, category: category?.toLowerCase(),
      disposition: disposition?.toLowerCase(), origin: origin?.toLowerCase(), rationale,
      ...(evidence.length ? { evidence } : {}) }];
  });
  if (!findings.length && empty.size !== 4) invalid("Mark all four priorities None to import a finding-free Markdown brief");
  if (metadata.hub_review !== undefined) invalid("Use a JSON report to import hub_review arguments");
  return { ...metadata, findings, markdown };
}

function readReport(path: string, format: "ocr" | "brief"): Row {
  let text: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) invalid("The import report must be a regular file");
    if (stat.size > MAX_SOURCE_BYTES) invalid("The import report exceeds 128 KiB");
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Error("Cannot read the import report. Pass the path of a readable report file.");
  }
  if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) invalid("The import report exceeds 128 KiB");
  if (secretShaped(text)) invalid("The import report matches a secret pattern. Remove the value and retry.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    const preface = format === "brief" && /^`{3}json[ \t]*\r?\n([\s\S]+?)\r?\n`{3}[ \t]*\r?\n/.exec(text);
    if (!preface) invalid("Use JSON or, for a Markdown brief, start the file with a fenced JSON metadata block");
    try { value = JSON.parse(preface[1]!); }
    catch { invalid("The Markdown brief metadata is not valid JSON"); }
    value = markdownBrief(requireRow(value, "brief metadata"), text.slice(preface[0].length));
  }
  const report = requireRow(value, "report");
  assertSafeExchange(report);
  return report;
}

const severities = {
  critical: "blocking", high: "blocking", medium: "advisory", low: "advisory",
  P0: "blocking", P1: "blocking", P2: "advisory", P3: "advisory",
  important: "blocking", nit: "advisory",
} as const;

function mapFinding(raw: unknown, format: ReviewSource["format"]): Row {
  const item = requireRow(raw, "finding");
  const sourceSeverity = item.severity ?? item.priority ?? (format === "ocr" ? "high" : undefined);
  if (typeof sourceSeverity !== "string" || !Object.hasOwn(severities, sourceSeverity)) {
    invalid("A finding has an unrecognized severity");
  }
  const severity = severities[sourceSeverity as keyof typeof severities];
  const allowedSeverity = format === "ocr" ? /^(critical|high|medium|low)$/ :
    format === "brief" ? /^P[0-3]$/ : /^(important|nit)$/;
  if (!allowedSeverity.test(sourceSeverity)) invalid("A finding's severity does not match its input format");

  const term = item.term ?? item.pass ?? ({
    bug: "bugs", security: "security",
  } as Record<string, string>)[typeof item.category === "string" ? item.category : ""] ?? "compliance";
  const location = typeof item.location === "string" ? /^(.*):(\d+)(?:-(\d+))?$/.exec(item.location) : null;
  const rawPath = item.path ?? location?.[1];
  const path = typeof rawPath === "string" ? rawPath.trim() : rawPath;
  const line = item.start_line ?? item.line ?? (location ? Number(location[2]) : undefined);
  const end = item.end_line ?? (location?.[3] ? Number(location[3]) : line);
  const text = item.text ?? item.content ?? item.title ?? item.description ??
    (format === "hub" ? item.rationale ?? item.id : undefined);
  if (typeof text !== "string" || !text.trim()) invalid("A finding needs a description");
  if (path !== undefined && (typeof path !== "string" || !path || deniedReportPath(path) ||
      posix.isAbsolute(path) || win32.isAbsolute(path) || path.split("/").includes(".."))) {
    invalid("A finding path is invalid or denied");
  }
  if (line !== undefined && typeof path !== "string") invalid("A finding with a line number needs a repository-relative path");
  const anchor = item.anchor ?? (line === undefined ? undefined : {
    path, side: "head", selectors: [{ kind: "lineRange", startLine: line, endLine: end }],
  });
  const origin = typeof item.origin === "string" ? item.origin.replaceAll("-", "_") : "indeterminate";
  const disposition = item.disposition ?? "open";
  const id = item.id ?? `${term}:${createHash("sha256").update(JSON.stringify([path ?? "", item.title ?? text])).digest("hex").slice(0, 24)}`;
  return {
    id, term, severity, text, origin, disposition,
    ...(path === undefined ? {} : { path }),
    ...(anchor === undefined ? {} : { anchor }),
    ...(item.rationale === undefined ? {} : { rationale: item.rationale }),
    ...(item.evidence === undefined ? {} : { evidence: typeof item.evidence === "string" ? [item.evidence] : item.evidence }),
  };
}

function coverageOf(report: Row): unknown {
  if (report.coverage !== undefined && !Array.isArray(report.coverage)) return report.coverage;
  const files = report.files ?? report.coverage;
  if (Array.isArray(files)) {
    const reviewed: unknown[] = [], skipped: unknown[] = [];
    for (const entry of files) {
      const file = requireRow(entry, "coverage file");
      if (file.status === "reviewed" || file.reviewed === true) reviewed.push(file.path);
      else if (file.status === "skipped" || file.reviewed === false) skipped.push({ path: file.path, reason: file.reason });
      else invalid("A coverage file must be explicitly reviewed or skipped");
    }
    return { reviewed, skipped };
  }
  return { reviewed: report.reviewed_files, skipped: report.skipped_files };
}

export function importCommand(cwd: string, args: readonly string[]): void {
  const usage = "Specify one report with arev import --from ocr|brief <file>.";
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], allowPositionals: true, tokens: true, options: { from: { type: "string" } } });
  } catch {
    throw new PacketUsageError(usage);
  }
  const { values, positionals, tokens } = parsed;
  if ((values.from !== "ocr" && values.from !== "brief") || positionals.length !== 1 ||
      tokens.filter(token => token.kind === "option" && token.name === "from").length !== 1) {
    throw new PacketUsageError(usage);
  }
  const file = positionals[0]!;
  const report = readReport(resolve(cwd, file), values.from);
  const hub = values.from === "brief" && report.hub_review !== undefined
    ? requireRow(report.hub_review, "hub_review") : undefined;
  const format = hub ? "hub" : values.from;
  const head = report.head ?? report.head_commit, base = report.base ?? report.base_commit;
  if (hub && hub.verdict === undefined) invalid("hub_review needs its original verdict");
  if ((report.head !== undefined && report.head_commit !== undefined && report.head !== report.head_commit) ||
      (report.base !== undefined && report.base_commit !== undefined && report.base !== report.base_commit)) {
    invalid("The report has conflicting Git subject fields");
  }
  if (typeof head !== "string" || !SHA.test(head) || typeof base !== "string" || !SHA.test(base)) {
    invalid("The report needs its own full head and base Git object IDs");
  }
  if (hub?.head !== undefined && hub.head !== head) invalid("The hub_review head differs from the report head");
  const events = readLedger(cwd);
  let packetId = report.packet_id;
  if (packetId === undefined) {
    const candidates = events.filter((event): event is Extract<LedgerEvent, { type: "packet" }> =>
      event.type === "packet" &&
      event.packet.subject.head === head && event.packet.subject.base === base);
    const threads = new Set(candidates.map(event => event.packet.subject.pr));
    if (threads.size > 1) invalid("More than one PR shares this head and base. Supply packet_id from the reviewed packet.");
    packetId = candidates.at(-1)?.packet.id;
    if (packetId === undefined) invalid("No packet for the report's head and base is in the ledger. Run arev packet for that subject.");
  }
  if (typeof packetId !== "string" || !/^[a-f0-9]{64}$/.test(packetId)) invalid("The report packet_id must be the SHA-256 from packet.json");
  const event = requireCurrentPacket(cwd, head, packetId, events);
  if (event.packet.subject.base !== base) invalid("The report base differs from the packet base");

  const input = hub ?? report;
  const findings = requireRows(input.findings ?? (format === "ocr" ? input.comments : undefined) ?? (hub ? [] : undefined),
    "findings").map(finding => mapFinding(finding, format));
  const call = report.call ?? (hub ? { ok: true } : undefined);
  const verdict = input.verdict ?? (
    findings.some(finding => finding.severity === "blocking" && finding.disposition === "open") ||
    requireRow(call, "call").ok !== true ? "changes_requested" : "approved"
  );
  const reviewer = typeof report.reviewer === "string"
    ? { id: report.reviewer, modelFamily: report.modelFamily, ...(report.model === undefined ? {} : { model: report.model }) }
    : requireRow(report.reviewer, "reviewer");
  const record = parseReviewRecord({
    v: 1, packet: event.packet, findings, verdict, call,
    coverage: coverageOf(input),
    reviewer: {
      started: "manual",
      sameFamilyFallback: false,
      ...reviewer,
    },
  }, {
    packet: event.packet, maxAdvisories: event.review?.advisory_cap,
    retryCommand: `arev import --from ${values.from} '${shown(file).replaceAll("'", "'\\''")}'`,
  });
  const id = recordId(record);
  appendEvent(cwd, { v: 1, type: "record", at: new Date().toISOString(), id, record,
    source: { format, report } });
  console.log(`Imported review ${id} for head ${head}.`);
}
