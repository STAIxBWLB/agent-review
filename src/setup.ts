/**
 * `arev setup claude|codex|kimi|pi|qwen|jcode|agy [--apply|--undo]`: register `arev mcp` with a coding host and install
 * the `arev-review` skill. Preview by default, as the sibling family CLIs behave: nothing is written until `--apply`.
 *
 * ponytail: the host table is hand-written because `@staix/agent-hosts` is not released. Ceiling: a host that moves its
 * config file or renames its server key needs this table edited, and the skill directory for pi, jcode and agy is the
 * sibling family's rule (`<host dir>/skills`) rather than a documented path of its own. The upgrade path is to read the
 * table from that package once it ships, which deletes this file's per-host knowledge and its environment overrides.
 *
 * The receipt is what makes `--undo` safe: it keeps the bytes the config had before the write AND the bytes the write
 * produced, so undo restores only a file still holding what arev wrote and refuses to discard anything a person changed
 * afterwards. It is keyed by the config path, because `agy` is workspace-scoped and two workspaces are two
 * registrations, removed one at a time.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EXIT } from "@staix/cli-output";
import { Refusal, reviewHome } from "./ledger.ts";

export interface SetupHost {
  /** The file that holds the host's MCP server entries. */
  config: string;
  /** How that file stores them. */
  format: "json" | "toml";
  /** The key holding the entries: `mcpServers` for most, `servers` for jcode, `mcp_servers` in TOML. */
  key: string;
  /** Where the host reads skills from. */
  skills: string;
  /** What the preview says about this host, when it needs saying. */
  note?: string;
}

const HOST_NAMES = ["claude", "codex", "kimi", "pi", "qwen", "jcode", "agy"] as const;
export type SetupHostName = typeof HOST_NAMES[number];
const SERVER = "arev", SKILL = "arev-review";

/** `$VAR` when it is set and non-empty, else `home/<fallback>`. */
const root = (env: NodeJS.ProcessEnv, home: string, name: string, fallback: string): string => {
  const value = env[name]?.trim();
  return value ? resolve(value) : join(home, fallback);
};

/**
 * The seven hosts of AC9 with the paths and formats the sibling family uses: JSON under `mcpServers` (jcode under
 * `servers`), codex's TOML under `mcp_servers`, and each host's own directory environment variable when it sets one.
 */
export function setupHosts(cwd: string, env: NodeJS.ProcessEnv = process.env): Record<SetupHostName, SetupHost> {
  const home = resolve(env.HOME?.trim() || homedir());
  const claude = root(env, home, "CLAUDE_CONFIG_DIR", ".claude");
  const codex = root(env, home, "CODEX_HOME", ".codex");
  const kimi = root(env, home, "KIMI_CODE_HOME", ".kimi-code");
  const pi = root(env, home, "PI_CODING_AGENT_DIR", join(".pi", "agent"));
  const qwen = root(env, home, "QWEN_HOME", ".qwen");
  const jcode = root(env, home, "JCODE_HOME", ".jcode");
  // Claude keeps `settings.json` and its skills inside `$CLAUDE_CONFIG_DIR` (or `~/.claude`), but its server list
  // lives in `.claude.json` beside the home directory unless the variable moves that file too.
  const claudeConfig = env.CLAUDE_CONFIG_DIR?.trim() ? join(claude, ".claude.json") : join(home, ".claude.json");
  return {
    claude: { config: claudeConfig, format: "json", key: "mcpServers", skills: join(claude, "skills") },
    codex: { config: join(codex, "config.toml"), format: "toml", key: "mcp_servers", skills: join(codex, "skills") },
    kimi: { config: join(kimi, "mcp.json"), format: "json", key: "mcpServers", skills: join(kimi, "skills") },
    pi: { config: join(pi, "mcp.json"), format: "json", key: "mcpServers", skills: join(pi, "skills"),
      note: "pi reads this server from its agent directory; confirm pi's skill directory before relying on the installed skill." },
    qwen: { config: join(qwen, "settings.json"), format: "json", key: "mcpServers", skills: join(qwen, "skills") },
    jcode: { config: join(jcode, "mcp.json"), format: "json", key: "servers", skills: join(jcode, "skills"),
      note: "jcode keys its servers under `servers`, which is the sibling family's reading of its mcp.json." },
    // Antigravity is workspace-scoped: its config lives beside the reviewed repository, not in the home directory.
    agy: { config: join(cwd, ".agents", "mcp_config.json"), format: "json", key: "mcpServers", skills: join(cwd, ".agents", "skills"),
      note: "agy's config is workspace-scoped, so this registration applies to this repository only." },
  };
}

/** The command a host launches: the running Bun, then this package's own entry point. */
function launch(): { command: string; args: string[] } {
  return { command: process.execPath, args: [join(dirname(import.meta.dir), "bin", "arev.js"), "mcp"] };
}

interface ReceiptFile { name: string; sha: string }

interface Receipt {
  v: 2;
  host: string;
  /** The config file as it was, and as this install left it: undo restores only a file still holding `after`. */
  config: { path: string; before: string | null; after: string };
  /** The skill directory the install wrote, its files and their hashes, so undo takes back only what it installed. */
  skill: { dir: string; files: ReceiptFile[] };
  /** Every directory the install created, outermost first, so `--undo` can remove exactly them. */
  created: string[];
}

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const digest = (value: string): string => sha256(value).slice(0, 16);

/**
 * One receipt per host and config file. The config path is in the key because a workspace-scoped host registers into
 * the workspace: two repositories are two registrations, and one receipt for both would undo only the last one.
 */
const receiptPath = (host: string, config: string): string => join(reviewHome(), "setup", `${host}-${digest(resolve(config))}.json`);

/**
 * Run one filesystem step, turning an errno failure into a refusal that names the path and the next step. Node's own
 * message carries the operation and path, and a raw `EACCES` escaping as an internal error names neither.
 */
function attempt<T>(action: () => T, path: string, doing: string): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof Refusal) throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "unknown error";
    throw new Refusal(`cannot ${doing} ${path} (${code})`,
      `check that path's permissions and that its parent is a directory, then run arev setup again`);
  }
}

/** One line per change `--apply` would make, plus what it cannot promise. */
export function setupPreview(host: SetupHostName, hosts: Record<SetupHostName, SetupHost>): string[] {
  const target = hosts[host], { command, args } = launch();
  const lines = [
    `${host}: register \`${SERVER}\` in ${target.config} (${target.format} key \`${target.key}\`)`,
    `${host}: command ${command} ${args.join(" ")}`,
    `${host}: install the ${SKILL} skill in ${target.skills}`,
  ];
  if (target.note) lines.push(`${host}: ${target.note}`);
  return lines;
}

/** Set one server entry, refusing a file that is not the plain object the host expects. */
function withServer(text: string | null, host: SetupHost): string {
  const { command, args } = launch();
  if (host.format === "toml") {
    const block = `[${host.key}.${SERVER}]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map(arg => JSON.stringify(arg)).join(", ")}]\n`;
    const current = text ?? "";
    if (current.includes(`[${host.key}.${SERVER}]`)) {
      throw new Refusal(`${host.config} already has an [${host.key}.${SERVER}] entry`, "remove that section and run arev setup again, or edit it by hand");
    }
    return `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}\n${block}`;
  }
  let document: Record<string, unknown> = {};
  if (text !== null && text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Refusal(`${host.config} is not valid JSON`, "fix that file and run arev setup again; this command never rewrites a file it cannot read");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Refusal(`${host.config} does not hold a JSON object`, "fix that file and run arev setup again");
    }
    document = parsed as Record<string, unknown>;
  }
  const servers = document[host.key];
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Refusal(`${host.config} has a non-object \`${host.key}\``, "fix that file and run arev setup again");
  }
  // An `arev` entry with no receipt behind it was not written here: adopting it would let a later `--undo` delete or
  // restore bytes this command never owned.
  if (servers !== undefined && Object.hasOwn(servers as Record<string, unknown>, SERVER)) {
    throw new Refusal(`${host.config} already has an \`${SERVER}\` entry that arev setup did not write`,
      `remove that entry and run arev setup again, or keep it and register arev by hand`);
  }
  const next = { ...(servers as Record<string, unknown> | undefined), [SERVER]: { command, args } };
  return `${JSON.stringify({ ...document, [host.key]: next }, null, 2)}\n`;
}

const readOrNull = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);
const fileSha = (path: string): string | undefined => {
  try {
    return sha256(readFileSync(path));
  } catch {
    return undefined;
  }
};

/** Every directory between the nearest existing ancestor and `path` that does not exist yet, outermost first. */
function missingDirectories(path: string): string[] {
  const missing: string[] = [];
  for (let dir = path; dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(dir)) break;
    missing.unshift(dir);
  }
  return missing;
}

/**
 * Take back exactly this invocation's writes. Returns the paths it could not restore or remove, so the refusal names
 * what a person has to clean up: a rollback that fails silently is worse than the failure it answers.
 */
function rollback(target: SetupHost, before: string | null, installed: readonly string[], created: readonly string[]): string[] {
  const left: string[] = [];
  try {
    if (before === null) {
      if (existsSync(target.config)) unlinkSync(target.config);
    } else {
      writeFileSync(target.config, before);
    }
  } catch {
    left.push(target.config);
  }
  for (const path of installed) {
    try {
      unlinkSync(path);
    } catch {
      if (existsSync(path)) left.push(path);
    }
  }
  for (const dir of [...created].reverse()) {
    try { rmdirSync(dir); } catch { /* A directory that still holds other files stays. */ }
  }
  return left;
}

export function setupCommand(cwd: string, args: readonly string[]): number {
  const host = args.find(argument => !argument.startsWith("-"));
  const flags = args.filter(argument => argument.startsWith("-"));
  const unknown = flags.filter(flag => flag !== "--apply" && flag !== "--undo");
  try {
    if (unknown.length || flags.length !== new Set(flags).size || (flags.includes("--apply") && flags.includes("--undo"))) {
      throw new Refusal("setup takes a host and at most one of --apply or --undo", "run arev setup claude|codex|kimi|pi|qwen|jcode|agy [--apply|--undo]");
    }
    if (host === undefined) {
      throw new Refusal(`setup needs a host: ${HOST_NAMES.join(", ")}`, "run arev setup <host> to preview, then arev setup <host> --apply");
    }
    if (!HOST_NAMES.includes(host as SetupHostName)) {
      throw new Refusal(`setup does not know a host named ${host}`, `pass one of ${HOST_NAMES.join(", ")}`);
    }
    const name = host as SetupHostName, hosts = setupHosts(cwd), target = hosts[name];
    const receipt = receiptPath(name, target.config);

    if (flags.includes("--undo")) {
      const stored = readOrNull(receipt);
      if (stored === null) {
        throw new Refusal(`there is no arev setup receipt for ${name} at ${target.config}`,
          `run arev setup ${name} --apply first, or edit ${target.config} by hand`);
      }
      const saved = attempt(() => JSON.parse(stored) as Receipt, receipt, "read the arev setup receipt in");
      const current = readOrNull(saved.config.path);
      // Undo puts `before` back only over the bytes this install wrote: anything else is somebody's later work.
      if (current !== saved.config.after && current !== saved.config.before) {
        throw new Refusal(`${saved.config.path} changed since arev setup wrote it, so undo would discard those changes`,
          `put arev's own version back first, or remove the ${SERVER} entry by hand, then run arev setup ${name} --undo`);
      }
      for (const file of saved.skill.files) {
        const path = join(saved.skill.dir, file.name), sha = fileSha(path);
        if (sha !== undefined && sha !== file.sha) {
          throw new Refusal(`${path} changed since arev setup installed it, so undo would discard those changes`,
            `put the installed skill back first, or delete ${saved.skill.dir} by hand, then run arev setup ${name} --undo`);
        }
      }
      if (current === saved.config.after) {
        if (saved.config.before === null) attempt(() => unlinkSync(saved.config.path), saved.config.path, "remove");
        else attempt(() => writeFileSync(saved.config.path, saved.config.before ?? ""), saved.config.path, "restore");
      }
      for (const file of saved.skill.files) {
        try { unlinkSync(join(saved.skill.dir, file.name)); } catch { /* Already gone: undo still completes. */ }
      }
      for (const dir of [...saved.created].reverse()) {
        try { rmdirSync(dir); } catch { /* A directory that gained other files is left alone. */ }
      }
      attempt(() => unlinkSync(receipt), receipt, "remove the arev setup receipt in");
      console.log(`arev setup ${name}: undone; ${saved.config.path} has its earlier bytes back`);
      return EXIT.ok;
    }

    const lines = setupPreview(name, hosts);
    if (!flags.includes("--apply")) {
      for (const line of lines) console.log(line);
      console.log(`Preview only. Run arev setup ${name} --apply to write these changes.`);
      return EXIT.ok;
    }

    const before = readOrNull(target.config);
    // A receipt already here means an earlier apply. Re-applying would record the applied bytes as the original, and the
    // later undo would restore the registration instead of removing it.
    const existing = readOrNull(receipt);
    if (existing !== null) {
      const applied = attempt(() => JSON.parse(existing) as Receipt, receipt, "read the arev setup receipt in");
      if (readOrNull(target.config) === applied.config.after) {
        throw new Refusal(`${target.config} already registers ${SERVER} through arev setup`,
          `run arev setup ${name} --undo to take it back out, or edit the entry by hand`);
      }
      throw new Refusal(`${target.config} changed since arev setup wrote it, so arev will not register over those changes`,
        `edit the ${SERVER} entry in ${target.config} by hand, or put arev's own version back and run arev setup ${name} --undo`);
    }
    const after = withServer(before, target);
    // Everything that can refuse is decided before the first byte: a destination collision discovered halfway would
    // already have replaced somebody's file, and the undo that followed would delete it.
    const receiptDirectory = dirname(receipt);
    if (existsSync(receiptDirectory) && !statSync(receiptDirectory).isDirectory()) {
      throw new Refusal(`${receiptDirectory} is not a directory, so no receipt can be written there`,
        `move that file out of the way and run arev setup ${name} --apply again`);
    }
    const skillSource = join(dirname(import.meta.dir), "skills", SKILL);
    if (!existsSync(skillSource)) {
      throw new Refusal(`the ${SKILL} skill is missing from this install`, "reinstall the package so skills/arev-review ships with it");
    }
    const names = attempt(() => readdirSync(skillSource), skillSource, "read the skill directory in");
    const skillTarget = join(target.skills, SKILL);
    const clash = names.map(file => join(skillTarget, file)).find(path => existsSync(path));
    if (clash !== undefined) {
      throw new Refusal(`${clash} already exists, and arev setup never overwrites a file it did not write`,
        `move ${skillTarget} out of the way or delete it, then run arev setup ${name} --apply again`);
    }

    const created = [...missingDirectories(dirname(target.config)), ...missingDirectories(skillTarget)];
    // The skill hashes describe the bytes being installed, so the receipt is complete before the first write.
    const files = names.map(file => ({
      name: file,
      sha: attempt(() => sha256(readFileSync(join(skillSource, file))), join(skillSource, file), "read"),
    }));
    const saved: Receipt = { v: 2, host: name, config: { path: target.config, before, after },
      skill: { dir: skillTarget, files }, created };
    const installed: string[] = [];
    try {
      attempt(() => {
        mkdirSync(dirname(target.config), { recursive: true });
        writeFileSync(target.config, after);
      }, target.config, "write");
      attempt(() => mkdirSync(skillTarget, { recursive: true }), skillTarget, "create");
      for (const file of names) {
        const path = join(skillTarget, file);
        attempt(() => copyFileSync(join(skillSource, file), path), path, "write");
        installed.push(path);
      }
      // The receipt is this invocation's only record, so it is written inside the rollback: a failure here takes the
      // registration back rather than leaving a registered host with nothing to undo.
      attempt(() => {
        mkdirSync(receiptDirectory, { recursive: true });
        writeFileSync(receipt, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
      }, receipt, "write the arev setup receipt to");
    } catch (error) {
      const left = rollback(target, before, installed, [...created, skillTarget]);
      if (left.length > 0) {
        throw new Refusal(`arev setup did not finish, and could not take back ${left.join(", ")}`,
          `remove those paths by hand, then run arev setup ${name} --apply again`);
      }
      throw error;
    }

    console.log(`arev setup ${name}: applied; ${target.config} registers \`${SERVER}\`, skill in ${skillTarget}`);
    console.log(`arev setup ${name} --undo restores ${target.config} as it was`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(`arev: ${error.message}`);
      console.error(`next: ${error.next}`);
      return EXIT.fail;
    }
    throw error;
  }
}
