/**
 * The review ledger: one append-only JSONL file per project, never inside the reviewed worktree.
 *
 * `<project-id>` is the project key `@staix/agent-mem` derives from the origin remote (`memoryProjectKey`,
 * `src/memory/project.ts`), normalized to host and path, so every machine and every worktree of one repository
 * resolves to the same ledger. Without an origin, the key is the working root's name plus a short hash of its
 * path, the same shape amem falls back to.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { reviewGit } from "./review-git.ts";

/** A refusal a person or agent can act on: the cause, and the command, setting or file that fixes it. */
export class Refusal extends Error {
  constructor(message: string, readonly next: string) {
    super(message);
    this.name = "Refusal";
  }
}

/** Events a review writes. `gate` and `post` are the merge-time gate of `arev gate` (V1 T4); they share the file. */
export type LedgerEvent =
  | { v: 1; type: "packet"; at: string; packet: PacketBlock; review?: { advisory_cap?: number } }
  | { v: 1; type: "record"; at: string; id: string; record: ReviewRecordV1 }
  | { v: 1; type: "resolve"; at: string; head: string; finding: string; as: "fixed" | "false_positive" | "accepted"; evidence?: string[]; rationale?: string }
  | { v: 1; type: "gate"; at: string; head: string; base?: string; ok: boolean; record?: string; open?: string[] }
  | { v: 1; type: "post"; at: string; head: string; record: string; status: "success" };

/**
 * `ReviewRecordV1.packet`: the packet the report was written against, as `arev packet` built it. `src/packet.ts` owns
 * the full shape, so this names only the fields a record reads (`id`, `subject.head`, the unit paths) and stores the
 * packet byte for byte rather than re-validating it. It is deliberately narrow rather than index-signed: an index
 * signature here would refuse the builder's own interfaces, and the extra fields travel in the record untouched
 * whatever this type says.
 */
export interface PacketBlock {
  id: string;
  profile?: string;
  subject: { kind?: string; base?: string; head: string; mergeBase?: string; pr?: number };
  units?: { path: string; status?: string; insertions?: number; deletions?: number }[];
  excluded?: { path: string; reason?: string }[];
  rules?: { name: string; sha256?: string; appliesTo?: string[] }[];
  contract?: { kind: string; ref: string; sha256: string };
}

export type FindingDisposition = "open" | "fixed" | "false_positive" | "accepted";
export type FindingOrigin = "introduced" | "pre_existing" | "indeterminate";

/** One finding of a `ReviewRecordV1`. `blocking`/`advisory` are the hub's `important`/`nit` in this vocabulary. */
export interface RecordFinding {
  id: string;
  term: "bugs" | "security" | "compliance";
  severity: "blocking" | "advisory";
  path?: string;
  anchor?: unknown;
  text: string;
  disposition: FindingDisposition;
  rationale?: string;
  origin: FindingOrigin;
  evidence?: string[];
}

/** The report a reviewer records for one packet: `v: 1`, as the spec's Contract section states it. */
export interface ReviewRecordV1 {
  v: 1;
  packet: PacketBlock;
  reviewer: { id: string; modelFamily: string; model?: string; started: "self" | "manual"; implementer?: string; sameFamilyFallback: boolean };
  coverage: { reviewed: string[]; skipped: { path: string; reason: string }[] };
  findings: RecordFinding[];
  verdict: "approved" | "changes_requested";
  call: { ok: boolean; error?: string };
  /** The review was made without a REVIEW.md (`arev record --light` only), which `arev gate` accepts (spec AC2). */
  light?: boolean;
}

/**
 * Ported from `@staix/agent-mem` `src/memory/screen.ts` at 0.40.0. A secret-looking string is refused before it is
 * written: the ledger outlives the session that wrote it.
 */
const SECRETS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{40,}/, /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i];
export const secretShaped = (text: string): boolean => SECRETS.some(re => re.test(text));

const MAX_EVENT_BYTES = 256 * 1024;
/**
 * Ledger reads go through `reviewGit`, so they describe the same checkout the packet does: an inherited `GIT_DIR` or
 * `GIT_WORK_TREE` would key the ledger to one repository while `arev packet` built a packet for another.
 */
const git = (cwd: string, args: string[]): string | undefined => {
  const result = reviewGit(cwd, args, { literalPathspecs: false });
  // Only the line ending git appends is stripped: `trim()` would also eat spaces that belong to the value, and
  // `rev-parse --show-toplevel` prints the worktree root that the containment check compares against.
  return result.status === 0 ? result.stdout.replace(/\r?\n$/, "") : undefined;
};

/** `host/owner/repo`, lowercased on GitHub; a non-default port stays part of the host. */
function normalizeOrigin(url: string): string | undefined {
  const scheme = /^([a-z+]+):\/\/(?:[^@/]+@)?(\[[^\]/]+\]|[^/:]+)(?::(\d*))?\/(.+?)(?:\.git)?\/?$/i.exec(url);
  const defaults: Record<string, string> = { ssh: "22", "git+ssh": "22", "ssh+git": "22", https: "443", http: "80", git: "9418" };
  const scp = scheme || url.includes("://") ? undefined : /^(?:[^@/]+@)?(\[[^\]/]+\]|[^/:]+):(.+?)(?:\.git)?\/?$/.exec(url);
  const parts = scheme
    ? [!scheme[3] || scheme[3] === defaults[scheme[1]!.toLowerCase()] ? scheme[2]! : `${scheme[2]}:${scheme[3]}`, scheme[4]!] as const
    : scp ? [scp[1]!, scp[2]!.startsWith("/") ? scp[2]!.replace(/^\/+/, "") : scp[2]!.startsWith("~") ? scp[2]! : `~/${scp[2]}`] as const : undefined;
  if (!parts || !parts[1]) return undefined;
  const host = parts[0].toLowerCase();
  return host === "github.com" ? `${host}/${parts[1].replace(/^~\/?/, "").toLowerCase()}` : `${host}/${parts[1]}`;
}

/** The project's ledger key. */
export function reviewProjectId(cwd: string): string {
  const origin = git(cwd, ["remote", "get-url", "origin"]);
  // Whitespace around a URL is not part of it, so the one value that is trimmed is this one; a path is never trimmed.
  const normalized = origin ? normalizeOrigin(origin.trim()) : undefined;
  if (normalized) return normalized;
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  let root = cwd;
  try {
    root = top ? realpathSync(top) : realpathSync(cwd);
  } catch {
    root = top ?? resolve(cwd);
  }
  return `${basename(root)}@${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

/** `$AGENTHUB_HOME` (default `~/.agenthub`), resolved. */
export const reviewHome = (home?: string): string => resolve(home ?? (process.env.AGENTHUB_HOME?.trim() || join(homedir(), ".agenthub")));

/** A path with its existing ancestors resolved, so a symlinked temp root compares as the worktree does. */
export function comparablePath(path: string): string {
  let current = resolve(path), suffix = "";
  for (let step = 0; step < 64; step++) {
    try {
      return join(realpathSync(current), suffix);
    } catch { /* not there yet: compare its nearest existing parent */ }
    const parent = dirname(current);
    if (parent === current) break;
    suffix = suffix ? join(basename(current), suffix) : basename(current);
    current = parent;
  }
  return resolve(path);
}

/**
 * `<home>/review/<project-id>/ledger.jsonl`. A ledger inside the reviewed worktree is refused: it would travel with
 * the branch and let a change rewrite the review it is judged by.
 */
export function ledgerPath(cwd: string, options: { home?: string } = {}): string {
  const home = reviewHome(options.home), review = join(home, "review");
  const segments = reviewProjectId(cwd).split("/");
  const path = join(review, ...segments, "ledger.jsonl");
  // The project key comes from the origin URL, which is not arev's to trust: a `..` or an empty segment would put the
  // ledger outside `<home>/review`, beside another project's.
  if (segments.some(segment => !segment || segment === "." || segment === "..") || !path.startsWith(review + sep)) {
    throw new Refusal("the origin remote does not name a plain repository path, so the ledger directory is refused",
      "set origin to a plain host/owner/repo URL, or remove it to key the ledger by the working tree");
  }
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top) {
    const root = comparablePath(top), inside = (candidate: string) => candidate === root || candidate.startsWith(root + sep);
    if (inside(comparablePath(path)) || inside(comparablePath(home))) {
      throw new Refusal(`AGENTHUB_HOME resolves inside the reviewed worktree (${home}); the ledger is never kept there`,
        `set AGENTHUB_HOME to a directory outside ${top}`);
    }
  }
  return path;
}

/** Every string an event carries, keys included, as it was written: `JSON.stringify` escapes whitespace first. */
export function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* stringsIn(item);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      yield key;
      yield* stringsIn(item);
    }
  }
}

/** One line per event, appended. The file is never rewritten, truncated or reordered. */
export function appendEvent(cwd: string, event: LedgerEvent, options: { home?: string } = {}): void {
  const line = JSON.stringify(event);
  if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new Refusal(`the ${event.type} event exceeds ${MAX_EVENT_BYTES} bytes; shorten its text`, "arev show");
  // A tab or newline inside a string becomes the two characters `\t` / `\n` in the line, so an assignment the pattern
  // needs whitespace for (`token<TAB>: <value>`) stops matching there. Every string is screened as it was written, and
  // the line as well: serialization also joins a key to its value.
  if ([...stringsIn(event)].some(secretShaped) || secretShaped(line)) {
    throw new Refusal(`the ${event.type} event matches a secret pattern and was not written`,
      "remove the secret value from the report or rationale and retry");
  }
  const path = ledgerPath(cwd, options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, line + "\n", { mode: 0o600 });
}

/** Every event in file order. A malformed line is reported, never skipped or repaired. */
export function readLedger(cwd: string, options: { home?: string } = {}): LedgerEvent[] {
  let text: string;
  try {
    text = readFileSync(ledgerPath(cwd, options), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: LedgerEvent[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line) as LedgerEvent);
    } catch {
      throw new Refusal(`ledger line ${index + 1} is not valid JSON; the ledger is append-only and is not repaired`,
        `inspect ${ledgerPath(cwd, options)}`);
    }
  });
  return events;
}

/** Sorted-key JSON, so two spellings of one value hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The record's id: the sha256 of its canonical JSON, the same rule the packet id follows. */
export const recordId = (record: ReviewRecordV1): string => createHash("sha256").update(canonicalJson(record)).digest("hex");
