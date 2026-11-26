/**
 * `ReviewRecordV1` (spec #1, Contract) — the report a reviewer records for one packet — its validation (AC3), and the
 * three commands that read and append records: `arev record`, `arev resolve`, `arev show`.
 *
 * The record's `packet` is the packet arev built and put in the ledger for that head, not the copy the report carries:
 * the report's copy is a claim, checked by `id` and `subject.head`, so a packet shape change never has to be re-ported
 * here. `arev show` replays the ledger through the ported finding lifecycle (`src/findings.ts`), which is what carries
 * an unresolved blocking finding to later heads and settles it once an explicit disposition names it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { types } from "node:util";
import { EXIT, errorLine } from "@staix/cli-output";
import { parseReviewAnchor, reviewAnchorErrorMessage, type ReviewAnchor } from "./anchor.ts";
import { blocksApproval, findingTally, findingsForHead, positionalFindingId, type ReviewFinding, type ReviewFindingSet, type ReviewFindingTally } from "./findings.ts";
import { sanitize } from "./frame.ts";
import { Refusal, appendEvent, readLedger, recordId, reviewProjectId, secretShaped, type LedgerEvent, type PacketBlock, type RecordFinding, type ReviewRecordV1 } from "./ledger.ts";
import { buildPacket, type PacketRequest } from "./packet.ts";

/** The spec's default advisory cap; a packet event may carry REVIEW.md's value as `review.advisory_cap`. */
export const DEFAULT_MAX_ADVISORIES = 5;
const MAX_REPORT_BYTES = 1024 * 1024, MAX_FINDINGS = 64, MAX_FINDING_BYTES = 64 * 1024;
const MAX_ID = 96, MAX_PATH = 512, MAX_TEXT = 2048, MAX_REF = 512, MAX_NAME = 128, MAX_FAMILY = 64, MAX_EVIDENCE = 16;
const TERMS = ["bugs", "security", "compliance"] as const, SEVERITIES = ["blocking", "advisory"] as const;
const DISPOSITIONS = ["open", "fixed", "false_positive", "accepted"] as const, ORIGINS = ["introduced", "pre_existing", "indeterminate"] as const;
const FINDING_FIELDS = ["id", "term", "severity", "path", "anchor", "text", "disposition", "rationale", "origin", "evidence"];
const RECORD_FIELDS = ["v", "packet", "reviewer", "coverage", "findings", "verdict", "call"];

function refuse(message: string, next: string): never {
  throw new Refusal(message, next);
}

const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
/** The JSON type of a report value: what a refusal says when it may not say the value itself. */
const jsonType = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
/**
 * The only report text a refusal echoes: a plain identifier in the finding-id charset that matches no secret pattern. A
 * report is untrusted data and stderr is output, so any other value is named by its type instead (AGENTS.md: never
 * write a secret value to output).
 */
const echoName = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,96}$/.test(value) && !secretShaped(value) ? value : jsonType(value);

/** A plain own-data object with only the named fields: accessors, proxies, hidden fields and inherited keys are refused. */
function closed(raw: unknown, fields: readonly string[], what: string): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || types.isProxy(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Object.getOwnPropertySymbols(raw).length) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.values(descriptors).some(field => !Object.hasOwn(field, "value") || !field.enumerable)) return undefined;
  if (Object.keys(descriptors).some(key => !fields.includes(key))) {
    refuse(`${what} has an unknown field (${Object.keys(descriptors).filter(key => !fields.includes(key)).map(echoName).join(", ")})`,
      `use only: ${fields.join(", ")}`);
  }
  return raw as Record<string, unknown>;
}

/** A dense own-data array within `max` entries. */
function rows(raw: unknown, max: number): unknown[] | undefined {
  if (!Array.isArray(raw) || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || Object.getOwnPropertySymbols(raw).length || raw.length > max) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.keys(descriptors).length !== raw.length + 1) return undefined;
  if (!Object.entries(descriptors).every(([key, field]) => key === "length" || Object.hasOwn(field, "value") && field.enumerable)) return undefined;
  return raw;
}

/** An own data property, read without invoking an accessor. */
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && Object.hasOwn(field, "value") ? field.value : undefined;
}

function text(raw: unknown, max: number, field: string, kind: "text" | "path" = "text"): string {
  const fix = `correct ${field} in the report and run arev record again`;
  if (typeof raw !== "string") return refuse(`${field} must be a string`, fix);
  const trimmed = raw.trim();
  if (!trimmed || Buffer.byteLength(trimmed) > max) return refuse(`${field} must be 1-${max} UTF-8 bytes`, fix);
  if (kind === "path" && /[\p{Cc}\p{Cf}\\]/u.test(trimmed)) return refuse(`${field} must be a repository-relative path without control characters`, fix);
  const clean = sanitize(trimmed);
  if (Buffer.byteLength(clean) > max) return refuse(`${field} exceeds ${max} UTF-8 bytes after framing`, fix);
  return clean;
}

/** The same bounds for a value typed on the command line rather than in the report. */
function cliText(raw: unknown, max: number, field: string): string {
  const fix = `fix ${field} and retry`;
  if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw.trim()) > max) return refuse(`${field} must be 1-${max} UTF-8 bytes`, fix);
  const clean = sanitize(raw.trim());
  if (Buffer.byteLength(clean) > max) return refuse(`${field} exceeds ${max} UTF-8 bytes after framing`, fix);
  return clean;
}

function oneOf<const T extends string>(raw: unknown, allowed: readonly T[], field: string): T {
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    return refuse(`${field} must be ${allowed.map(value => `"${value}"`).join(" or ")}`, `set ${field} in the report and run arev record again`);
  }
  return raw as T;
}

function optionalText(row: Record<string, unknown>, key: string, max: number, field: string, kind: "text" | "path" = "text"): string | undefined {
  return row[key] === undefined ? undefined : text(row[key], max, field, kind);
}

export interface RecordOptions {
  /** The packet arev built for this head, as the ledger holds it. */
  packet: PacketBlock;
  /** REVIEW.md's cap when the packet carries it, else `DEFAULT_MAX_ADVISORIES`. */
  maxAdvisories?: number;
  /** `accepted` is the person's decision: an interactive terminal is the only source of it. */
  person: boolean;
  /** `--implementer`; when the report also states one, the two must agree. */
  implementer?: string;
}

/**
 * Validate one report against the packet for its head (AC3) and return it with the ledger's packet block.
 *
 * Refused: a packet id that is not the packet for that head, coverage that omits a unit, a positional finding id,
 * more advisory findings than the cap, and an empty finding list without `call.ok: true`. An `accepted` finding, or a
 * `false_positive` without evidence, is also refused: AC4's gate could never pass on it.
 */
export function parseReviewRecord(raw: unknown, options: RecordOptions): ReviewRecordV1 {
  const cap = options.maxAdvisories ?? DEFAULT_MAX_ADVISORIES;
  if (!Number.isSafeInteger(cap) || cap < 0 || cap > MAX_FINDINGS) refuse(`the advisory cap ${cap} is not an integer in 0-${MAX_FINDINGS}`, "fix review.advisory_cap in the packet, or omit it for the default 5");
  const row = closed(raw, RECORD_FIELDS, "the report");
  if (!row) refuse("the report must be a plain JSON object with own data fields only", "write the report as JSON with no accessors, prototypes or hidden fields");
  if (row.v !== 1) refuse(`the report's v must be the number 1 (got ${jsonType(row.v)}); this arev reads v: 1`, "set v to 1 in the report");

  const claim = row.packet;
  const declaredId = own(claim, "id"), declaredHead = own(own(claim, "subject"), "head");
  const head = options.packet.subject.head;
  if (declaredId !== options.packet.id) {
    refuse(`the report's packet id is not the packet for head ${head} (${options.packet.id})`,
      `build the report from the packet.json arev wrote for ${head}: arev packet --pr N --out DIR`);
  }
  if (declaredHead !== head) refuse(`the report's packet subject head is not ${head}`, `write the report from the packet.json arev wrote for ${head}`);

  const reviewerRow = closed(row.reviewer, ["id", "modelFamily", "model", "started", "implementer", "sameFamilyFallback"], "reviewer");
  if (!reviewerRow) refuse("reviewer must be a plain object with id, modelFamily, started and sameFamilyFallback", "add the reviewer block to the report");
  const declaredImplementer = optionalText(reviewerRow, "implementer", MAX_NAME, "reviewer.implementer");
  const flaggedImplementer = options.implementer === undefined ? undefined : cliText(options.implementer, MAX_NAME, "--implementer");
  if (declaredImplementer !== undefined && flaggedImplementer !== undefined && declaredImplementer !== flaggedImplementer) {
    refuse(`--implementer ${flaggedImplementer} disagrees with the report's reviewer.implementer ${echoName(declaredImplementer)}`,
      "drop one of them; --implementer overrides only when the report states none");
  }
  if (typeof reviewerRow.sameFamilyFallback !== "boolean") refuse("reviewer.sameFamilyFallback must be true or false", "set it in the report: true when the reviewer is the implementer's family and the gate may allow it");
  const reviewer: ReviewRecordV1["reviewer"] = {
    id: text(reviewerRow.id, MAX_NAME, "reviewer.id"),
    modelFamily: text(reviewerRow.modelFamily, MAX_FAMILY, "reviewer.modelFamily"),
    started: oneOf(reviewerRow.started, ["self", "manual"] as const, "reviewer.started"),
    sameFamilyFallback: reviewerRow.sameFamilyFallback,
    ...(reviewerRow.model === undefined ? {} : { model: text(reviewerRow.model, MAX_NAME, "reviewer.model") }),
    ...((declaredImplementer ?? flaggedImplementer) === undefined ? {} : { implementer: declaredImplementer ?? flaggedImplementer }),
  };

  const coverageRow = closed(row.coverage, ["reviewed", "skipped"], "coverage");
  if (!coverageRow) refuse("coverage must be a plain object with reviewed and skipped", "add the coverage block to the report");
  const reviewedRows = rows(coverageRow.reviewed, 4096);
  if (!reviewedRows) refuse("coverage.reviewed must be an array of at most 4096 paths", "list every unit you read under coverage.reviewed");
  const skippedRows = rows(coverageRow.skipped, 4096);
  if (!skippedRows) refuse("coverage.skipped must be an array of at most 4096 objects", "list every unit you did not read under coverage.skipped with a reason");
  const coverage: ReviewRecordV1["coverage"] = {
    reviewed: reviewedRows.map((path, index) => text(path, MAX_PATH, `coverage.reviewed[${index}]`, "path")),
    skipped: skippedRows.map((entry, index) => {
      const skipped = closed(entry, ["path", "reason"], `coverage.skipped[${index}]`);
      if (!skipped) refuse(`coverage.skipped[${index}] must be a plain object with path and reason`, "give each skipped unit a path and a reason");
      return { path: text(skipped.path, MAX_PATH, `coverage.skipped[${index}].path`, "path"), reason: text(skipped.reason, MAX_TEXT, `coverage.skipped[${index}].reason`) };
    }),
  };
  const covered = new Set([...coverage.reviewed, ...coverage.skipped.map(entry => entry.path)]);
  const missing = (options.packet.units ?? []).map(unit => unit.path).filter(path => !covered.has(path));
  if (missing.length > 0) {
    refuse(`coverage omits ${missing.length} packet unit(s): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`,
      "review or skip every unit in the packet's units, then run arev record again");
  }

  const findingRows = rows(row.findings, MAX_FINDINGS);
  if (!findingRows) refuse(`findings must be an array of at most ${MAX_FINDINGS} entries`, "record at most 64 findings in one report");
  const ids = new Set<string>();
  const findings = findingRows.map((entry, index): RecordFinding => {
    const at = `findings[${index}]`;
    const finding = closed(entry, FINDING_FIELDS, at);
    if (!finding) refuse(`${at} must be a plain object with only ${FINDING_FIELDS.join(", ")}`, `correct ${at} in the report`);
    const id = text(finding.id, MAX_ID, `${at}.id`);
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) refuse(`${at}.id must match ^[A-Za-z0-9._:-]{1,96}$`, "use a semantic id such as compliance:unpinned-dependency");
    if (ids.has(id)) refuse(`${at}.id ${echoName(id)} repeats an earlier finding's id`, "give each finding its own id");
    ids.add(id);
    if (positionalFindingId(id)) {
      refuse(`${at}.id ${echoName(id)} is a positional label, which names a different finding on every review`,
        "rename it to a semantic id (the defect, not its number), such as security:denied-path-in-brief");
    }
    const path = optionalText(finding, "path", MAX_PATH, `${at}.path`, "path");
    let anchor: ReviewAnchor | undefined;
    if (finding.anchor !== undefined) {
      try {
        anchor = parseReviewAnchor(finding.anchor);
      } catch (error) {
        refuse(`${at}.anchor is invalid: ${reviewAnchorErrorMessage(error)}`, `correct ${at}.anchor and run arev record again`);
      }
    }
    if (path !== undefined && anchor && path !== anchor.path) refuse(`${at}.path and ${at}.anchor.path differ`, "use the same repository-relative path in both");
    const rationale = optionalText(finding, "rationale", MAX_TEXT, `${at}.rationale`);
    const disposition = oneOf(finding.disposition, DISPOSITIONS, `${at}.disposition`);
    const evidenceRows = finding.evidence === undefined ? undefined : rows(finding.evidence, MAX_EVIDENCE);
    if (finding.evidence !== undefined && !evidenceRows) refuse(`${at}.evidence must be an array of at most ${MAX_EVIDENCE} refs`, "list each evidence ref as a string such as path:line");
    const evidence = evidenceRows?.map((ref, position) => text(ref, MAX_REF, `${at}.evidence[${position}]`));
    if (disposition === "accepted" && (!options.person || rationale === undefined)) {
      refuse(`${at} is accepted without ${options.person ? "a rationale" : "a person"}; accepted is the person's decision`,
        options.person ? "add a rationale naming what was accepted" : "run arev resolve --as accepted <id> from your own terminal");
    }
    if (disposition === "false_positive" && !evidence?.length) {
      refuse(`${at} is a false_positive without evidence`, "add evidence (path:line or a command's output) that settles it, or record it as open");
    }
    return {
      id,
      term: oneOf(finding.term, TERMS, `${at}.term`),
      severity: oneOf(finding.severity, SEVERITIES, `${at}.severity`),
      disposition,
      origin: oneOf(finding.origin, ORIGINS, `${at}.origin`),
      text: text(finding.text, MAX_TEXT, `${at}.text`),
      ...(path === undefined ? {} : { path }),
      ...(anchor === undefined ? {} : { anchor }),
      ...(rationale === undefined ? {} : { rationale }),
      ...(evidence === undefined ? {} : { evidence }),
    };
  });
  if (findings.filter(finding => finding.severity === "advisory").length > cap) {
    refuse(`${findings.filter(finding => finding.severity === "advisory").length} advisory findings exceed the cap of ${cap}`,
      "drop the weakest advisories or raise review.advisory_cap in REVIEW.md");
  }
  if (Buffer.byteLength(JSON.stringify(findings)) > MAX_FINDING_BYTES) refuse(`the findings exceed ${MAX_FINDING_BYTES} bytes`, "shorten their text");
  const callRow = closed(row.call, ["ok", "error"], "call");
  if (!callRow) refuse("call must be a plain object with ok and an optional error", "add call: { ok: true } or call: { ok: false, error } to the report");
  if (typeof callRow.ok !== "boolean") refuse("call.ok must be true or false", "set call.ok to whether the review call itself succeeded");
  const call: ReviewRecordV1["call"] = { ok: callRow.ok, ...(callRow.error === undefined ? {} : { error: text(callRow.error, MAX_TEXT, "call.error") }) };
  if (findings.length === 0 && call.ok !== true) refuse("an empty finding list is accepted only with call.ok true", "a failed call cannot report a clean review; set call.ok to false and name the failure, or record what you found");

  return {
    v: 1,
    packet: options.packet,
    reviewer,
    coverage,
    findings,
    verdict: oneOf(row.verdict, ["approved", "changes_requested"] as const, "verdict"),
    call,
  };
}

/** What `arev show` prints and `arev gate` reads (V1 T4). Evidence rides beside the lifecycle, which has no field for it. */
export interface ReviewView {
  head?: string;
  base?: string;
  mergeBase?: string;
  packet?: string;
  record?: string;
  verdict?: ReviewRecordV1["verdict"];
  call?: ReviewRecordV1["call"];
  findings: (ReviewFinding & { text?: string; evidence?: string[] })[];
  counts: ReviewFindingTally;
  openBlocking: string[];
}

const lifecycle = (finding: RecordFinding): ReviewFinding => ({
  id: finding.id,
  pass: finding.term,
  severity: finding.severity === "blocking" ? "important" : "nit",
  disposition: finding.disposition,
  ...(finding.path === undefined ? {} : { path: finding.path }),
  ...(finding.rationale === undefined ? {} : { rationale: finding.rationale }),
  ...(finding.anchor === undefined ? {} : { anchor: finding.anchor as ReviewAnchor }),
  ...(finding.origin === "pre_existing" ? { origin: "pre_existing" as const } : {}),
});

/**
 * The request that rebuilds a stored packet from its own subject. A subject that is a fixed base and head rebuilds to
 * the same packet; a workspace subject does not, because it names HEAD while the tree is what moved.
 */
function rebuildRequest(subject: PacketBlock["subject"]): PacketRequest | undefined {
  if (subject.kind === "range" && subject.base) return { kind: "range", base: subject.base, head: subject.head };
  if (subject.kind === "commit") return { kind: "commit", commit: subject.head };
  if (subject.kind === "workspace") return { kind: "workspace" };
  // ponytail: a `files` packet does not keep the scope paths it was built from, so it cannot be rebuilt and its report
  // is still checked against the stored event alone. Ceiling: an edit after `arev packet --files P...` leaves a stale
  // packet accepted for the same head. Lifting it needs the scope paths stored on the packet event.
  return undefined;
}

/**
 * Replay the ledger into the review of one head. Records are finding sets keyed by their head; a resolve is an explicit
 * disposition for its id at the head it was recorded at, carrying the severity and term of the latest report of it, so
 * settling a blocking finding once settles it for later heads too. A resolve naming an id no report ever carried has
 * nothing to settle and is ignored (`arev resolve` refuses to write one).
 */
export function ledgerEventsView(events: readonly LedgerEvent[], head?: string): ReviewView {
  const newest = (type: LedgerEvent["type"]) => [...events].reverse().find(event => event.type === type);
  const lastRecord = newest("record"), lastPacket = newest("packet");
  const target = head
    ?? (lastRecord?.type === "record" ? lastRecord.record.packet.subject.head : undefined)
    ?? (lastPacket?.type === "packet" ? lastPacket.packet.subject.head : undefined);
  const packetEvent = target === undefined
    ? (lastPacket?.type === "packet" ? lastPacket : undefined)
    : [...events].reverse().find(event => event.type === "packet" && event.packet.subject.head === target);
  const recordEvent = [...events].reverse().find(event => event.type === "record" && event.record.packet.subject.head === target);

  const sets: ReviewFindingSet[] = [];
  const latest = new Map<string, RecordFinding>(), evidence = new Map<string, string[]>();
  for (const event of events) {
    if (event.type === "record") {
      sets.push({ head: event.record.packet.subject.head, items: event.record.findings.map(lifecycle) });
      for (const finding of event.record.findings) {
        latest.set(finding.id, finding);
        if (finding.evidence?.length) evidence.set(finding.id, [...finding.evidence]);
        else evidence.delete(finding.id);
      }
    } else if (event.type === "resolve") {
      const reported = latest.get(event.finding);
      if (!reported) continue;
      sets.push({
        head: event.head,
        items: [{
          ...lifecycle(reported),
          disposition: event.as,
          ...(event.rationale === undefined ? {} : { rationale: event.rationale }),
        }],
      });
      if (event.evidence?.length) evidence.set(event.finding, [...event.evidence]);
    }
  }

  const findings = findingsForHead(sets, target).map(finding => ({
    ...finding,
    ...(latest.get(finding.id)?.text === undefined ? {} : { text: latest.get(finding.id)!.text }),
    ...(evidence.has(finding.id) ? { evidence: evidence.get(finding.id)! } : {}),
  }));
  // A record's own packet is the one its report was validated against, so it wins over the newest packet event for the
  // head: a later packet (a re-run, a new base) describes a review this head's record never saw.
  const recordedPacket = recordEvent?.type === "record" ? recordEvent.record.packet : undefined;
  const subject = recordedPacket?.subject ?? (packetEvent?.type === "packet" ? packetEvent.packet.subject : undefined);
  const packetId = recordedPacket?.id ?? (packetEvent?.type === "packet" ? packetEvent.packet.id : undefined);
  return {
    ...(target === undefined ? {} : { head: target }),
    ...(typeof subject?.base === "string" ? { base: subject.base } : {}),
    ...(typeof subject?.mergeBase === "string" ? { mergeBase: subject.mergeBase } : {}),
    ...(packetId === undefined ? {} : { packet: packetId }),
    ...(recordEvent?.type === "record" ? { record: recordEvent.id } : {}),
    ...(recordEvent?.type === "record" ? { verdict: recordEvent.record.verdict, call: recordEvent.record.call } : {}),
    findings,
    counts: findingTally(findings),
    openBlocking: findings.filter(blocksApproval).map(finding => finding.id),
  };
}

const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);
const stderrTty = (): boolean => Boolean(process.stderr.isTTY);

function usageError(message: string): number {
  for (const line of errorLine("arev", message, "", { tty: stderrTty(), next: "arev --help" })) console.error(line);
  return EXIT.usage;
}

function failure(error: unknown): number {
  if (!(error instanceof Refusal)) throw error;
  for (const line of errorLine("arev", error.message, "", { tty: stderrTty(), next: error.next })) console.error(line);
  return EXIT.fail;
}

interface Parsed { positionals: string[]; flags: Record<string, string[]> }
function parseArgs(args: readonly string[], spec: { value: readonly string[]; boolean: readonly string[] }): Parsed | undefined {
  const positionals: string[] = [], flags: Record<string, string[]> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (spec.boolean.includes(arg)) {
      flags[arg] = [...(flags[arg] ?? []), ""];
      continue;
    }
    if (!spec.value.includes(arg)) return undefined;
    const value = args[++index];
    if (value === undefined || value.startsWith("-")) return undefined;
    flags[arg] = [...(flags[arg] ?? []), value];
  }
  return { positionals, flags };
}

/** `arev record <report.json> [--implementer NAME] [--json]`. */
export function recordCommand(cwd: string, args: readonly string[]): number {
  const parsed = parseArgs(args, { value: ["--implementer"], boolean: ["--json"] });
  if (!parsed) return usageError("record takes one report file and --implementer <name> | --json");
  if (parsed.positionals.length !== 1) return usageError(`record takes exactly one report file (got ${parsed.positionals.length})`);
  const file = resolve(parsed.positionals[0]!);
  try {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      throw new Refusal(`cannot read the report ${file}`, "pass the path of the report JSON you wrote");
    }
    if (Buffer.byteLength(source) > MAX_REPORT_BYTES) throw new Refusal(`the report ${file} exceeds ${MAX_REPORT_BYTES} bytes`, "shorten the report's text and retry");
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch {
      throw new Refusal(`${file} is not valid JSON`, "fix the report file and run arev record again");
    }
    const head = own(own(own(raw, "packet"), "subject"), "head");
    // The head is checked before it is ever echoed: it is report text, and the refusals below print it.
    if (typeof head !== "string" || !FULL_OID.test(head)) {
      throw new Refusal(`the report ${file} has no full commit SHA at packet.subject.head`,
        "write the report from the packet.json arev wrote: arev packet --pr N --out DIR");
    }
    const events = readLedger(cwd);
    const packetEvent = [...events].reverse().find(event => event.type === "packet" && event.packet.subject.head === head);
    if (!packetEvent || packetEvent.type !== "packet") {
      throw new Refusal(`no packet for head ${head} is in the ledger`, `run arev packet for that head (arev packet --pr N --out DIR), then write the report from its packet.json`);
    }
    const request = rebuildRequest(packetEvent.packet.subject);
    if (request) {
      let rebuilt: string;
      try {
        rebuilt = buildPacket(cwd, request).packet.id;
      } catch (error) {
        // A packet that cannot be rebuilt cannot be shown to match, and an unrun check is not a pass.
        throw new Refusal(`arev cannot rebuild the packet for head ${head} to check the report against: ${error instanceof Error ? error.message : "unknown error"}`,
          `fetch the reviewed commits and retry, or rerun arev packet for ${head} and rewrite the report from its packet.json`);
      }
      if (rebuilt !== packetEvent.packet.id) {
        throw new Refusal(`the packet changed since arev packet (${packetEvent.packet.id} was recorded, ${rebuilt} is what arev builds for head ${head} now)`,
          "rerun arev packet and rewrite the report from the new packet.json; a workspace subject counts every uncommitted file, the report included, so keep the report outside the worktree");
      }
    }
    const cap = packetEvent.review?.advisory_cap ?? DEFAULT_MAX_ADVISORIES;
    const implementer = parsed.flags["--implementer"]?.at(-1);
    const record = parseReviewRecord(raw, { packet: packetEvent.packet, maxAdvisories: cap, person: interactive(), ...(implementer === undefined ? {} : { implementer }) });
    const id = recordId(record);
    appendEvent(cwd, { v: 1, type: "record", at: new Date().toISOString(), id, record });
    const blockingOpen = record.findings.filter(finding => finding.severity === "blocking" && finding.disposition === "open").length;
    if (parsed.flags["--json"] !== undefined) {
      console.log(JSON.stringify({ id, head: record.packet.subject.head, verdict: record.verdict, call: record.call, findings: record.findings.length, blockingOpen }, null, 2));
    } else {
      console.log(`recorded ${id} for head ${record.packet.subject.head}`);
      console.log(`  ${record.findings.length} finding(s), ${blockingOpen} blocking open; next: arev show, then arev gate`);
    }
    return EXIT.ok;
  } catch (error) {
    return failure(error);
  }
}

/** `arev resolve <finding-id> --as fixed|false_positive|accepted [--evidence REF]... [--rationale TEXT] [--head SHA]`. */
export function resolveCommand(cwd: string, args: readonly string[]): number {
  const parsed = parseArgs(args, { value: ["--as", "--evidence", "--rationale", "--head"], boolean: ["--json"] });
  if (!parsed) return usageError("resolve takes one finding id and --as fixed|false_positive|accepted, with --evidence, --rationale or --head");
  if (parsed.positionals.length !== 1) return usageError(`resolve takes exactly one finding id (got ${parsed.positionals.length})`);
  const id = parsed.positionals[0]!;
  const as = parsed.flags["--as"]?.at(-1);
  if (as !== "fixed" && as !== "false_positive" && as !== "accepted") return usageError("resolve needs --as fixed, --as false_positive or --as accepted");
  try {
    const evidence = (parsed.flags["--evidence"] ?? []).map((ref, index) => cliText(ref, MAX_REF, `--evidence[${index}]`));
    const rationale = parsed.flags["--rationale"]?.at(-1);
    if (as === "accepted" && !interactive()) {
      throw new Refusal("accepted is the person's decision and is refused outside an interactive terminal", `run arev resolve ${id} --as accepted --rationale "<what was accepted>" from your own terminal`);
    }
    if (as === "accepted" && rationale === undefined) throw new Refusal("--as accepted needs --rationale", `pass --rationale "<what was accepted>"`);
    if (as === "false_positive" && evidence.length === 0) {
      throw new Refusal("--as false_positive needs --evidence", `pass --evidence path:line (or the command output) that settles ${id}`);
    }
    const events = readLedger(cwd);
    const known = events.some(event => event.type === "record" && event.record.findings.some(finding => finding.id === id));
    if (!known) throw new Refusal(`no recorded finding has the id ${id}`, "run arev show to list the finding ids in the ledger");
    const newestRecord = [...events].reverse().find(event => event.type === "record");
    const head = parsed.flags["--head"]?.at(-1) ?? (newestRecord?.type === "record" ? newestRecord.record.packet.subject.head : undefined);
    if (!head) throw new Refusal("the ledger has no head to resolve against", "pass --head <sha> or record a review first");
    const event: LedgerEvent = {
      v: 1, type: "resolve", at: new Date().toISOString(), head, finding: id, as,
      ...(evidence.length ? { evidence } : {}),
      ...(rationale === undefined ? {} : { rationale: cliText(rationale, MAX_TEXT, "--rationale") }),
    };
    appendEvent(cwd, event);
    if (parsed.flags["--json"] !== undefined) console.log(JSON.stringify({ finding: id, as, head, evidence, ...(rationale === undefined ? {} : { rationale }) }, null, 2));
    else console.log(`resolved ${id} as ${as} at ${head}; next: arev show, then arev gate`);
    return EXIT.ok;
  } catch (error) {
    return failure(error);
  }
}

/** `arev show [--head SHA] [--json]`. */
export function showCommand(cwd: string, args: readonly string[]): number {
  const parsed = parseArgs(args, { value: ["--head"], boolean: ["--json"] });
  if (!parsed) return usageError("show takes --head <sha> and --json");
  if (parsed.positionals.length > 0) return usageError(`show takes no arguments after its flags (got ${parsed.positionals.length})`);
  try {
    const events = readLedger(cwd);
    if (events.length === 0) {
      console.log(`no review ledger for ${reviewProjectId(cwd)} yet; next: arev packet --pr N --out DIR`);
      return EXIT.ok;
    }
    const view = ledgerEventsView(events, parsed.flags["--head"]?.at(-1));
    if (parsed.flags["--json"] !== undefined) {
      console.log(JSON.stringify(view, null, 2));
      return EXIT.ok;
    }
    console.log(`head ${view.head ?? "(none)"}${view.base ? ` base ${view.base}` : ""}${view.mergeBase ? ` merge-base ${view.mergeBase}` : ""}`);
    console.log(`packet ${view.packet ?? "(none)"} record ${view.record ?? "(none)"}${view.verdict ? ` verdict ${view.verdict}` : ""}${view.call ? ` call ${view.call.ok ? "ok" : "failed"}` : ""}`);
    const counts = view.counts;
    console.log(`findings: ${counts.important} blocking (${counts.openImportant} open), ${counts.nit} advisory (${counts.openNit} open), ${counts.fixed} fixed, ${counts.falsePositive} false_positive, ${counts.accepted} accepted`);
    for (const finding of view.findings) {
      const oneLine = finding.text ?? "";
      console.log(`  ${finding.severity === "important" ? "!" : "-"} ${finding.id} ${finding.disposition}${finding.path ? ` ${finding.path}` : ""}${oneLine ? `: ${oneLine.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
    }
    if (view.openBlocking.length) console.log(`gate: fails while these are open: ${view.openBlocking.join(", ")}`);
    return EXIT.ok;
  } catch (error) {
    return failure(error);
  }
}
