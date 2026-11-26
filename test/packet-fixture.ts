import { afterEach, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildPacket, type PacketRequest } from "../src/packet.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function isolatedPacket(cwd: string, request: PacketRequest) {
  const previous = Object.fromEntries(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "XDG_CONFIG_HOME"]
    .map(key => [key, process.env[key]]));
  const config = mkdtempSync(join(tmpdir(), "arev-config-"));
  try {
    process.env.GIT_CONFIG_GLOBAL = join(config, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.XDG_CONFIG_HOME = config;
    return buildPacket(cwd, request);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(config, { recursive: true, force: true });
  }
}

export function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "arev-packet-"));
  cleanup.push(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: dir,
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
