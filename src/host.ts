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
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
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
const BLOCKED = "blocked: no review host can run";

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

/** Whether `cli` is an executable file in one of the PATH directories, as a shell would run it. */
export function onPath(cli: string, pathEnv: string): boolean {
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, cli);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** The hosts of `order` whose CLI is on PATH and that `--unavailable` does not name. */
export function availableHosts(unavailable: ReadonlySet<string>, pathEnv: string, order: readonly string[] = HOST_ORDER): Set<string> {
  return new Set(order.filter(host => !unavailable.has(host) && onPath(host, pathEnv)));
}

/**
 * The value of one top-level string key of a TOML document, or `undefined`. Only the top level is read: a `model` inside
 * a profile table is not the model the host runs.
 */
function tomlString(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim();
    if (entry.startsWith("[")) return undefined;
    const match = /^([A-Za-z0-9_.-]+|"[^"]*")\s*=\s*(.+)$/.exec(entry);
    if (!match || match[1] !== key) continue;
    const value = match[2]!.trim();
    const quoted = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(value);
    if (quoted) return quoted[1]!.replaceAll(/\\(.)/g, (_, escaped: string) => escaped === "n" ? "\n" : escaped);
    const literal = /^'([^']*)'\s*(?:#.*)?$/.exec(value);
    return literal ? literal[1]! : undefined;
  }
  return undefined;
}

/**
 * The model the host's own config names, or `unknown` (spec #24 AC2). Only that one key's value leaves this function: a
 * value that is empty, over 128 bytes, carries control characters or is secret-shaped is not a model name, so it reads as
 * `unknown` rather than reaching output or, through `arev run`, the ledger.
 */
export function modelOf(host: string, home: string): string {
  const config = ({ codex: { file: ".codex/config.toml", key: "model" },
    kimi: { file: ".kimi-code/config.toml", key: "default_model" } } as Record<string, { file: string; key: string } | undefined>)[host];
  if (!config) return "unknown";
  let text: string;
  try {
    text = readFileSync(join(home, config.file), "utf8");
  } catch {
    return "unknown";
  }
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) return "unknown";
  const value = tomlString(text, config.key);
  if (value === undefined || value.length === 0 || Buffer.byteLength(value) > MAX_MODEL_BYTES
    || /[\p{Cc}\p{Cf}]/u.test(value) || secretShaped(value)) return "unknown";
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
  const usage = "Choose arev host --pr N --implementer ID [--hosts LIST] [--unavailable ID...] [--json].";
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], allowPositionals: true, strict: true, tokens: true,
      options: { pr: { type: "string" }, implementer: { type: "string" }, hosts: { type: "string", multiple: true },
        unavailable: { type: "string", multiple: true }, json: { type: "boolean" } } });
  } catch {
    throw new PacketUsageError(usage);
  }
  const { values, positionals, tokens } = parsed;
  const flags = tokens.filter(token => token.kind === "option").map(token => token.name);
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
  if (unknown !== undefined) throw new PacketUsageError(`arev does not know the host ${unknown}: --hosts and --unavailable take ${HOST_ORDER.join(", ")}.`);

  const available = availableHosts(unavailable, process.env.PATH ?? "", order);
  const choice = chooseHost(Number(pr), implementer, available, order);
  const model = choice.host === undefined ? undefined : modelOf(choice.host, process.env.HOME ?? homedir());

  if (values.json) {
    console.log(JSON.stringify({ ...choice, ...(model === undefined ? {} : { model }) }, null, 2));
  } else {
    console.log(`host: ${choice.host ?? "none"}`);
    if (model !== undefined) console.log(`model: ${model}`);
    console.log(`reason: ${choice.reason}`);
    for (const item of choice.considered) console.log(`  ${item.host}: ${item.skipped}`);
    if (choice.host === undefined) {
      console.log(`next: put one of ${order.join(", ")} on PATH and drop it from --unavailable, then run arev host again`);
    }
  }
  return choice.host === undefined ? EXIT.fail : EXIT.ok;
}
