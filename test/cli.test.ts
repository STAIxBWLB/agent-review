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
  expect(run("status").stdout).toContain("Packet and rules commands are available");
});

test("rejects unavailable commands and extra arguments", () => {
  for (const args of [["fixture-unknown-command"], ["status", "--post"]]) {
    const result = run(...args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(args[0] === "fixture-unknown-command" ? "unknown command" : "status takes no arguments");
    expect(result.stderr).toContain("arev --help");
  }
});

test("show outside any repository answers with its no-ledger line and exits 0", () => {
  // The other side of the containment check's fail-closed arm: an unreadable checkout is refused, but a plain directory
  // with no `.git` at or above it is not one, so there is simply no ledger yet and that is not an error.
  const result = run("show");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("no review ledger for");
  expect(result.stderr).toBe("");
});

test("a record, resolve or show argument error refuses as usage and names that command's help", () => {
  for (const [args, message] of [
    [["record"], "arev: record takes exactly one report file (got 0)"],
    [["resolve"], "arev: resolve takes exactly one finding id (got 0)"],
    [["show", "--bogus"], "arev: show takes --head <sha>, --pr <n|none> and --json"],
    [["show", "--head", "0".repeat(40), "--pr", "0"], "arev: Invalid PR number. Pass a positive integer to --pr, or none for a review with no PR."],
    [["resolve", "bugs:one", "--as", "fixed", "--pr", "seven"], "arev: Invalid PR number. Pass a positive integer to --pr, or none for a review with no PR."],
    // `--head` reaches a refusal only as a commit id, so a value that is not one is refused as usage here.
    [["show", "--head", "HEAD~1"], "arev: --head must be a commit SHA: 4 to 64 hexadecimal characters"],
  ] as const) {
    const result = run(...args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain(`→ arev ${args[0]} --help`);
  }
});
