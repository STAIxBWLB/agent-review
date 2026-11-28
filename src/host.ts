/**
 * `arev host` (spec #24 AC1, AC2): which reviewer to run for a pull request, and the model it will use.
 *
 * Ported from ai-workspace `_meta/scripts/ocr_review_host.py` (`choose`, `available_hosts`, `model_of`) at
 * ai-workspace@dd8997e215be170fb14fced7aa97ea8eec17ff70, the script the OCR gate used for this decision before arev
 * took that role. Three deliberate differences, each from spec #24 rather than from the port:
 *
 * - the same-family reason is spelled `same-family fallback`, where the script printed `same-ai fallback: ...`;
 * - a host is available when its CLI is on PATH, so `claude` is resolved like the other two (the script counted it as
 *   always available because OCR ran it as a subagent);
 * - `--implementer` is any identity, not only a review host: an implementer can be a peer that is never a host (`qwen`),
 *   and the script's `choices=ORDER` would have refused to name it.
 */
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EXIT } from "@staix/cli-output";
import { secretShaped } from "./ledger.ts";
import { PacketUsageError } from "./packet-cli.ts";
import { PR_NUMBER } from "./record.ts";

/** The default rotation order and the only ids `--hosts`, `--unavailable` and a host config accept. */
export const HOST_ORDER: readonly string[] = ["claude", "codex", "kimi"];

/** A chosen host with what it skipped to reach and, when nothing could run, no host at all. */
export interface HostChoice {
  host?: string;
  reason: string;
  considered: { host: string; skipped: "implementer" | "unavailable" }[];
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_CONFIG_BYTES = 64 * 1024, MAX_MODEL_BYTES = 128;
const MAX_CLAUDE_CONFIG_BYTES = 1024 * 1024;
const BLOCKED = "blocked: no review host can run";
/**
 * The variables that relocate host configuration directories, and the files and top-level keys that supply models
 * (spec #24 AC2 and #37 AC1).
 */
const CONFIG_HOME_VARIABLES: Record<string, string | undefined> = {
  claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", kimi: "KIMI_CODE_HOME",
};
const HOST_CONFIG: Record<string, { directory: string; file: string; key: string } | undefined> = {
  claude: { directory: ".claude", file: "settings.json", key: "model" },
  codex: { directory: ".codex", file: "config.toml", key: "model" },
  kimi: { directory: ".kimi-code", file: "config.toml", key: "default_model" },
};

/** The variable that relocates a host's own config home, or undefined for an id arev does not know. */
export function hostConfigVariable(host: string): string | undefined {
  return CONFIG_HOME_VARIABLES[host];
}
/**
 * The only flag value a refusal echoes: an identity in that charset that also matches no secret pattern. A flag value is
 * the caller's untrusted text and stderr is output, so anything else is named as withheld - and composing both screens
 * here is deliberate, because the secret screen alone still passes control characters through.
 */
const echoIdentity = (value: string): string => IDENTITY.test(value) && !secretShaped(value) ? value : "<withheld>";

/**
 * Rotation from the pull request number, the implementer skipped, an unavailable host skipped, and the implementer
 * chosen only when it is the last one left (spec #24 AC1).
 */
export function chooseHost(pr: number, implementer: string, available: ReadonlySet<string>, order: readonly string[]): HostChoice {
  if (order.length === 0) return { reason: BLOCKED, considered: [] };
  const start = pr % order.length;
  const rotation = order.map((_, index) => order[(start + index) % order.length]!);
  const considered: HostChoice["considered"] = [];
  for (const host of rotation) {
    if (host === implementer) {
      considered.push({ host, skipped: "implementer" });
      continue;
    }
    if (!available.has(host)) {
      considered.push({ host, skipped: "unavailable" });
      continue;
    }
    // The first host in the rotation is the rotation's own answer; anything reached past it is a fallback, and the
    // implementer is skipped before the first host can be, so reaching past it with the implementer first is that skip.
    const reason = rotation[0] === host ? "rotation" : implementer === rotation[0] ? "implementer skip" : "fallback";
    return { host, reason, considered };
  }
  return available.has(implementer) ? { host: implementer, reason: "same-family fallback", considered } : { reason: BLOCKED, considered };
}

/** Find the executable once so a later cwd change cannot select a different program. */
export function hostExecutable(cli: string, pathEnv: string, allowed = (_path: string) => true): string | undefined {
  for (const directory of pathEnv.split(delimiter)) {
    // An empty component means the current directory to a shell and to `which`, and this process runs inside the
    // reviewed checkout: a `codex` planted there would be resolved and started. So an empty component is skipped,
    // which is a deliberate difference from the shell rather than an oversight.
    if (!directory) continue;
    const candidate = join(directory, cli);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      const path = realpathSync(candidate);
      if (allowed(path)) return resolve(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

export function onPath(cli: string, pathEnv: string): boolean {
  return hostExecutable(cli, pathEnv) !== undefined;
}

/** The hosts of `order` whose CLI is on PATH and that `--unavailable` does not name. */
export function availableHosts(unavailable: ReadonlySet<string>, pathEnv: string, order: readonly string[] = HOST_ORDER): Set<string> {
  return new Set(order.filter(host => !unavailable.has(host) && onPath(host, pathEnv)));
}

/** Read Claude settings from a real config directory and a bounded regular file. */
function readClaudeSettings(directory: string, file: string): Record<string, unknown> | undefined {
  const configHome = resolve(directory);
  if (!lstatSync(configHome).isDirectory()) return undefined;
  const fd = openSync(join(configHome, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CLAUDE_CONFIG_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_CLAUDE_CONFIG_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > MAX_CLAUDE_CONFIG_BYTES) return undefined;
    const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
    if (document === null || typeof document !== "object" || Array.isArray(document)) return undefined;
    return document as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

/**
 * The model named by the host's config, or `unknown`. Use the top-level key from the parsed document so a model-like
 * line inside a TOML comment or multiline string cannot supply the name. An empty relocation variable uses the
 * default config directory under the caller's HOME.
 */
export function modelOf(host: string, home: string, env: Readonly<Record<string, string | undefined>> = {}): string {
  const config = HOST_CONFIG[host];
  if (!config) return "unknown";
  const variable = hostConfigVariable(host);
  const relocated = variable === undefined ? undefined : env[variable];
  const directory = relocated === undefined || relocated === "" ? join(home, config.directory) : relocated;
  let document: Record<string, unknown> | undefined;
  try {
    if (host === "claude") {
      document = readClaudeSettings(directory, config.file);
    } else {
      const text = readFileSync(join(directory, config.file), "utf8");
      if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) return "unknown";
      document = Bun.TOML.parse(text) as Record<string, unknown>;
    }
  } catch {
    return "unknown";
  }
  const value = document && Object.hasOwn(document, config.key) ? document[config.key] : undefined;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > MAX_MODEL_BYTES
    || /[\p{Cc}\p{Cf}]/u.test(value) || secretShaped(value)
    || (host === "claude" && !/^[A-Za-z0-9._:-]{1,128}$/.test(value))) return "unknown";
  return value;
}

/** A comma-separated or repeated flag's ids, in the order given. */
function ids(values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean);
}

/**
 * `arev host --pr N --implementer ID [--hosts LIST] [--unavailable ID...] [--json]`.
 *
 * Reads no repository and writes no ledger: the answer is the choice and the model, and `--json` prints them for an agent
 * that would otherwise parse the lines.
 */
export function hostCommand(_cwd: string, args: readonly string[]): number {
  const usage = "Choose arev host --pr N --implementer ID [--hosts LIST] [--unavailable ID]... [--json]. "
    + "Repeat --unavailable once per host, or comma-separate its ids; a bare second id is a positional and is refused.";
  const options = { pr: { type: "string" }, implementer: { type: "string" }, hosts: { type: "string", multiple: true },
    unavailable: { type: "string", multiple: true }, json: { type: "boolean" } } as const;
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], allowPositionals: true, strict: true, tokens: true, options });
  } catch {
    throw new PacketUsageError(usage);
  }
  const { values, positionals, tokens } = parsed;
  // A flag may repeat only where its own spec says so: `--unavailable codex --unavailable kimi` is two hosts to exclude,
  // while `--pr 1 --pr 2` is one question asked twice. Reading `multiple` off the spec keeps the two in step, and a token
  // carries the flag's name without its dashes, which is the form both sides of this comparison use.
  const repeatable = new Set(Object.entries(options)
    .filter(([, spec]) => "multiple" in spec).map(([name]) => name));
  const flags = tokens.filter(token => token.kind === "option").map(token => token.name).filter(name => !repeatable.has(name));
  if (positionals.length !== 0 || flags.length !== new Set(flags).size) throw new PacketUsageError(usage);

  const pr = values.pr;
  if (pr === undefined || !PR_NUMBER.test(pr) || !Number.isSafeInteger(Number(pr))) {
    throw new PacketUsageError("Pass the pull request number to --pr: arev host rotates the hosts by it.");
  }
  const implementer = values.implementer;
  if (implementer === undefined) throw new PacketUsageError("Pass the implementer's identity to --implementer, so arev can keep the review off its own AI.");
  if (!IDENTITY.test(implementer)) throw new PacketUsageError("--implementer takes an identity such as claude, codex or qwen: letters, digits, dots, dashes or underscores.");

  const given = ids(values.hosts);
  const order = given.length === 0 ? HOST_ORDER : given;
  const unavailable = new Set(ids(values.unavailable));
  const unknown = [...order, ...unavailable].find(host => !HOST_ORDER.includes(host));
  if (unknown !== undefined) {
    throw new PacketUsageError(`arev does not know the host ${echoIdentity(unknown)}: --hosts and --unavailable take ${HOST_ORDER.join(", ")}.`);
  }

  const available = availableHosts(unavailable, process.env.PATH ?? "", order);
  const choice = chooseHost(Number(pr), implementer, available, order);
  const model = choice.host === undefined ? undefined : modelOf(choice.host, process.env.HOME ?? homedir(), process.env);
  // One instruction, two surfaces: `--json` carries it as `next` and the text branch prints it, so an agent reading the
  // JSON learns the same step as a person reading the lines (issue #32).
  const next = choice.host === undefined
    ? `put one of ${order.join(", ")} on PATH and drop it from --unavailable, then run arev host again`
    : undefined;

  if (values.json) {
    console.log(JSON.stringify({ ...choice, ...(model === undefined ? {} : { model }), ...(next === undefined ? {} : { next }) }, null, 2));
  } else {
    console.log(`host: ${choice.host ?? "none"}`);
    if (model !== undefined) console.log(`model: ${model}`);
    console.log(`reason: ${choice.reason}`);
    for (const item of choice.considered) console.log(`  ${item.host}: ${item.skipped}`);
    if (next !== undefined) console.log(`next: ${next}`);
  }
  return choice.host === undefined ? EXIT.fail : EXIT.ok;
}
