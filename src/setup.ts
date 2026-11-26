/**
 * `arev setup claude|codex|kimi|pi|qwen|jcode|agy [--apply|--undo]`: register `arev mcp` with a coding host and install
 * the `arev-review` skill. Preview by default, as the sibling family CLIs behave: nothing is written until `--apply`.
 *
 * ponytail: the host table is hand-written because `@staix/agent-hosts` is not released. Ceiling: a host that moves its
 * config file or renames its server key needs this table edited, and the skill directory for pi, jcode and agy is the
 * sibling family's rule (`<host dir>/skills`) rather than a documented path of its own. The upgrade path is to read the
 * table from that package once it ships, which deletes this file's per-host knowledge and its environment overrides.
 *
 * `--undo` restores the bytes the config file had before `--apply` wrote it, from a receipt kept outside both the
 * reviewed worktree and the host's own tree, and removes only the directories the install created.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
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

const RECEIPT = "arev-setup.json";

interface Receipt {
  v: 1;
  host: string;
  /** The config file as it was, or null when `--apply` created it. */
  config: { path: string; before: string | null };
  /** The skill directory the install wrote, and the files in it, so `--undo` can take them back out. */
  skill: { dir: string; files: string[] };
  /** Every directory the install created, outermost first, so `--undo` can remove exactly them. */
  created: string[];
}

const receiptPath = (host: string): string => join(reviewHome(), "setup", `${host}.json`);

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
  const next = { ...(servers as Record<string, unknown> | undefined), [SERVER]: { command, args } };
  return `${JSON.stringify({ ...document, [host.key]: next }, null, 2)}\n`;
}

const readOrNull = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** Every directory between the nearest existing ancestor and `path` that does not exist yet, outermost first. */
function missingDirectories(path: string): string[] {
  const missing: string[] = [];
  for (let dir = path; dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(dir)) break;
    missing.unshift(dir);
  }
  return missing;
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

    if (flags.includes("--undo")) {
      const path = receiptPath(name);
      const text = readOrNull(path);
      if (text === null) throw new Refusal(`there is no arev setup receipt for ${name}`, `run arev setup ${name} --apply first, or edit ${target.config} by hand`);
      const receipt = JSON.parse(text) as Receipt;
      if (receipt.config.before === null) {
        if (existsSync(receipt.config.path)) unlinkSync(receipt.config.path);
      } else {
        writeFileSync(receipt.config.path, receipt.config.before);
      }
      // The directory can only be removed once the files in it are gone, so they go first.
      for (const file of receipt.skill.files) {
        try { unlinkSync(join(receipt.skill.dir, file)); } catch { /* Already gone: undo still completes. */ }
      }
      for (const dir of [...receipt.created].reverse()) {
        try { rmdirSync(dir); } catch { /* A directory that gained other files is left alone. */ }
      }
      unlinkSync(path);
      console.log(`arev setup ${name}: undone; ${receipt.config.path} has its earlier bytes back`);
      return EXIT.ok;
    }

    const lines = setupPreview(name, hosts);
    if (!flags.includes("--apply")) {
      for (const line of lines) console.log(line);
      console.log(`Preview only. Run arev setup ${name} --apply to write these changes.`);
      return EXIT.ok;
    }

    const before = readOrNull(target.config);
    const created = missingDirectories(dirname(target.config));
    mkdirSync(dirname(target.config), { recursive: true });
    writeFileSync(target.config, withServer(before, target));

    const skillSource = join(dirname(import.meta.dir), "skills", SKILL);
    if (!existsSync(skillSource)) {
      throw new Refusal(`the ${SKILL} skill is missing from this install`, "reinstall the package so skills/arev-review ships with it");
    }
    const skillTarget = join(target.skills, SKILL);
    const skillCreated = missingDirectories(skillTarget);
    mkdirSync(skillTarget, { recursive: true });
    const skillFiles = readdirSync(skillSource);
    for (const file of skillFiles) copyFileSync(join(skillSource, file), join(skillTarget, file));

    const receipt: Receipt = { v: 1, host: name, config: { path: target.config, before },
      skill: { dir: skillTarget, files: skillFiles }, created: [...created, ...skillCreated] };
    const receiptDirectory = dirname(receiptPath(name));
    mkdirSync(receiptDirectory, { recursive: true });
    writeFileSync(receiptPath(name), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });

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
