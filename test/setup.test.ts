import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setupCommand, setupHosts } from "../src/setup.ts";

const HOST_VARS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR", "QWEN_HOME", "JCODE_HOME", "AGENTHUB_HOME", "HOME"];
const cleanup: string[] = [];
const saved = new Map<string, string | undefined>();
let home = "", state = "";

beforeEach(() => {
  for (const key of HOST_VARS) saved.set(key, process.env[key]);
  home = mkdtempSync(join(tmpdir(), "arev-setup-home-"));
  state = mkdtempSync(join(tmpdir(), "arev-setup-state-"));
  cleanup.push(home, state);
  for (const key of HOST_VARS) delete process.env[key];
  process.env.HOME = home;
  process.env.AGENTHUB_HOME = state;
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

const write = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

/** The receipts this run left, under the temporary state directory rather than the real one. */
const receipts = (): string[] => {
  const dir = join(state, "setup");
  return existsSync(dir) ? readdirSync(dir) : [];
};

test("a preview writes nothing at all", () => {
  expect(setupCommand(home, ["claude"])).toBe(0);
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
  expect(existsSync(join(home, ".claude"))).toBe(false);
  expect(receipts()).toEqual([]);
});

test("--apply registers the server beside what the file already had, and --undo restores its bytes", () => {
  const config = join(home, ".claude.json");
  const before = `{\n  "theme": "dark",\n  "mcpServers": { "other": { "command": "other" } }\n}\n`;
  write(config, before);
  expect(setupCommand(home, ["claude", "--apply"])).toBe(0);
  const applied = JSON.parse(readFileSync(config, "utf8")) as { theme: string; mcpServers: Record<string, { command?: string; args?: string[] }> };
  expect(applied.theme).toBe("dark");
  expect(applied.mcpServers.other).toEqual({ command: "other" });
  expect(applied.mcpServers.arev?.args?.at(-1)).toBe("mcp");
  expect(applied.mcpServers.arev?.args?.[0]).toContain("bin");
  expect(existsSync(join(home, ".claude", "skills", "arev-review", "SKILL.md"))).toBe(true);
  expect(receipts()).toHaveLength(1);

  expect(setupCommand(home, ["claude", "--undo"])).toBe(0);
  expect(readFileSync(config, "utf8")).toBe(before);
  expect(existsSync(join(home, ".claude", "skills", "arev-review"))).toBe(false);
  expect(receipts()).toEqual([]);
});

test("a host created from nothing is removed by --undo, not left as an empty file", () => {
  expect(setupCommand(home, ["kimi", "--apply"])).toBe(0);
  const config = join(home, ".kimi-code", "mcp.json");
  expect(existsSync(config)).toBe(true);
  expect((JSON.parse(readFileSync(config, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers.arev).toBeDefined();
  expect(setupCommand(home, ["kimi", "--undo"])).toBe(0);
  expect(existsSync(config)).toBe(false);
  expect(existsSync(join(home, ".kimi-code"))).toBe(false);
});

test("codex is TOML under mcp_servers, and jcode keys its servers under `servers`", () => {
  expect(setupCommand(home, ["codex", "--apply"])).toBe(0);
  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  expect(toml).toContain("[mcp_servers.arev]");
  expect(toml).toContain("args = [");

  expect(setupCommand(home, ["jcode", "--apply"])).toBe(0);
  const jcode = JSON.parse(readFileSync(join(home, ".jcode", "mcp.json"), "utf8")) as Record<string, unknown>;
  expect(Object.keys(jcode)).toEqual(["servers"]);
  expect((jcode.servers as Record<string, unknown>).arev).toBeDefined();
});

test("agy registers into the workspace, and the table follows each host's own directory variable", () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "arev-setup-qwen-"));
  cleanup.push(elsewhere);
  process.env.QWEN_HOME = elsewhere;
  expect(setupHosts(home).qwen.config).toBe(join(elsewhere, "settings.json"));
  expect(setupHosts(home).agy.config).toBe(join(home, ".agents", "mcp_config.json"));
});

test("an unknown host, two modes at once, and an undo with no receipt are refused by name", () => {
  expect(setupCommand(home, ["cursor", "--apply"])).toBe(1);
  expect(setupCommand(home, ["claude", "--apply", "--undo"])).toBe(1);
  expect(setupCommand(home, ["qwen", "--undo"])).toBe(1);
  expect(setupCommand(home, [])).toBe(1);
});

test("a config this command cannot read is never rewritten", () => {
  const config = join(home, ".pi", "agent", "mcp.json");
  write(config, "{ not json");
  expect(setupCommand(home, ["pi", "--apply"])).toBe(1);
  expect(readFileSync(config, "utf8")).toBe("{ not json");
});

test("a second --apply is refused, so the later --undo still restores the original bytes", () => {
  const config = join(home, ".claude.json");
  const before = `{\n  "theme": "dark"\n}\n`;
  write(config, before);
  expect(setupCommand(home, ["claude", "--apply"])).toBe(0);
  // Re-applying would record the applied bytes as the original, and the undo would then restore the registration.
  expect(setupCommand(home, ["claude", "--apply"])).toBe(1);
  expect(setupCommand(home, ["claude", "--undo"])).toBe(0);
  expect(readFileSync(config, "utf8")).toBe(before);
});

test("an edit made after --apply is not overwritten, by --undo or by another --apply", () => {
  expect(setupCommand(home, ["kimi", "--apply"])).toBe(0);
  const config = join(home, ".kimi-code", "mcp.json");
  const edited = `${readFileSync(config, "utf8")}MINE\n`;
  write(config, edited);
  expect(setupCommand(home, ["kimi", "--undo"])).toBe(1);
  expect(readFileSync(config, "utf8")).toBe(edited);
  expect(receipts()).toHaveLength(1);
  expect(setupCommand(home, ["kimi", "--apply"])).toBe(1);
  expect(readFileSync(config, "utf8")).toBe(edited);
});

test("each workspace keeps its own agy registration, and undo takes out only its own", () => {
  const first = mkdtempSync(join(tmpdir(), "arev-setup-ws-a-"));
  const second = mkdtempSync(join(tmpdir(), "arev-setup-ws-b-"));
  cleanup.push(first, second);
  expect(setupCommand(first, ["agy", "--apply"])).toBe(0);
  expect(setupCommand(second, ["agy", "--apply"])).toBe(0);
  // One receipt per config path: a single receipt for both would undo only the last workspace.
  expect(receipts()).toHaveLength(2);

  expect(setupCommand(first, ["agy", "--undo"])).toBe(0);
  expect(existsSync(join(first, ".agents", "mcp_config.json"))).toBe(false);
  const kept = JSON.parse(readFileSync(join(second, ".agents", "mcp_config.json"), "utf8")) as { mcpServers: Record<string, unknown> };
  expect(kept.mcpServers.arev).toBeDefined();
  expect(receipts()).toHaveLength(1);
});

test("a filesystem failure names the path, the errno code and the next step", () => {
  // A regular file where the host's directory has to be: the write fails, and Node's own error carries no next step.
  write(join(home, ".codex"), "not a directory\n");
  const lines: string[] = [];
  const stderr = spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
  expect(setupCommand(home, ["codex", "--apply"])).toBe(1);
  stderr.mockRestore();
  expect(lines.some(line => line.includes(".codex") && line.includes("EEXIST"))).toBe(true);
  expect(lines.some(line => line.startsWith("next:") && line.includes("permissions"))).toBe(true);
  expect(receipts()).toEqual([]);
});
