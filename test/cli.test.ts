import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { version } from "../package.json";
import { usage } from "../src/commands-table.ts";

function run(...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "arev-cli-"));
  try {
    const result = Bun.spawnSync(
      [process.execPath, resolve(import.meta.dir, "../bin/arev.js"), ...args],
      { cwd: dir, env: { ...process.env, AGENTHUB_HOME: join(dir, "agenthub") } },
    );
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("bootstraps outside the checkout and renders the command table", () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    expect(run(...args)).toEqual({ code: 0, stdout: `${usage()}\n`, stderr: "" });
  }
  expect(run("--version").stdout.trim()).toBe(version);
  expect(run("status").stdout).toContain("pending");
});

test("rejects unavailable commands and extra arguments", () => {
  for (const args of [["run"], ["status", "--post"]]) {
    const result = run(...args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(args[0] === "run" ? "unknown command" : "status takes no arguments");
    expect(result.stderr).toContain("arev --help");
  }
});
