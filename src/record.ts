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
import { MAX_REPORT_BYTES, Refusal, appendEvent, readLedger, recordId, reviewProjectId, secretShaped, shown, stringsIn, type LedgerEvent, type PacketBlock, type RecordFinding, type ReviewRecordV1 } from "./ledger.ts";
import { buildPacket, type PacketRequest } from "./packet.ts";
import { PacketUsageError } from "./packet-cli.ts";
import { reviewGit } from "./review-git.ts";
import { DEFAULT_ADVISORY_CAP, MAX_ADVISORY_CAP } from "./review-md.ts";

const MAX_FINDINGS = MAX_ADVISORY_CAP, MAX_FINDING_BYTES = 64 * 1024;
const MAX_ID = 96, MAX_PATH = 512, MAX_TEXT = 2048, MAX_REF = 512, MAX_NAME = 128, MAX_FAMILY = 64, MAX_EVIDENCE = 16;
const TERMS = ["bugs", "security", "compliance"] as const, SEVERITIES = ["blocking", "advisory"] as const;
const DISPOSITIONS = ["open", "fixed", "false_positive", "accepted"] as const, ORIGINS = ["introduced", "pre_existing", "indeterminate"] as const;
const FINDING_FIELDS = ["id", "term", "severity", "path", "anchor", "text", "disposition", "rationale", "origin", "evidence"];
const RECORD_FIELDS = ["v", "packet", "reviewer", "coverage", "findings", "verdict", "call"];

function refuse(message: string, next: string): never {
  throw new Refusal(message, next);
}

const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
/** A commit id as a caller may type it on the command line: hexadecimal, full or abbreviated. */
const COMMITISH = /^(?:[a-f0-9]{4,64})$/;
/**
 * A `--head` value as the ledger spells heads. An abbreviation is a commit id the caller may type, so it is resolved
 * against this repository: comparing it to `subject.head` would report the ledger's silence for a head arev never
 * looked up. A value that resolves to no commit here is refused by name, because "no review at that head" and "that is
 * not a head here" are different facts. Callers shape-check the value with `COMMITISH` first, so this echo is hex.
 */
function resolveHead(cwd: string, value: string): string {
  const result = reviewGit(cwd, ["rev-parse", "--verify", "-q", `${value}^{commit}`]);
  if (result.status === 0) return result.stdout.replace(/\r?\n$/, "");
  // What counts as full is the repository's own object format: 40 hexadecimal characters is a whole OID in a SHA-1
  // repository and a prefix in a SHA-256 one, where git resolves it but a length test alone would read it as a head.
  if (fullOidHere(cwd, value)) return value;
  throw new Refusal(`--head ${value} does not name a commit in this repository`,
    "pass the full head SHA (40 characters, or 64 in a SHA-256 repository), or fetch that commit and retry");
}

/**
 * Whether `value` is written out in full for this repository, so a head the ledger records for a commit this checkout
 * does not hold is still readable by its full OID. The format is read from git, and an unreadable one (no repository
 * here) accepts either length: nothing on this side can then tell a prefix from a head.
 */
function fullOidHere(cwd: string, value: string): boolean {
  if (!FULL_OID.test(value)) return false;
  const format = reviewGit(cwd, ["rev-parse", "--show-object-format"]);
  if (format.status !== 0) return true;
  return value.length === (format.stdout.trim() === "sha256" ? 64 : 40);
}
/** A packet id is the sha256 of the packet's canonical JSON: a report's claim on it is checked before it is looked up. */
const PACKET_ID = /^[a-f0-9]{64}$/;
/** A review thread is a PR number, in the shape `arev packet --pr` takes it; `arev gate` reads it here too. */
export const PR_NUMBER = /^[1-9][0-9]*$/;
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
  /** REVIEW.md's cap when the packet carries it, else `DEFAULT_ADVISORY_CAP`. */
  maxAdvisories?: number;
  /** `--implementer`; when the report also states one, the two must agree. */
  implementer?: string;
  /** `--light`: the review was made without a REVIEW.md. Only the flag states it; the report may not carry it. */
  light?: boolean;
}

/**
 * Validate one report against the packet for its head (AC3) and return it with the ledger's packet block.
 *
 * Refused: a packet id that is not the packet for that head, coverage that omits a unit, a positional finding id,
 * more advisory findings than the cap, and an empty finding list without `call.ok: true`. An `accepted` finding is
 * refused too, from any caller: accepting a risk is the person's decision, taken through `arev resolve --as accepted`
 * and never stated by a report. A `false_positive` without evidence is refused because AC4's gate could never pass on it.
 */
export function parseReviewRecord(raw: unknown, options: RecordOptions): ReviewRecordV1 {
  const cap = options.maxAdvisories ?? DEFAULT_ADVISORY_CAP;
  if (!Number.isSafeInteger(cap) || cap < 0 || cap > MAX_FINDINGS) refuse(`the advisory cap ${cap} is not an integer in 0-${MAX_FINDINGS}`, `fix review.advisory_cap in the packet, or omit it for the default ${DEFAULT_ADVISORY_CAP}`);
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
    refuse(`--implementer ${shown(flaggedImplementer)} disagrees with the report's reviewer.implementer ${echoName(declaredImplementer)}`,
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
  // Compared as the report wrote them, not by the stored spelling: `text` frames a path for display, so a real path that
  // begins with a framed header (`--- from x`) would otherwise never match the unit the packet names.
  const exactPath = (raw: unknown): string => (typeof raw === "string" ? raw.trim() : "");
  const covered = new Set([...reviewedRows.map(exactPath), ...skippedRows.map(entry => exactPath(own(entry, "path")))]);
  const missing = (options.packet.units ?? []).map(unit => unit.path).filter(path => !covered.has(path));
  if (missing.length > 0) {
    refuse(`coverage omits ${missing.length} packet unit(s): ${missing.slice(0, 5).map(shown).join(", ")}${missing.length > 5 ? ", ..." : ""}`,
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
    if (disposition === "accepted") {
      // A recorded report never carries this, at a terminal or anywhere else: running `arev record` is not the person's
      // decision, and `arev gate` reads the disposition this writes. Only `arev resolve --as accepted` states it, and that
      // command needs a report of the id first, so the next step starts by recording the finding as open.
      refuse(`${at} states accepted; accepted is the person's decision and is not a report's to make`,
        `record the finding as open, then run arev resolve ${shown(id)} --as accepted --rationale "<what was accepted>" from your own terminal`);
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
    // Only `--light` states this: the report is untrusted content, and the flag is the reviewer's claim about the run.
    ...(options.light ? { light: true } : {}),
  };
}

/** What `arev show` prints and `arev gate` reads (V1 T4). Evidence rides beside the lifecycle, which has no field for it. */
export interface ReviewView {
  head?: string;
  /** The review thread the view was scoped to, so a caller that passed `--pr N` reads which thread it got. */
  pr?: number;
  base?: string;
  mergeBase?: string;
  packet?: string;
  record?: string;
  verdict?: ReviewRecordV1["verdict"];
  call?: ReviewRecordV1["call"];
  /** The record's own lightness, so `arev show` echoes what `arev record --light` wrote. */
  light?: boolean;
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
  if (subject.kind === "range" && subject.base) {
    // The PR number rides along: a packet built with `--pr` carries it in its subject, so a rebuild without it would
    // produce a different id and refuse every report written from a PR packet.
    return { kind: "range", base: subject.base, head: subject.head, ...(subject.pr === undefined ? {} : { pr: subject.pr }) };
  }
  if (subject.kind === "commit") return { kind: "commit", commit: subject.head };
  if (subject.kind === "workspace") return { kind: "workspace" };
  // ponytail: a `files` packet does not keep the scope paths it was built from, so it cannot be rebuilt and its report
  // is still checked against the stored event alone. Ceiling: an edit after `arev packet --files P...` leaves a stale
  // packet accepted for the same head. Lifting it needs the scope paths stored on the packet event.
  return undefined;
}

/** Check the exact packet ID and rebuild the subject before reusing its review obligations. */
export function requireCurrentPacket(cwd: string, head: string, packetId: string, events = readLedger(cwd)) {
  if (!FULL_OID.test(head) || !PACKET_ID.test(packetId)) {
    throw new Refusal("The review does not name a full head and packet ID", "use the head and id from packet.json");
  }
  const packetEvent = [...events].reverse().find(event => event.type === "packet" && event.packet.id === packetId);
  if (!packetEvent || packetEvent.type !== "packet") {
    throw new Refusal(`no packet ${packetId} is in the ledger`,
      `run arev packet for the head this report reviews (arev packet --pr N --out DIR), then write the report from its packet.json`);
  }
  if (packetEvent.packet.subject.head !== head) {
    throw new Refusal(`the packet ${packetId} is for head ${packetEvent.packet.subject.head}, not ${head}`,
      `write the report from the packet.json arev wrote for ${head}, or fix packet.subject.head to the head that packet describes`);
  }
  const request = rebuildRequest(packetEvent.packet.subject);
  if (request) {
    let rebuilt: string;
    try {
      rebuilt = buildPacket(cwd, request).packet.id;
    } catch (error) {
      // A packet that cannot be rebuilt cannot be shown to match, and an unrun check is not a pass.
      throw new Refusal(`arev cannot rebuild the packet for head ${head} to check the report against: ${shown(error instanceof Error ? error.message : "unknown error")}`,
        `fetch the reviewed commits and retry, or rerun arev packet for ${head} and rewrite the report from its packet.json`);
    }
    if (rebuilt !== packetEvent.packet.id) {
      throw new Refusal(`the packet changed since arev packet (${packetEvent.packet.id} was recorded, ${rebuilt} is what arev builds for head ${head} now)`,
        "rerun arev packet and rewrite the report from the new packet.json; a workspace subject counts every uncommitted file, the report included, so keep the report outside the worktree");
    }
  }
  return packetEvent;
}

/** The review thread a packet belongs to: its PR number, or `undefined` for a packet built without one. */
const threadOf = (subject: PacketBlock["subject"] | undefined): number | undefined => subject?.pr;

/** The subject of an event that carries a packet, so a thread or a head can be read from either kind. */
const subjectOf = (event: LedgerEvent): PacketBlock["subject"] | undefined =>
  event.type === "record" ? event.record.packet.subject : event.type === "packet" ? event.packet.subject : undefined;

/**
 * Every review thread that has a record or a packet at one head, in the order the ledger wrote them. Exported for
 * `arev gate`: a commit status belongs to the commit, so `--post` has to see a head more than one thread claims.
 */
export function threadsAtHead(events: readonly LedgerEvent[], head: string): (number | undefined)[] {
  const threads: (number | undefined)[] = [];
  for (const event of events) {
    const subject = subjectOf(event);
    if (!subject || subject.head !== head) continue;
    const thread = threadOf(subject);
    if (!threads.includes(thread)) threads.push(thread);
  }
  return threads;
}

/**
 * The threads a head is *reviewed* in: only those with a record there. A packet with no report yet is a review nobody
 * filed, so it must not make a head ambiguous - `arev packet --pr 8` at a head already reviewed without a PR would
 * otherwise hide that review behind a refusal.
 */
function recordedThreadsAtHead(events: readonly LedgerEvent[], head: string): (number | undefined)[] {
  const threads: (number | undefined)[] = [];
  for (const event of events) {
    if (event.type !== "record" || event.record.packet.subject.head !== head) continue;
    const thread = threadOf(event.record.packet.subject);
    if (!threads.includes(thread)) threads.push(thread);
  }
  return threads;
}

/**
 * The review thread a caller names: a PR number, or `none` for the thread with no PR - the exact-head review a packet
 * built without `--pr` produces. `undefined` means undecided, never "the thread with no PR".
 */
type ThreadSelector = number | "none";

/** The spellings to pass, in the ledger's own order, so a refusal's next step is a command a person can copy. */
const prFlags = (threads: readonly (number | undefined)[]): string =>
  threads.map(thread => thread === undefined ? "--pr none" : `--pr ${thread}`).join(" or ");

/**
 * The thread of one head: the selector a caller named, else the one thread that head is reviewed in. A head SHA two PRs
 * share - one branch opened against two bases - has a record for each, and no default read is right there, so it is
 * refused by name with the candidates rather than answered with whichever event was written last. A head with no record
 * at all still names the thread of its packet, so `arev show` can report a packet nobody has reviewed yet.
 */
function threadAtHead(events: readonly LedgerEvent[], head: string, selector?: ThreadSelector): number | undefined {
  const present = threadsAtHead(events, head);
  if (selector === "none") {
    if (!present.includes(undefined)) {
      throw new Refusal(`no packet or record at head ${shown(head)} has no PR`,
        present.length === 0 ? "run arev packet for that head first" : `pass ${prFlags(present)} for this head`);
    }
    return undefined;
  }
  if (selector !== undefined) {
    if (!present.includes(selector)) {
      const numbers = present.filter((thread): thread is number => thread !== undefined);
      throw new Refusal(`no packet or record at head ${shown(head)} belongs to PR ${selector}`,
        present.length === 0 ? `run arev packet --pr ${selector} for that head, then write its review there`
          : numbers.length === 0 ? "this head's review names no PR; drop --pr"
            : `pass ${prFlags(present)} for this head`);
    }
    return selector;
  }
  const recorded = recordedThreadsAtHead(events, head);
  if (recorded.length > 1) {
    throw new Refusal(`head ${shown(head)} is reviewed in more than one thread (${recorded.map(thread => thread === undefined ? "no PR" : `PR ${thread}`).join(", ")}), so arev cannot tell which review you mean`,
      `pass ${prFlags(recorded)} to choose the review thread`);
  }
  if (recorded.length === 1) return recorded[0];
  // Unreviewed, and only packets: more than one thread there is still two things to mean, so it is refused the same way.
  if (present.length > 1) {
    throw new Refusal(`head ${shown(head)} has packets for more than one thread (${present.map(thread => thread === undefined ? "no PR" : `PR ${thread}`).join(", ")}), so arev cannot tell which review you mean`,
      `pass ${prFlags(present)} to choose the review thread`);
  }
  return present[0];
}

/**
 * Whether a record or resolve belongs to the view's thread at its head. A numbered thread follows its branch, so any
 * head of it is in scope; the thread with no PR has no branch to follow, so it is exactly its own head's review - and
 * never a head where a numbered PR also recorded, because those two threads share the SHA and nothing else.
 */
function inThread(subjectThread: number | undefined, subjectHead: string, thread: number | undefined, target: string | undefined): boolean {
  if (subjectThread !== thread) return false;
  return thread !== undefined || subjectHead === target;
}

/**
 * Replay the ledger into the review of one head, scoped to that head's review thread: the records and resolves whose
 * packet carries the same `subject.pr`, or - for a head whose packet has none - only those recorded at that exact head.
 * The ledger is one file per project, so a resolve in one PR would otherwise settle the same finding id in another.
 *
 * Within a thread, records are finding sets keyed by their head; a resolve is an explicit disposition for its id at the
 * head it was recorded at, carrying the severity and term of the latest report of it, so settling a blocking finding once
 * settles it for later heads of the same PR too. A resolve naming an id no report of the thread carried is ignored.
 */
export function ledgerEventsView(events: readonly LedgerEvent[], head?: string, pr?: ThreadSelector): ReviewView {
  // `--pr N` without `--head` reads that PR's newest review: a caller that knows the thread need not name a head, and a
  // head two PRs share cannot answer for both. `--pr none` is a thread too - the one with no PR - so it is `null` here
  // rather than `undefined`, which means "no thread named, take any".
  const selected = pr === "none" ? null : pr;
  const threadOfEvent = (event: LedgerEvent): number | undefined => threadOf(subjectOf(event));
  const newest = (type: LedgerEvent["type"]) => [...events].reverse().find(event =>
    event.type === type && (selected === undefined || threadOfEvent(event) === (selected ?? undefined)));
  const lastRecord = newest("record"), lastPacket = newest("packet");
  const target = head
    ?? (lastRecord?.type === "record" ? lastRecord.record.packet.subject.head : undefined)
    ?? (lastPacket?.type === "packet" ? lastPacket.packet.subject.head : undefined);
  // The thread is the target head's own: the selector when the caller named one, else the only thread that head is
  // reviewed in, refused by name when a head carries two. Every selection below is scoped to it.
  const thread = target === undefined ? selected ?? undefined : threadAtHead(events, target, pr);
  const atTarget = (event: LedgerEvent): boolean => {
    const subject = subjectOf(event);
    return subject !== undefined && subject.head === target && threadOf(subject) === thread;
  };
  const packetEvent = [...events].reverse().find(event => event.type === "packet" && atTarget(event));
  const recordEvent = [...events].reverse().find(event => event.type === "record" && atTarget(event));
  // A record's own packet is the one its report was validated against, so it wins over the newest packet event for the
  // head: a later packet (a re-run, a new base) describes a review this head's record never saw.
  const recordedPacket = recordEvent?.type === "record" ? recordEvent.record.packet : undefined;
  // The text and evidence a view prints belong to the records it replays: a record for a later head describes a review
  // this head never had, so a report text from it is not shown here.
  const recordIndex = recordEvent === undefined ? -1 : events.lastIndexOf(recordEvent);

  const sets: ReviewFindingSet[] = [];
  const latest = new Map<string, RecordFinding>(), shownRecord = new Map<string, RecordFinding>(), evidence = new Map<string, string[]>();
  for (const [index, event] of events.entries()) {
    if (event.type === "record") {
      const subject = event.record.packet.subject;
      if (!inThread(threadOf(subject), subject.head, thread, target)) continue;
      sets.push({ head: subject.head, items: event.record.findings.map(lifecycle) });
      for (const finding of event.record.findings) {
        latest.set(finding.id, finding);
        if (recordIndex !== -1 && index > recordIndex) continue;
        shownRecord.set(finding.id, finding);
        if (finding.evidence?.length) evidence.set(finding.id, [...finding.evidence]);
        else evidence.delete(finding.id);
      }
    } else if (event.type === "resolve") {
      const reported = latest.get(event.finding);
      if (!reported) continue;
      // A resolve names the thread it was made in (`arev resolve` writes it from the head it settles), so a resolve in
      // one PR is not replayed in another even when both report the same id. The thread with no PR has no branch to
      // follow, so it is that head's own.
      if (!inThread(event.pr, event.head, thread, target)) continue;
      sets.push({
        head: event.head,
        items: [{
          ...lifecycle(reported),
          disposition: event.as,
          ...(event.rationale === undefined ? {} : { rationale: event.rationale }),
        }],
      });
      // A resolve states its own evidence, so one without evidence clears what an earlier one showed.
      if (event.evidence?.length) evidence.set(event.finding, [...event.evidence]);
      else evidence.delete(event.finding);
    }
  }

  const findings = findingsForHead(sets, target).map(finding => {
    // The lifecycle merges a carried id across every record, so its path and anchor can describe a later head than the
    // one shown. Path, anchor and text all come from the last record at or before this head, like the evidence beside
    // them; only the disposition comes from the replay.
    const source = shownRecord.get(finding.id);
    const base = { ...finding };
    delete base.path;
    delete base.anchor;
    return {
      ...base,
      ...(source?.path === undefined ? {} : { path: source.path }),
      ...(source?.anchor === undefined ? {} : { anchor: source.anchor as ReviewAnchor }),
      ...(source?.text === undefined ? {} : { text: source.text }),
      ...(evidence.has(finding.id) ? { evidence: evidence.get(finding.id)! } : {}),
    };
  });
  // `recordedPacket` is the packet the head's record was validated against, taken above so the replay is scoped to the
  // same thread the view reports.
  const subject = recordedPacket?.subject ?? (packetEvent?.type === "packet" ? packetEvent.packet.subject : undefined);
  const packetId = recordedPacket?.id ?? (packetEvent?.type === "packet" ? packetEvent.packet.id : undefined);
  return {
    ...(target === undefined ? {} : { head: target }),
    ...(thread === undefined ? {} : { pr: thread }),
    ...(typeof subject?.base === "string" ? { base: subject.base } : {}),
    ...(typeof subject?.mergeBase === "string" ? { mergeBase: subject.mergeBase } : {}),
    ...(packetId === undefined ? {} : { packet: packetId }),
    ...(recordEvent?.type === "record" ? { record: recordEvent.id } : {}),
    ...(recordEvent?.type === "record" ? { verdict: recordEvent.record.verdict, call: recordEvent.record.call } : {}),
    ...(recordEvent?.type === "record" && recordEvent.record.light ? { light: true } : {}),
    findings,
    counts: findingTally(findings),
    openBlocking: findings.filter(blocksApproval).map(finding => finding.id),
  };
}

const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);
const stderrTty = (): boolean => Boolean(process.stderr.isTTY);

/**
 * A malformed invocation, thrown rather than printed: `src/cli.ts` answers a `PacketUsageError` with `EXIT.usage` and
 * the command's own help, so record, resolve and show refuse a bad invocation the way packet already does.
 */
const usageError = (message: string): never => {
  throw new PacketUsageError(message);
};

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

/** `arev record <report.json> [--implementer NAME] [--light] [--json]`. */
export function recordCommand(cwd: string, args: readonly string[]): number {
  const parsed = parseArgs(args, { value: ["--implementer"], boolean: ["--json", "--light"] });
  if (!parsed) return usageError("record takes one report file and --implementer <name> | --light | --json");
  if (parsed.positionals.length !== 1) return usageError(`record takes exactly one report file (got ${parsed.positionals.length})`);
  const file = resolve(parsed.positionals[0]!);
  try {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      throw new Refusal(`cannot read the report ${shown(file)}`, "pass the path of the report JSON you wrote");
    }
    if (Buffer.byteLength(source) > MAX_REPORT_BYTES) throw new Refusal(`the report ${shown(file)} exceeds ${MAX_REPORT_BYTES} bytes`, "shorten the report's text and retry");
    // A report is untrusted text and every refusal below can name a value out of it, so the file is screened before it is
    // parsed and before any of it reaches a message. The ledger screens each event again as it is written; this screen is
    // what keeps a secret-shaped value out of stderr, and it names no value at all.
    if (secretShaped(source)) {
      throw new Refusal(`the report ${shown(file)} matches a secret pattern, so nothing from it was recorded or shown`,
        "remove the secret-shaped value from the report, then write it again");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch {
      throw new Refusal(`${shown(file)} is not valid JSON`, "fix the report file and run arev record again");
    }
    // The raw screen cannot see a JSON escape, which the parse has now decoded: `\u0041` spells `A`, so a report can carry
    // a secret-shaped value past it. Every string the parsed report holds is screened the same way, still naming no value.
    if ([...stringsIn(raw)].some(secretShaped)) {
      throw new Refusal(`the report ${shown(file)} matches a secret pattern, so nothing from it was recorded or shown`,
        "remove the secret-shaped value from the report, then write it again");
    }
    const head = own(own(own(raw, "packet"), "subject"), "head");
    // The head is checked before it is ever echoed: it is report text, and the refusals below print it.
    if (typeof head !== "string" || !FULL_OID.test(head)) {
      throw new Refusal(`the report ${shown(file)} has no full commit SHA at packet.subject.head`,
        "write the report from the packet.json arev wrote: arev packet --pr N --out DIR");
    }
    const events = readLedger(cwd);
    // The report names the packet it was written from, and that is the one it is checked against: one head SHA can carry
    // a packet for each of two PRs opened against different bases, so the newest packet for the head is not the report's.
    const packetId = own(own(raw, "packet"), "id");
    if (typeof packetId !== "string" || !PACKET_ID.test(packetId)) {
      throw new Refusal(`the report ${shown(file)} has no packet id at packet.id`,
        "write the report from the packet.json arev wrote: arev packet --pr N --out DIR");
    }
    const packetEvent = requireCurrentPacket(cwd, head, packetId, events);
    const cap = packetEvent.review?.advisory_cap ?? DEFAULT_ADVISORY_CAP;
    const implementer = parsed.flags["--implementer"]?.at(-1);
    const record = parseReviewRecord(raw, { packet: packetEvent.packet, maxAdvisories: cap,
      ...(implementer === undefined ? {} : { implementer }), ...(parsed.flags["--light"] === undefined ? {} : { light: true }) });
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

/** `arev resolve <finding-id> --as fixed|false_positive|accepted [--evidence REF]... [--rationale TEXT] [--head SHA] [--pr N|none] [--json]`. */
export function resolveCommand(cwd: string, args: readonly string[]): number {
  const parsed = parseArgs(args, { value: ["--as", "--evidence", "--rationale", "--head", "--pr"], boolean: ["--json"] });
  if (!parsed) return usageError("resolve takes one finding id and --as fixed|false_positive|accepted, with --evidence, --rationale, --head or --pr");
  if (parsed.positionals.length !== 1) return usageError(`resolve takes exactly one finding id (got ${parsed.positionals.length})`);
  const id = parsed.positionals[0]!;
  const as = parsed.flags["--as"]?.at(-1);
  if (as !== "fixed" && as !== "false_positive" && as !== "accepted") return usageError("resolve needs --as fixed, --as false_positive or --as accepted");
  const prFlag = parsed.flags["--pr"]?.at(-1);
  if (prFlag !== undefined && prFlag !== "none" && !PR_NUMBER.test(prFlag)) return usageError("Invalid PR number. Pass a positive integer to --pr, or none for a review with no PR.");
  const pr: ThreadSelector | undefined = prFlag === undefined ? undefined : prFlag === "none" ? "none" : Number(prFlag);
  const headFlag = parsed.flags["--head"]?.at(-1);
  if (headFlag !== undefined && !COMMITISH.test(headFlag)) return usageError("--head must be a commit SHA: 4 to 64 hexadecimal characters");
  try {
    const evidence = (parsed.flags["--evidence"] ?? []).map((ref, index) => cliText(ref, MAX_REF, `--evidence[${index}]`));
    const rationale = parsed.flags["--rationale"]?.at(-1);
    if (as === "accepted" && !interactive()) {
      throw new Refusal("accepted is the person's decision and is refused outside an interactive terminal", `run arev resolve ${shown(id)} --as accepted --rationale "<what was accepted>" from your own terminal`);
    }
    if (as === "accepted" && rationale === undefined) throw new Refusal("--as accepted needs --rationale", `pass --rationale "<what was accepted>"`);
    if (as === "false_positive" && evidence.length === 0) {
      throw new Refusal("--as false_positive needs --evidence", `pass --evidence path:line (or the command output) that settles ${shown(id)}`);
    }
    const events = readLedger(cwd);
    // `--pr N` resolves inside that thread, and without `--head` it reads that PR's newest record rather than the ledger's
    // newest: two PRs can share a head, and the newest record there belongs to whichever was recorded last. `--pr none`
    // is the thread with no PR, so it reads the newest record that names none.
    const newestRecord = [...events].reverse().find(event => event.type === "record"
      && (pr === undefined || threadOf(event.record.packet.subject) === (pr === "none" ? undefined : pr)));
    const head = headFlag === undefined
      ? (newestRecord?.type === "record" ? newestRecord.record.packet.subject.head : undefined)
      : resolveHead(cwd, headFlag);
    if (!head) throw new Refusal("the ledger has no head to resolve against", "pass --head <sha> or record a review first");
    // The thread is the head's own: `--pr` when given, else the only thread that head carries, refused when it carries
    // more than one. The resolve states it on the event, and it refuses an id that thread never reported, so one PR's
    // resolve cannot settle another PR's finding.
    const thread = threadAtHead(events, head, pr);
    const reports = (event: LedgerEvent): boolean =>
      event.type === "record" && event.record.findings.some(finding => finding.id === id)
      && inThread(threadOf(event.record.packet.subject), event.record.packet.subject.head, thread, head);
    if (!events.some(reports)) {
      throw new Refusal(thread === undefined
        ? `no record at ${shown(head)} reports the finding ${shown(id)}`
        : `no record of PR ${thread} reports the finding ${shown(id)}`,
        thread === undefined ? `pass --head of a head whose record reports it, or record that review first` : "run arev show to list the finding ids recorded for that PR");
    }
    const event: LedgerEvent = {
      v: 1, type: "resolve", at: new Date().toISOString(), head, finding: id, as,
      ...(thread === undefined ? {} : { pr: thread }),
      ...(evidence.length ? { evidence } : {}),
      ...(rationale === undefined ? {} : { rationale: cliText(rationale, MAX_TEXT, "--rationale") }),
    };
    appendEvent(cwd, event);
    if (parsed.flags["--json"] !== undefined) console.log(JSON.stringify({ finding: id, as, head, ...(thread === undefined ? {} : { pr: thread }), evidence, ...(rationale === undefined ? {} : { rationale }) }, null, 2));
    else console.log(`resolved ${id} as ${as} at ${head}; next: arev show, then arev gate`);
    return EXIT.ok;
  } catch (error) {
    return failure(error);
  }
}

/** `arev show [--head SHA] [--pr N|none] [--json]`. */
export function showCommand(cwd: string, args: readonly string[]): number {
  const parsed = parseArgs(args, { value: ["--head", "--pr"], boolean: ["--json"] });
  if (!parsed) return usageError("show takes --head <sha>, --pr <n|none> and --json");
  if (parsed.positionals.length > 0) return usageError(`show takes no arguments after its flags (got ${parsed.positionals.length})`);
  const prFlag = parsed.flags["--pr"]?.at(-1);
  if (prFlag !== undefined && prFlag !== "none" && !PR_NUMBER.test(prFlag)) return usageError("Invalid PR number. Pass a positive integer to --pr, or none for a review with no PR.");
  const pr: ThreadSelector | undefined = prFlag === undefined ? undefined : prFlag === "none" ? "none" : Number(prFlag);
  const headFlag = parsed.flags["--head"]?.at(-1);
  if (headFlag !== undefined && !COMMITISH.test(headFlag)) return usageError("--head must be a commit SHA: 4 to 64 hexadecimal characters");
  try {
    // Resolved before the ledger is read: a `--head` that names no commit here is refused on its own terms, whether or
    // not this project has a ledger yet.
    const head = headFlag === undefined ? undefined : resolveHead(cwd, headFlag);
    const events = readLedger(cwd);
    if (events.length === 0) {
      console.log(`no review ledger for ${reviewProjectId(cwd)} yet; next: arev packet --pr N --out DIR`);
      return EXIT.ok;
    }
    const view = ledgerEventsView(events, head, pr);
    if (parsed.flags["--json"] !== undefined) {
      console.log(JSON.stringify(view, null, 2));
      return EXIT.ok;
    }
    console.log(`head ${view.head ?? "(none)"}${view.pr === undefined ? "" : ` pr ${view.pr}`}${view.base ? ` base ${view.base}` : ""}${view.mergeBase ? ` merge-base ${view.mergeBase}` : ""}`);
    console.log(`packet ${view.packet ?? "(none)"} record ${view.record ?? "(none)"}${view.verdict ? ` verdict ${view.verdict}` : ""}${view.call ? ` call ${view.call.ok ? "ok" : "failed"}` : ""}${view.light ? " light" : ""}`);
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
