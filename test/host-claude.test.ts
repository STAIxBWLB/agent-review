import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "arev-claude-host-"));
  fixtures.push(root);
  const home = join(root, "home");
  const config = join(home, ".claude");
  const bin = join(root, "bin");
  mkdirSync(config, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "", { mode: 0o700 });
  return { root, home, config, bin, settings: join(config, "settings.json") };
}

function runHost({ root, home, bin }: ReturnType<typeof fixture>, relocated = "") {
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../bin/arev.js"), "host", "--pr", "3",
      "--implementer", "codex", "--hosts", "claude", "--json"],
    { cwd: root, env: { HOME: home, PATH: bin, CLAUDE_CONFIG_DIR: relocated, AGENTHUB_HOME: join(root, "agenthub") } },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return JSON.parse(result.stdout.toString()) as unknown;
}

const model = "claude-sonnet-4-6:fixture";

test("Claude host outputs only the top-level model from settings.json", () => {
  const paths = fixture();
  writeFileSync(paths.settings, JSON.stringify({
    model,
    env: { ANTHROPIC_API_KEY: "env-canary" },
    apiKeyHelper: "helper-canary",
    hooks: { SessionStart: ["hook-canary"] },
  }));
  expect(runHost(paths)).toEqual({ host: "claude", reason: "rotation", considered: [], model });
});

test("CLAUDE_CONFIG_DIR selects settings from the relocated config home", () => {
  const paths = fixture();
  const relocated = join(paths.root, "relocated");
  mkdirSync(relocated);
  writeFileSync(paths.settings, JSON.stringify({ model: "default-model" }));
  expect(runHost(paths, relocated)).toMatchObject({ model: "unknown" });
  writeFileSync(join(relocated, "settings.json"), JSON.stringify({ model }));
  expect(runHost(paths, relocated)).toMatchObject({ model });
});

test.each([
  { label: "malformed JSON", text: '{"model":' },
  { label: "non-string model", text: '{"model":4}' },
  { label: "compound model", text: '{"model":{"name":"sonnet"}}' },
  { label: "nested model", text: '{"env":{"model":"sonnet"}}' },
  { label: "invalid identifier", text: '{"model":"sonnet latest"}' },
  { label: "oversized identifier", text: JSON.stringify({ model: "a".repeat(129) }) },
  { label: "oversized config", text: JSON.stringify({ model, padding: "a".repeat(1024 * 1024) }) },
])("Claude host reports unknown for $label", ({ text }) => {
  const paths = fixture();
  writeFileSync(paths.settings, text);
  expect(runHost(paths)).toMatchObject({ model: "unknown" });
});

test("Claude host refuses settings and config-directory symlinks outside HOME", () => {
  const paths = fixture();
  const outside = join(paths.root, "outside");
  mkdirSync(outside);
  const settings = join(outside, "settings.json");
  writeFileSync(settings, JSON.stringify({ model }));
  symlinkSync(settings, paths.settings);
  expect(runHost(paths)).toMatchObject({ model: "unknown" });

  rmSync(paths.config, { recursive: true });
  symlinkSync(outside, paths.config);
  expect(runHost(paths)).toMatchObject({ model: "unknown" });
  expect(runHost(paths, paths.config + "/")).toMatchObject({ model: "unknown" });
});
