import { afterEach, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "arev-packet-"));
  cleanup.push(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    AGENTHUB_HOME: join(dir, ".fixture-hub"), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...overrides };
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", ...args], {
      encoding: "utf8", env,
    });
    expect(result.stderr).not.toContain("fatal:");
    expect(result.status).toBe(0);
    return result.stdout;
  };
  const write = (path: string, content: string | Buffer) => {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const cli = (...args: string[]) => spawnSync(process.execPath,
    [join(import.meta.dir, "../bin/arev.js"), ...args], { cwd: dir, encoding: "utf8", env });
  git("init", "-q", "-b", "main");
  return { dir, git, write, cli };
}
