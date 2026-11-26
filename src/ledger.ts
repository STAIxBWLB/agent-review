/**
 * The review ledger: one append-only JSONL file per project, never inside the reviewed worktree.
 *
 * `<project-id>` is the project key `@staix/agent-mem` derives from the origin remote (`memoryProjectKey`,
 * `src/memory/project.ts`), normalized to host and path, so every machine and every worktree of one repository
 * resolves to the same ledger. Without an origin, the key is the working root's name plus a short hash of its
 * path, the same shape amem falls back to.
 */
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
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
  | { v: 1; type: "resolve"; at: string; head: string; finding: string; as: "fixed" | "false_positive" | "accepted"; pr?: number; evidence?: string[]; rationale?: string }
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
 *
 * These are the shapes that hold wherever they sit, so each is applied to every decoded string and to the serialized
 * line as well: in a JSON line a key and its value are separate strings, and only the line holds both - `{"token":"x",
 * "v":1}` is a secret the per-string screen never sees whole.
 */
const SHAPE_SECRETS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{40,}/, /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i];

/**
 * The URL pattern is the local addition: a remote or a diagnostic can carry `scheme://user:password@host`, which no
 * token-shaped pattern catches. The colon before the `@` is what makes it a credential, so `ssh://git@host` (no
 * password) and `https://host:443/path` (no userinfo) stay clean. The user name may be empty - `https://:pw@host` is a
 * credential - and the authority ends at `/`, `?` or `#`, so `https://host:443?to=a@b` is a query, not userinfo.
 *
 * Userinfo may carry every sub-delim RFC 3986 allows, `,` and `'` among them, so both classes admit them: a password can
 * be `pa,ss` or `it's`, and excluding those characters let such a credential through the screen. Only the two characters
 * a URL cannot carry unencoded - a quote and an angle bracket - end the classes.
 *
 * That width is why this class is applied to one decoded string at a time and never to a serialized line: a JSON line
 * puts two fields side by side, so `"text":"https://example.org:443","rationale":"a@b.example"` reads as
 * `...host:443","rationale":"a@b...` - a colon, then the delimiters between the fields, then an `@`. `secretShaped`
 * screens the strings and `lineShaped` screens the line, and a field delimiter therefore can never join two values.
 */
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s\/?#:@\"<>]*:[^\s\/?#@\"<>]+@/i;
/** Every pattern one decoded string is screened with, the URL class included. */
const SECRETS = [...SHAPE_SECRETS, URL_USERINFO];
export const secretShaped = (text: string): boolean => SECRETS.some(re => re.test(text));
/**
 * The screen of a serialized event line: the shape patterns only. The URL class belongs to a single decoded string,
 * because a line is where two unrelated fields sit side by side.
 */
export const lineShaped = (line: string): boolean => SHAPE_SECRETS.some(re => re.test(line));

/**
 * A validated string a refusal may print: the value itself, or `<withheld>` when it is secret-shaped. A `\u` escape
 * decodes into a secret the raw-text screen cannot see, so this guard is what keeps the decoded value out of the message
 * whichever field carried it.
 */
export const shown = (value: string): string => secretShaped(value) ? "<withheld>" : value;

const MAX_EVENT_BYTES = 256 * 1024;
/**
 * A packet event is larger than any other by construction: one unit per changed file plus, per rule, the paths that
 * rule applied to. The 500-file ceiling (`MAX_FILES` in `src/packet.ts`) with 160-byte paths and three rules covering
 * them measures about 360 KB. A record embeds the packet it was validated against, so this bounds that block too.
 */
const MAX_PACKET_EVENT_BYTES = 1024 * 1024;
/** The report bound: `arev record` refuses a report file over this many bytes, measured before the file is parsed. */
export const MAX_REPORT_BYTES = 1024 * 1024;
/**
 * A record's stored line carries no cap of its own, because it is built from two bounded inputs and `sanitize`
 * (`src/frame.ts`) inflates the larger of them by more than any fixed ratio: it prefixes `> ` to every line of a run
 * that ends in a header-looking line, and its `\s*` lookahead crosses line breaks, so one blank line goes in and three
 * bytes come out. A cap below that worst case refused a report that fits (issue #15); a cap at it is the same growth
 * guess with a bigger number. So the bound is read where each input is: the packet block below, the report in
 * `src/record.ts` before it is parsed, and each text the report carries after framing where that text is validated.
 */
const eventCap = (type: LedgerEvent["type"]): number | undefined =>
  type === "record" ? undefined : type === "packet" ? MAX_PACKET_EVENT_BYTES : MAX_EVENT_BYTES;

/** The packet a record embeds is held to its own event's bound: a packet that can be written can be recorded. */
function checkRecordPacket(record: ReviewRecordV1): void {
  const packet = Buffer.byteLength(JSON.stringify(record.packet));
  if (packet > MAX_PACKET_EVENT_BYTES) {
    throw new Refusal(`the packet in this record event is ${packet} bytes, over the ${MAX_PACKET_EVENT_BYTES} bytes a packet event may be; shorten it`,
      "build the packet with arev packet and record the report it wrote");
  }
}
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

/**
 * Origin, normalized to the `host/owner/repo` the ledger's key is built from. It is the one repository name arev may
 * act on: what gh resolves for itself (`GH_REPO`, the working directory) is not this.
 */
export function reviewOrigin(cwd: string): string | undefined {
  const origin = git(cwd, ["remote", "get-url", "origin"]);
  // Whitespace around a URL is not part of it, so the one value that is trimmed is this one; a path is never trimmed.
  return origin ? normalizeOrigin(origin.trim()) : undefined;
}

/**
 * `owner/repo` of the GitHub repository origin names, or undefined when origin names no GitHub repository. Both GitHub
 * calls that name a repository read it here: `arev packet --pr` reads a pull request and `arev gate --post` writes a
 * status, and gh's own resolution (`GH_REPO`, the working directory) may name another repository - a fork's PR N is not
 * the PR the ledger keyed and reviewed.
 */
export function githubRepository(cwd: string): string | undefined {
  const [host, owner, repo, extra] = (reviewOrigin(cwd) ?? "").split("/");
  return host === "github.com" && owner && repo && extra === undefined ? `${owner}/${repo}` : undefined;
}

/** The project's ledger key. */
export function reviewProjectId(cwd: string): string {
  const normalized = reviewOrigin(cwd);
  if (normalized) return normalized;
  // Linked worktrees of one repository share `--git-common-dir`, and a key hashed from the worktree root gave each of
  // them its own ledger, so one repository reviewed from two worktrees had two halves of one history. A common dir named
  // `.git` makes its parent the working root, which every worktree of that repository agrees on - the resolution
  // agent-mem's own project key uses. The common dir is printed relative to `cwd`, so it is resolved before it is read.
  const common = git(cwd, ["rev-parse", "--git-common-dir"]);
  const shared = common === undefined ? undefined : comparablePath(resolve(cwd, common));
  const root = shared === undefined ? comparablePath(cwd) : basename(shared) === ".git" ? dirname(shared) : shared;
  return `${basename(root)}@${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

/** `$AGENTHUB_HOME` (default `~/.agenthub`), resolved. */
export const reviewHome = (home?: string): string => resolve(home ?? (process.env.AGENTHUB_HOME?.trim() || join(homedir(), ".agenthub")));

/** A path with its existing ancestors resolved, so a symlinked temp root compares as the worktree does. */
export function comparablePath(path: string): string {
  let current = resolve(path), suffix = "";
  for (;;) {
    try {
      return join(realpathSync(current), suffix);
    } catch { /* not there yet: compare its nearest existing parent */ }
    const parent = dirname(current);
    // The filesystem root ends the walk. A fixed step count would stop mid-path, and the caller would then compare a
    // path spelled through a symlink with the resolved one - the mismatch this resolution exists to prevent.
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
      throw new Refusal(`AGENTHUB_HOME resolves inside the reviewed worktree (${shown(home)}); the ledger is never kept there`,
        `set AGENTHUB_HOME to a directory outside ${shown(top)}`);
    }
  } else if (gitMarkerAtOrAbove(cwd)) {
    // The probe failed where a `.git` exists, so this is a checkout whose root arev cannot read (dubious ownership, an
    // unreadable gitdir) and the containment check would be skipped rather than answered. A refusal there is the only
    // fail-closed read; the same empty probe outside any repository is the supported case, which stays readable.
    throw new Refusal(`arev cannot read the worktree root of ${shown(cwd)}, so where the ledger lives cannot be checked`,
      "run arev from inside the checkout and make sure git can read it (git status)");
  }
  return path;
}

/**
 * Whether a `.git` entry sits at or above `cwd`: the signal that separates a broken checkout from no repository at all.
 * `lstat` rather than `exists`, because a marker that exists but cannot be followed - a symlink to a target that is gone,
 * a directory this process may not search - is exactly the checkout the refusal above is for. Reading it as absence
 * would skip the containment check, which is the fail-open this signal was added to close.
 */
function gitMarkerAtOrAbove(cwd: string): boolean {
  let current = resolve(cwd);
  for (;;) {
    // A `.git` directory, and the `.git` file a linked worktree or a submodule carries, both count.
    try {
      lstatSync(join(current, ".git"));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only "there is no such entry" continues upward; a read that was refused is a marker arev cannot rule out.
      if (code !== "ENOENT" && code !== "ENOTDIR") return true;
    }
    const parent = dirname(current);
    // The filesystem root ends the search, and only the root does: a fixed ancestor count would report "no marker" for
    // a checkout deeper than the count, which is the fail-open this probe exists to close.
    if (parent === current) return false;
    current = parent;
  }
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
  const cap = eventCap(event.type);
  if (cap !== undefined && Buffer.byteLength(line) > cap) throw new Refusal(`the ${event.type} event exceeds ${cap} bytes; shorten its text`, "arev show");
  if (event.type === "record") checkRecordPacket(event.record);
  // A tab or newline inside a string becomes the two characters `\t` / `\n` in the line, so an assignment the pattern
  // needs whitespace for (`token<TAB>: <value>`) stops matching there. Every string is screened as it was written with
  // the full list, and the line with `lineShaped`: the line is where a key and its value sit together, and also where
  // two unrelated fields sit together, so the URL class - which a decoded string may need in full - is left out of it.
  if ([...stringsIn(event)].some(secretShaped) || lineShaped(line)) {
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
