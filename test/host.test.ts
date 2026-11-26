import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HOST_ORDER, availableHosts, chooseHost, modelOf, onPath } from "../src/host.ts";

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const BLOCKED = "blocked: no review host can run";

// The six cases the ported script's `--self-test` asserted, in its order: rotation, implementer skip, fallback when a
// host is unavailable, same-family fallback, and no host (spec #24 AC1).
test("selects a host by rotation, skipping the implementer and an unavailable host", () => {
  const all = new Set(HOST_ORDER);
  // 448 % 3 = 1, so the rotation starts at codex: the implementer, skipped, then kimi - which is only reached past the
  // first host because the implementer was the first.
  expect(chooseHost(448, "codex", all, HOST_ORDER)).toMatchObject({ host: "kimi", reason: "implementer skip" });
  // 450 % 3 = 0: claude first, the implementer, so codex follows it.
  expect(chooseHost(450, "claude", all, HOST_ORDER)).toMatchObject({ host: "codex", reason: "implementer skip" });
  expect(chooseHost(449, "codex", all, HOST_ORDER)).toEqual({ host: "kimi", reason: "rotation", considered: [] });
  expect(chooseHost(449, "codex", new Set(["claude", "codex"]), HOST_ORDER)).toEqual({
    host: "claude", reason: "fallback", considered: [{ host: "kimi", skipped: "unavailable" }] });
  // The port printed "same-ai fallback: no other AI available"; spec #24 names this reason itself.
  expect(chooseHost(448, "codex", new Set(["codex"]), HOST_ORDER)).toMatchObject({ host: "codex", reason: "same-family fallback" });
  expect(chooseHost(448, "codex", new Set(), HOST_ORDER)).toEqual({ reason: BLOCKED, considered: [
    { host: "codex", skipped: "implementer" }, { host: "kimi", skipped: "unavailable" }, { host: "claude", skipped: "unavailable" }] });
  // A given order rotates over itself, and an implementer that is no host never matches one.
  expect(chooseHost(450, "qwen", new Set(["codex", "claude"]), ["codex", "claude"])).toMatchObject({ host: "codex", reason: "rotation" });
  expect(chooseHost(1, "claude", new Set(), [])).toEqual({ reason: BLOCKED, considered: [] });
});

test("a host is available only when its CLI is an executable file on PATH", () => {
  const bin = temp("arev-host-bin-");
  try {
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    // A CLI that is not executable, and one that is a directory: neither runs.
    writeFileSync(join(bin, "kimi"), "#!/bin/sh\n", { mode: 0o644 });
    mkdirSync(join(bin, "claude"));
    expect(availableHosts(new Set(), bin, HOST_ORDER)).toEqual(new Set(["codex"]));
    expect(availableHosts(new Set(["codex"]), bin, HOST_ORDER)).toEqual(new Set());
    expect(onPath("codex", `${bin}:/nonexistent-arev-host`)).toBe(true);
    expect(onPath("kimi", bin)).toBe(false);
    expect(onPath("claude", bin)).toBe(false);
    expect(onPath("codex", ":/nonexistent-arev-host")).toBe(false);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("the model comes from the host's own config file, top level only", () => {
  const home = temp("arev-host-home-");
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/config.toml"), [
      'model = "gpt-5-codex"',
      'approval_policy = "never"',
      "",
      "[profiles.side]",
      'model = "not-the-model"',
      "",
    ].join("\n"));
    mkdirSync(join(home, ".kimi-code"), { recursive: true });
    writeFileSync(join(home, ".kimi-code/config.toml"), 'default_model = \'kimi-k2\'\n[tools]\ndefault_model = "not-it"\n');
    expect(modelOf("codex", home)).toBe("gpt-5-codex");
    expect(modelOf("kimi", home)).toBe("kimi-k2");
    // A model named only inside a table is not the model the host runs, so a config that has one only there reads unknown.
    writeFileSync(join(home, ".kimi-code/config.toml"), '[profiles.deep]\ndefault_model = "not-it"\n');
    expect(modelOf("kimi", home)).toBe("unknown");
    // The spec names a config only for codex and kimi: every other host answers unknown.
    expect(modelOf("claude", home)).toBe("unknown");
    expect(modelOf("codex", join(home, "no-such-home"))).toBe("unknown");
    writeFileSync(join(home, ".codex/config.toml"), "approval_policy = \"never\"\n");
    expect(modelOf("codex", home)).toBe("unknown");
    // A key TOML lets the host quote is still that key, in either quoting style.
    writeFileSync(join(home, ".codex/config.toml"), '"model" = "gpt-5-codex"\n');
    expect(modelOf("codex", home)).toBe("gpt-5-codex");
    writeFileSync(join(home, ".kimi-code/config.toml"), `'default_model' = 'kimi-k2'\n`);
    expect(modelOf("kimi", home)).toBe("kimi-k2");
    // And a model written with TOML's escapes attests as the name it decodes to, not as the escapes.
    writeFileSync(join(home, ".codex/config.toml"), 'model = "gpt\\u002D5-codex" # the dash is escaped\n');
    expect(modelOf("codex", home)).toBe("gpt-5-codex");
    writeFileSync(join(home, ".codex/config.toml"), 'model = "gpt-5-codex"');
    expect(modelOf("codex", home)).toBe("gpt-5-codex");
    // A model-looking line inside multiline text is not the model: the body of a multiline string, basic or literal, is
    // text, and the real key after it is what attests.
    writeFileSync(join(home, ".codex/config.toml"), 'description = """\nmodel = "not-the-model"\n"""\nmodel = "gpt-5-codex"\n');
    expect(modelOf("codex", home)).toBe("gpt-5-codex");
    writeFileSync(join(home, ".kimi-code/config.toml"), "notes = '''\ndefault_model = 'not-it'\n'''\ndefault_model = 'kimi-k2'\n");
    expect(modelOf("kimi", home)).toBe("kimi-k2");
    // With no real key at all, a model named only inside that text reads unknown, the way a table's does.
    writeFileSync(join(home, ".codex/config.toml"), 'description = """\nmodel = "not-the-model"\n"""\n');
    expect(modelOf("codex", home)).toBe("unknown");
    // A config over the 64 KiB bound is not parsed at all, even with its model key at the end.
    writeFileSync(join(home, ".codex/config.toml"), `${"# filler\n".repeat(8000)}model = "gpt-5-codex"\n`);
    expect(modelOf("codex", home)).toBe("unknown");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a config value that is not a plain model name reads as unknown", () => {
  const home = temp("arev-host-unsafe-");
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    // The last two are what TOML makes of an escape it does not define (`\q` is a parse error) and of one it does
    // (`\u0000` decodes to NUL, which no model name may carry).
    for (const value of ["", "gpt-\u001b[31mbad", "sk-abcdefghijklmnopqrstuvwx", "m".repeat(129),
      "gpt\\q5", "gpt\\u00005"]) {
      writeFileSync(join(home, ".codex/config.toml"), `model = "${value}"\n`);
      expect(modelOf("codex", home)).toBe("unknown");
    }
    // A key whose value is not a string is not a model name either.
    writeFileSync(join(home, ".codex/config.toml"), "model = 5\n");
    expect(modelOf("codex", home)).toBe("unknown");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function run(env: Record<string, string>, ...args: string[]) {
  const cwd = temp("arev-host-cli-");
  try {
    const result = Bun.spawnSync(
      [process.execPath, resolve(import.meta.dir, "../bin/arev.js"), ...args],
      { cwd, env: { ...process.env, AGENTHUB_HOME: join(cwd, "agenthub"), ...env } },
    );
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// AC2: the model reaches the answer, and no other value from that file does.
test("arev host answers with the host, its model and the reason, and prints no other config value", () => {
  const home = temp("arev-host-attest-"), bin = temp("arev-host-attest-bin-");
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/config.toml"), 'model = "gpt-5-codex"\napi_key = "k3y-not-for-output"\n');
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    const env = { HOME: home, PATH: bin };
    const json = run(env, "host", "--pr", "448", "--implementer", "claude", "--json");
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({ host: "codex", reason: "rotation", considered: [], model: "gpt-5-codex" });
    expect(json.stdout).not.toContain("k3y-not-for-output");
    expect(json.stdout).not.toContain("api_key");
    const lines = run(env, "host", "--pr", "448", "--implementer", "claude");
    expect(lines.code).toBe(0);
    expect(lines.stdout).toBe("host: codex\nmodel: gpt-5-codex\nreason: rotation\n");
    // A host taken out by --unavailable falls back, and the answer says which one it skipped.
    const skipped = run(env, "host", "--pr", "448", "--implementer", "claude", "--unavailable", "codex");
    expect(skipped.code).toBe(1);
    expect(skipped.stdout).toContain("reason: blocked: no review host can run");
    expect(skipped.stdout).toContain("codex: unavailable");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("arev host without --implementer or --pr is refused, and an unknown host id names the known ones", () => {
  const bin = temp("arev-host-refuse-bin-");
  try {
    for (const [args, message] of [
      [["host", "--pr", "448"], "Pass the implementer's identity to --implementer"],
      [["host", "--implementer", "claude"], "Pass the pull request number to --pr"],
      [["host", "--pr", "448", "--implementer", "claude", "--hosts", "qwen"], "arev does not know the host qwen"],
      [["host", "--pr", "448", "--implementer", "claude", "--unavailable", "gpt"], "arev does not know the host gpt"],
      [["host", "--pr", "seven", "--implementer", "claude"], "Pass the pull request number to --pr"],
      [["host", "--pr", "448", "--implementer", "claude", "--bogus"], "Choose arev host --pr N"],
    ] as const) {
      const result = run({ PATH: bin }, ...args);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("→ arev host --help");
    }
    expect(run({ PATH: bin }, "host", "--pr", "448", "--implementer", "claude", "--hosts", "qwen").stderr)
      .toContain("claude, codex, kimi");
    // An unknown id is caller text, so it is echoed only when it is an identity that is not secret-shaped.
    const echoed = run({ PATH: bin }, "host", "--pr", "448", "--implementer", "claude", "--hosts", "sk-abcdefghijklmnopqrstuvwx");
    expect(echoed.code).toBe(2);
    expect(echoed.stderr).toContain("arev does not know the host <withheld>");
    expect(echoed.stderr).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    const control = run({ PATH: bin }, "host", "--pr", "448", "--implementer", "claude", "--unavailable", "gpt\u001b[31m");
    expect(control.stderr).toContain("arev does not know the host <withheld>");
    expect(control.stderr).not.toContain("\u001b");
    // `--unavailable kimi claude` is not a list: the second id is a positional, so the usage it prints says how to spell
    // the repeat instead of leaving the reader to guess.
    const bare = run({ PATH: bin }, "host", "--pr", "448", "--implementer", "claude", "--unavailable", "kimi", "claude");
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain("[--unavailable ID]...");
    expect(bare.stderr).toContain("Repeat --unavailable once per host, or comma-separate its ids");
    expect(bare.stderr).toContain("→ arev host --help");
    // The table row is what `arev host --help` prints, so the help text spells the repeatable flag the same way.
    const help = run({ PATH: bin }, "host", "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toBe("Usage: arev host --pr N --implementer ID [--hosts LIST] [--unavailable ID]... [--json]\n");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

// `--unavailable` and `--hosts` take a list, so the flag itself may be given again: each value has to land, which is what
// the duplicate-flag guard would have refused while it screened every flag the same way.
test("a repeated --unavailable or --hosts excludes or orders each host it names", () => {
  const home = temp("arev-host-repeat-"), bin = temp("arev-host-repeat-bin-");
  try {
    for (const host of HOST_ORDER) writeFileSync(join(bin, host), "#!/bin/sh\n", { mode: 0o755 });
    const env = { HOME: home, PATH: bin };
    // 449 % 3 = 2, so the rotation is kimi, claude, codex: excluding the first two by a repeated flag leaves codex.
    const excluded = run(env, "host", "--pr", "449", "--implementer", "qwen", "--unavailable", "kimi", "--unavailable", "claude", "--json");
    expect(excluded.code).toBe(0);
    expect(JSON.parse(excluded.stdout)).toEqual({ host: "codex", reason: "fallback", considered: [
      { host: "kimi", skipped: "unavailable" }, { host: "claude", skipped: "unavailable" }], model: "unknown" });
    // And a repeated --hosts is one order built from both values, which keeps the rotation arithmetic on the list given.
    const ordered = run(env, "host", "--pr", "449", "--implementer", "qwen", "--hosts", "claude", "--hosts", "kimi", "--json");
    expect(ordered.code).toBe(0);
    expect(JSON.parse(ordered.stdout)).toEqual({ host: "kimi", reason: "rotation", considered: [], model: "unknown" });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("arev host reports no host and the next step when none can run", () => {
  const home = temp("arev-host-none-"), bin = temp("arev-host-none-bin-");
  try {
    const result = run({ HOME: home, PATH: bin }, "host", "--pr", "448", "--implementer", "codex");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("host: none");
    expect(result.stdout).toContain(`reason: ${BLOCKED}`);
    expect(result.stdout).toContain("next: put one of claude, codex, kimi on PATH");
    expect(result.stdout).not.toContain("model:");
    // Issue #32: the JSON answer carries that same instruction as `next`, so an agent reading it does not have to parse
    // the lines. One string serves both surfaces, which is what comparing the two here pins.
    const json = run({ HOME: home, PATH: bin }, "host", "--pr", "448", "--implementer", "codex", "--json");
    expect(json.code).toBe(1);
    const answer = JSON.parse(json.stdout);
    expect(answer.next).toBe("put one of claude, codex, kimi on PATH and drop it from --unavailable, then run arev host again");
    expect(result.stdout).toContain(`next: ${answer.next}`);
    // And a run that does find a host has no next step to name.
    const found = temp("arev-host-none-found-");
    try {
      writeFileSync(join(found, "codex"), "#!/bin/sh\n", { mode: 0o755 });
      const ok = run({ HOME: home, PATH: found }, "host", "--pr", "448", "--implementer", "claude", "--json");
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.stdout)).toEqual({ host: "codex", reason: "rotation", considered: [], model: "unknown" });
    } finally {
      rmSync(found, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
