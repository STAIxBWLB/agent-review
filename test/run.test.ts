import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { readLedger } from "../src/ledger.ts";
import { RUN_TOOL_NAMES } from "../src/mcp.ts";
import { fixture } from "./packet-fixture.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

// The first git the test process would run. On macOS /usr/bin/git is a stub that re-execs the developer-tools copy, and
// paying that on every reviewer invocation cost about a second per case on the CI runner.
function hostGit(): string {
  const found = (process.env.PATH ?? "").split(delimiter).map(dir => join(dir, "git")).find(path => {
    try { return statSync(path).isFile(); } catch { return false; }
  });
  return found ?? "/usr/bin/git";
}

function reviewer(mode: "json" | "dirty" | "timeout" | "brief" | "invalid" | "secret" | "escaped-secret" | "mcp" | "mcp-dirty" | "mcp-failed" | "hook", review = "# Review\n", host = "codex", separator = "", env: NodeJS.ProcessEnv = {}, dotenv: string[] = []) {
  const sandbox = mkdtempSync(join(tmpdir(), "arev-run-test-"));
  scratch.push(sandbox);
  const bin = join(sandbox, "bin"), userHome = join(sandbox, "home"), out = join(sandbox, "out");
  // Artifacts the fake reviewer writes outside every directory the runner owns, so they outlive the checkout.
  const hookMarker = join(sandbox, "hook-ran");
  const envFile = join(sandbox, "reviewer-env.json");
  const hostHomesFile = join(sandbox, "reviewer-homes.json");
  const probeHomesFile = join(sandbox, "probe-homes.json");
  const argvFile = join(sandbox, "reviewer-argv.json");
  const probeCwdFile = join(sandbox, "probe-cwd");
  const runCwdFile = join(sandbox, "reviewer-cwd");
  mkdirSync(bin);
  mkdirSync(join(userHome, ".codex"), { recursive: true });
  writeFileSync(join(userHome, ".codex", "config.toml"), 'model = "fixture-model"\n');
  // A case that removes an executable the fixture provides means the run has none, so PATH is the fixture bin plus the
  // system directories git and sh live in - never the host PATH, which lets an installed one answer a case that has
  // none. The host's own git is linked into the bin, because the macOS system copy is a stub that re-execs it. The host
  // config homes are the caller's own shell state in the same way: a case that wants them sets them, and every other
  // case pins them empty, so what this machine exports cannot decide a case.
  symlinkSync(hostGit(), join(bin, "git"));
  const repo = fixture({ HOME: userHome, PATH: `${bin}:/usr/bin:/bin`, OPENAI_API_KEY: "fixture-not-for-reviewer",
    CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", KIMI_CODE_HOME: "", ...env });
  const { git, write } = repo;
  git("remote", "add", "origin", "https://github.com/owner/repo.git");
  write("REVIEW.md", review);
  write("file.txt", "before\n");
  // The source config points a relative hook path at the checkout, and the head commits the hook: a reviewer that runs
  // git there fires it. Only the hook case configures this, so no other case carries the hazard.
  if (mode === "hook") {
    git("config", "core.hooksPath", ".hooks");
    write(".hooks/post-index-change", `#!/bin/sh\nprintf 'ran\\n' > ${JSON.stringify(hookMarker)}\n`);
    chmodSync(join(repo.dir, ".hooks/post-index-change"), 0o755);
  }
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  git("update-ref", "refs/remotes/origin/main", base);
  write("file.txt", "after\n");
  write("bunfig.toml", "# Reviewed configuration stays in the checkout.\n");
  write(".env", ["AREV_FIXTURE_CHECKOUT_ENV=loaded", ...dotenv].join("\n") + "\n");
  git("add", ".");
  git("commit", "-qm", "head");
  const head = git("rev-parse", "HEAD").trim();
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/bin/sh
test "$1:$3" = pr:7 || exit 1
printf '%s\\n' '{"baseRefOid":"${base}","headRefOid":"${head}","title":"Review fixture","body":"Contract fixture text"}'
`);
  chmodSync(gh, 0o755);

  const arev = join(bin, "arev");
  const cliEntry = new URL("../bin/arev.js", import.meta.url).href;
  writeFileSync(arev, `#!${process.execPath}\nif (process.env.AREV_FIXTURE_CHECKOUT_ENV || !process.cwd().endsWith("/launch")) process.exit(19);\nawait import(${JSON.stringify(cliEntry)});\n`, { mode: 0o755 });
  const executable = join(bin, host);
  writeFileSync(executable, `#!${process.execPath}
    import { readFileSync, utimesSync, writeFileSync } from "node:fs";
    const mode = ${JSON.stringify(mode)}, out = ${JSON.stringify(out)}, host = ${JSON.stringify(host)};
    if (process.argv.includes("--help")) {
      writeFileSync(${JSON.stringify(probeCwdFile)}, process.cwd());
      // The probe is its own invocation, so what it received is written here rather than at the reviewer's later step.
      writeFileSync(${JSON.stringify(probeHomesFile)}, JSON.stringify(Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME"].includes(key)))));
      console.log("fixture help: --plan");
      process.exit(0);
    }
    const checkout = process.argv[process.argv.indexOf("--add-dir") + 1];
    if (!checkout || checkout === process.cwd() || !process.cwd().endsWith("/launch") ||
        process.env.AREV_FIXTURE_CHECKOUT_ENV || !readFileSync(checkout + "/bunfig.toml", "utf8").includes("Reviewed configuration")) process.exit(18);
    const packet = JSON.parse(readFileSync(out + "/packet.json", "utf8"));
    if (process.env.OPENAI_API_KEY) process.exit(9);
    // The reviewer's whole environment, as this process received it, so the test can read what was neutralized.
    writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => key.startsWith("GIT_")).sort())));
    // The host config homes this process received, so a case can read them without asserting on the rest of the env.
    writeFileSync(${JSON.stringify(hostHomesFile)}, JSON.stringify(Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME"].includes(key)))));
    writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
    writeFileSync(${JSON.stringify(runCwdFile)}, process.cwd());
    if (host === "claude") {
      if (process.argv[process.argv.indexOf("--setting-sources") + 1] !== "user" ||
          process.argv[process.argv.indexOf("--permission-mode") + 1] !== "plan") process.exit(9);
    } else if (host === "kimi") {
      // The real CLI refuses these two together (issue #42), and arev starts it in prompt mode only: the detached
      // worktree and the clean-checkout check are the guard, so a --plan that reappears has to show up as this failure.
      if (process.argv.includes("--plan")) {
        console.error("error: Cannot combine --prompt with --plan.");
        process.exit(1);
      }
      if (!process.argv.includes("-p")) process.exit(9);
    } else if (!process.argv.includes("read-only")) process.exit(9);
    // What a reviewer does first: a stat change makes git rewrite the index entry, which is what fires post-index-change.
    if (mode === "hook") {
      utimesSync(checkout + "/file.txt", new Date(), new Date());
      if (Bun.spawnSync(["git", "-C", checkout, "status", "--porcelain"]).exitCode !== 0) process.exit(17);
    }
    if (mode === "timeout") { await Bun.sleep(60_000); process.exit(1); }
    if (mode === "dirty") writeFileSync(checkout + "/changed-by-reviewer.txt", "fixture edit");
    if (mode === "secret") {
      const canary = "ghp_" + "a".repeat(36);
      process.stdout.write(canary.slice(0, 10));
      process.stdout.write(canary.slice(10) + "\\n");
      console.error(canary);
      writeFileSync(out + "/reviewer-response.md", "response: " + canary + "\\n");
      process.exit(0);
    }
    if (mode === "invalid") { console.log("unparseable fixture"); process.exit(0); }
    const reviewer = { id: "untrusted-name", modelFamily: "untrusted-family", started: "self", sameFamilyFallback: false };
    const coverage = { reviewed: packet.units.map(unit => unit.path), skipped: [] };
    const call = { ok: true };
    if (mode === "mcp" || mode === "mcp-dirty" || mode === "mcp-failed") {
      const config = Object.fromEntries(process.argv.filter(arg => arg.startsWith("mcp_servers.arev."))
        .map(arg => [arg.slice(0, arg.indexOf("=")), JSON.parse(arg.slice(arg.indexOf("=") + 1))]));
      if (config["mcp_servers.arev.required"] !== true) process.exit(20);
      const command = config["mcp_servers.arev.command"];
      const args = config["mcp_servers.arev.args"];
      const report = { v: 1, packet, reviewer, coverage, call, verdict: "approved", findings: [] };
      const callTool = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      const input = [
        { jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { progressToken: 0 } } },
        callTool(3, "arev_packet", {}),
        callTool(4, "arev_record", { report: { ...report, packet: { ...packet, id: "a".repeat(64) } } }),
        callTool(5, "arev_record", { report }),
        callTool(6, "arev_record", { report }),
        callTool(7, "arev_show", {}),
      ].map(value => JSON.stringify(value)).join("\\n") + "\\n";
      const mcp = Bun.spawnSync([command, ...args], { cwd: checkout, stdin: Buffer.from(input) });
      if (mcp.exitCode !== 0) process.exit(11);
      const replies = new Map(mcp.stdout.toString().trim().split("\\n").map(line => {
        const response = JSON.parse(line);
        return [response.id, response];
      }));
      if (replies.get(2).result.tools.map(tool => tool.name).join(",") !== "arev_packet,arev_rules,arev_show,arev_record") process.exit(12);
      const received = JSON.parse(replies.get(3).result.content[0].text);
      if (received.packet.id !== packet.id || !received.contract.includes("Contract fixture text")) process.exit(13);
      const wrong = replies.get(4).result;
      const duplicate = replies.get(6).result;
      if (!wrong.isError || !wrong.content[0].text.includes("packet id is not") ||
          replies.get(5).result.isError || !duplicate.isError || !duplicate.content[0].text.includes("already staged")) process.exit(14);
      if (!JSON.parse(replies.get(7).result.content[0].text).staged) process.exit(15);
      if (mode === "mcp-dirty") writeFileSync(checkout + "/changed-by-reviewer.txt", "fixture edit");
      console.log("review was submitted via MCP");
      process.exit(mode === "mcp-failed" ? 1 : 0);
    }
    const fence = String.fromCharCode(96).repeat(3);
    if (mode === "escaped-secret") {
      const canary = "ghp_" + "b".repeat(36);
      const findings = [{ id: "bugs:fixture", term: "bugs", severity: "blocking",
        disposition: "open", origin: "introduced", text: "prefix " + ${JSON.stringify(separator)} + canary }];
      const report = JSON.stringify({ v: 1, packet, reviewer, coverage, call,
        verdict: "changes_requested", findings }, null, 2);
      const escaped = report.replace(canary, () => String.fromCharCode(92) + "u0067" + canary.slice(1));
      const fenced = fence + "json\\n" + escaped + "\\n" + fence;
      console.log(fenced);
      writeFileSync(out + "/reviewer-response.md", fenced);
      process.exit(0);
    }

    if (mode === "brief") {
      console.log(fence + "json\\n" + JSON.stringify({ head: packet.subject.head, base: packet.subject.base,
        packet_id: packet.id, reviewer, coverage, call }) + "\\n" + fence + "\\n## Findings\\nP0: None.\\nP1: None.\\nP2: None.\\nP3: None.");
    } else {
      console.log(fence + "json\\n" + JSON.stringify({ v: 1, packet, reviewer, coverage, call,
        verdict: "approved", findings: [] }) + "\\n" + fence);
    }
  `);
  chmodSync(executable, 0o755);
  return { ...repo, userHome, out, head, arev, sandbox, hookMarker, envFile, hostHomesFile, probeHomesFile, argvFile, probeCwdFile, runCwdFile };
}

test("run records the exact PR packet, attests the host, and gates", () => {
  const { cli, dir, home, out, head, git } = reviewer("json");
  const result = cli("run", "--pr", "7", "--implementer", "qwen", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  const events = readLedger(dir, { home });
  const record = events.find(event => event.type === "record");
  expect(record).toMatchObject({ type: "record", record: {
    reviewer: { started: "run", id: "codex", model: "fixture-model", implementer: "qwen", sameFamilyFallback: false },
    packet: { subject: { head, pr: 7 } },
  } });
  expect(readFileSync(join(out, "contract.md"), "utf8")).toContain("> Contract fixture text");
  expect(cli("gate", "--head", head, "--pr", "7").status).toBe(0);
  expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
});

for (const allow of [false, true]) {
  test(`same-host fallback is recorded and the gate ${allow ? "allows it with the reviewed rule" : "refuses without allow"}`, () => {
    const { cli, dir, home, out } = reviewer("json", allow ? "# Review\n\n[gate]\nsame_family = allow\n" : "# Review\n");
    expect(cli("run", "--host", "codex", "--implementer", "codex", "--out", out).status).toBe(0);
    expect(readLedger(dir, { home }).at(-1)).toMatchObject({ type: "record", record: {
      reviewer: { id: "codex", implementer: "codex", sameFamilyFallback: true },
    } });
    expect(cli("gate").status).toBe(allow ? 0 : 1);
  });
}

test("a dirty reviewer voids the review and retains the checkout", () => {
  const { cli, dir, home, out, git } = reviewer("dirty");
  const result = cli("run", "--host", "codex", "--implementer", "qwen", "--out", out);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("this review is void");
  expect(readLedger(dir, { home }).some(event => event.type === "record")).toBe(false);
  const retained = git("worktree", "list", "--porcelain").match(/^worktree (.+)$/gm)!.at(-1)!.slice("worktree ".length);
  expect(retained).not.toBe(dir);
  expect(readFileSync(join(retained, "changed-by-reviewer.txt"), "utf8")).toBe("fixture edit");
  rmSync(join(retained, "changed-by-reviewer.txt"));
  git("worktree", "remove", retained);
  rmSync(dirname(retained), { recursive: true });
});

test("a hung reviewer is killed and its clean checkout is removed", () => {
  const { cli, dir, home, out, git } = reviewer("timeout");
  const result = cli("run", "--host", "codex", "--implementer", "qwen", "--timeout", "0.002", "--out", out);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("the reviewer timed out");
  expect(readLedger(dir, { home }).some(event => event.type === "record")).toBe(false);
  expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
});

test("free text falls back to brief import with the trusted run attestation", () => {
  const { cli, dir, home, out } = reviewer("brief");
  const result = cli("run", "--host", "codex", "--implementer", "qwen", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(readLedger(dir, { home }).at(-1)).toMatchObject({ type: "record",
    record: { reviewer: { started: "run", id: "codex", model: "fixture-model", implementer: "qwen" } },
    source: { format: "brief" },
  });
});

test("invalid reviewer output stays on disk without a review record", () => {
  const { cli, dir, home, out } = reviewer("invalid");
  const result = cli("run", "--host", "codex", "--implementer", "qwen", "--out", out);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("arev import --from brief");
  expect(readFileSync(join(out, "reviewer.stdout"), "utf8")).toContain("unparseable fixture");
  expect(readLedger(dir, { home }).some(event => event.type === "record")).toBe(false);
});

test("run does not select a reviewer executable from the source worktree", () => {
  const { dir, home, out } = reviewer("json");
  const local = join(dir, "fixture-bin");
  mkdirSync(local);
  writeFileSync(join(local, "codex"), "#!/bin/sh\nexit 9\n", { mode: 0o755 });
  const result = spawnSync(process.execPath, [join(import.meta.dir, "../bin/arev.js"), "run",
    "--host", "codex", "--implementer", "qwen", "--out", out],
  { cwd: dir, encoding: "utf8", env: { HOME: home, AGENTHUB_HOME: home, PATH: `${local}:/usr/bin:/bin` } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("No selected reviewer executable is available");
  expect(readLedger(dir, { home })).toEqual([]);
});

test("reviewer secrets are removed from stdout, stderr and the response artifact before recording", () => {
  const { cli, dir, home, out } = reviewer("secret");
  const canary = "ghp_" + "a".repeat(36);
  const result = cli("run", "--host", "codex", "--implementer", "qwen", "--out", out);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`inspect the redacted output in ${out}`);
  for (const name of ["reviewer.stdout", "reviewer.stderr", "reviewer-response.md"]) {
    expect(result.stderr).toContain(`${name}: 1 redacted line(s)`);
    expect(readFileSync(join(out, name), "utf8")).toContain("[redacted reviewer output]");
  }
  for (const name of readdirSync(out)) {
    expect(readFileSync(join(out, name), "utf8")).not.toContain(canary);
  }
  expect(result.stdout + result.stderr).not.toContain(canary);
  expect(readLedger(dir, { home }).some(event => event.type === "record")).toBe(false);
});

test.each([["ordinary text", ""], ["line separator", " "], ["paragraph separator", " "]])(
  "escaped secrets in pretty-printed reviewer reports are removed before recording (%s)", (_, separator) => {
    const { cli, dir, home, out } = reviewer("escaped-secret", "# Review\n", "codex", separator);
    const canary = "ghp_" + "b".repeat(36);
    const escaped = String.fromCharCode(92) + "u0067" + canary.slice(1);
    const result = cli("run", "--host", "codex", "--implementer", "qwen", "--out", out);
    expect(result.status).toBe(1);
    for (const name of ["reviewer.stdout", "reviewer-response.md"]) {
      expect(result.stderr).toContain(name + ": 1 redacted line(s)");
      expect(readFileSync(join(out, name), "utf8")).toContain("[redacted reviewer output]");
    }
    for (const name of readdirSync(out)) {
      const content = readFileSync(join(out, name), "utf8");
      expect(content).not.toContain(canary);
      expect(content).not.toContain(escaped);
    }
    expect(result.stdout + result.stderr).not.toContain(canary);
    expect(result.stdout + result.stderr).not.toContain(escaped);
    expect(readLedger(dir, { home }).some(event => event.type === "record")).toBe(false);
});

test("a scoped MCP run records exactly one staged report with trusted attestation", () => {
  const { cli, dir, home, out, head } = reviewer("mcp");
  const result = cli("run", "--pr", "7", "--host", "codex", "--implementer", "qwen", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(out, "reviewer.stdout"), "utf8")).toContain("review was submitted via MCP");
  expect(JSON.parse(readFileSync(join(out, "report.json"), "utf8")).reviewer).toEqual({});
  const events = readLedger(dir, { home });
  expect(events.map(event => event.type)).toEqual(["packet", "record"]);
  expect(events.at(-1)).toMatchObject({ type: "record", record: {
    reviewer: { started: "run", id: "codex", model: "fixture-model", implementer: "qwen" },
    packet: { subject: { head, pr: 7 } },
  } });
  expect(cli("gate", "--head", head, "--pr", "7").status).toBe(0);
});

test("a staged report does not become a record when the MCP reviewer changes the checkout", () => {
  const { cli, dir, home, out, git } = reviewer("mcp-dirty");
  const result = cli("run", "--pr", "7", "--host", "codex", "--implementer", "qwen", "--out", out);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("this review is void");
  expect(JSON.parse(readFileSync(join(out, "report.json"), "utf8")).reviewer).toEqual({});
  expect(readLedger(dir, { home }).map(event => event.type)).toEqual(["packet"]);
  const retained = git("worktree", "list", "--porcelain").match(/^worktree (.+)$/gm)!.at(-1)!.slice("worktree ".length);
  rmSync(join(retained, "changed-by-reviewer.txt"));
  git("worktree", "remove", retained);
  rmSync(dirname(retained), { recursive: true });
});

test("Kimi without a supported MCP config flag falls back to stdout without an arev executable", () => {
  const kimiHome = mkdtempSync(join(tmpdir(), "arev-run-kimihome-"));
  scratch.push(kimiHome);
  writeFileSync(join(kimiHome, "config.toml"), 'default_model = "kimi-home-model"\n');
  const { cli, dir, home, out, arev, argvFile, hostHomesFile, probeHomesFile, probeCwdFile, runCwdFile } =
    reviewer("json", "# Review\n", "kimi", "", { KIMI_CODE_HOME: kimiHome });
  rmSync(arev);
  const result = cli("run", "--host", "kimi", "--implementer", "qwen", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(out, ".arev-run.json"))).toBe(false);
  expect(readLedger(dir, { home }).at(-1)).toMatchObject({ type: "record",
    record: { reviewer: { started: "run", id: "kimi", implementer: "qwen", model: "kimi-home-model" } },
  });
  // Issue #42: kimi refuses --plan together with the -p this run passes, so the argv must not carry it - and the fake
  // host above fails the run when it does, the way the real CLI failed every kimi run.
  expect(JSON.parse(readFileSync(argvFile, "utf8"))).not.toContain("--plan");
  // The selected host's home reaches the reviewer and the capability probe, and only that host's home does.
  expect(JSON.parse(readFileSync(hostHomesFile, "utf8"))).toEqual({ KIMI_CODE_HOME: kimiHome });
  expect(JSON.parse(readFileSync(probeHomesFile, "utf8"))).toEqual({ KIMI_CODE_HOME: kimiHome });
  // The capability probe reads startup configuration from its cwd, so it gets a private directory of its own - never the
  // caller's --out - and that directory is gone once the probe returns. macOS reports tmpdir() as /var while the child
  // sees /private/var, so a plain string comparison here would pass whatever directory the probe was given.
  const unprivate = (value: string): string => value.replace(/^\/private(?=\/var\/)/, "");
  const probeCwd = readFileSync(probeCwdFile, "utf8");
  expect(unprivate(probeCwd) === out || unprivate(probeCwd).startsWith(`${out}/`)).toBe(false);
  expect(unprivate(probeCwd).startsWith(`${dir}/`) || unprivate(probeCwd) === dir).toBe(false);
  expect(probeCwd.split("/").at(-1)!.startsWith("arev-review-probe-")).toBe(true);
  expect(existsSync(probeCwd)).toBe(false);
  // The reviewer itself still starts in the runner's own launch directory, not in --out either.
  expect(readFileSync(runCwdFile, "utf8").endsWith("/launch")).toBe(true);
});


test("an unsuccessful reviewer with a staged report must rerun", () => {
  const { cli, dir, home, out } = reviewer("mcp-failed");
  const result = cli("run", "--pr", "7", "--host", "codex", "--implementer", "qwen", "--out", out);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("rerun arev run with a fresh output directory");
  expect(result.stderr).not.toContain("use arev record");
  expect(existsSync(join(out, "report.json"))).toBe(true);
  expect(readLedger(dir, { home }).map(event => event.type)).toEqual(["packet"]);
});


test("Claude starts with user settings and reads the checkout as an added directory", () => {
  const { cli, dir, home, out } = reviewer("json", "# Review\n", "claude");
  const result = cli("run", "--host", "claude", "--implementer", "qwen", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(readLedger(dir, { home }).at(-1)).toMatchObject({ type: "record",
    record: { reviewer: { id: "claude", started: "run" } },
  });
});

// Issue #39: the reviewer runs git inside the checkout, and the source config's relative core.hooksPath points there.
// A stat change plus one `git status` is enough for git to rewrite the index and fire a post-index-change the head
// committed, so this case proves the neutralized environment leaves the marker unwritten.
test("reviewer git runs no hook the source config points at inside the checkout", () => {
  const { cli, dir, home, out, hookMarker, envFile } = reviewer("hook");
  const result = cli("run", "--host", "codex", "--implementer", "qwen", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(hookMarker)).toBe(false);
  expect(result.stderr).not.toContain("this review is void");
  expect(readLedger(dir, { home }).map(event => event.type)).toEqual(["packet", "record"]);
  // What the reviewer received, in full: no other GIT_ variable is inherited, and both settings arrive as env config.
  expect(JSON.parse(readFileSync(envFile, "utf8"))).toEqual({
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false", GIT_OPTIONAL_LOCKS: "0",
  });
});

// Issue #39: the refusal used to fire after the bundle was written, so the retry the refusal asks for failed on the
// files the previous attempt had left behind.
test("a missing arev executable refuses before the bundle, so the retry keeps the same --out", () => {
  const { cli, dir, home, out, arev } = reviewer("json");
  const saved = readFileSync(arev);
  rmSync(arev);
  const refused = cli("run", "--host", "codex", "--implementer", "qwen", "--out", out);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("The arev executable is unavailable for reviewer MCP");
  expect(readdirSync(out)).toEqual([]);
  expect(readLedger(dir, { home })).toEqual([]);
  writeFileSync(arev, saved, { mode: 0o755 });
  const rerun = cli("run", "--host", "codex", "--implementer", "qwen", "--out", out);
  expect(rerun.status, rerun.stderr).toBe(0);
  expect(readLedger(dir, { home }).map(event => event.type)).toEqual(["packet", "record"]);
});

// Issue #39: claude takes the MCP server from a file behind --strict-mcp-config, so the allowed tool list is the whole
// scope of what the reviewer may call.
test("claude is handed the arev MCP config and only the four arev tools", () => {
  const { cli, dir, home, out, argvFile } = reviewer("json", "# Review\n", "claude");
  const result = cli("run", "--host", "claude", "--implementer", "qwen", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  expect(argv).toContain("--strict-mcp-config");
  const config = valueOf("--mcp-config");
  expect(config).toBe(join(out, ".arev-reviewer-mcp.json"));
  const server = JSON.parse(readFileSync(config!, "utf8")).mcpServers.arev as { command: string; args: string[] };
  expect(server.command).toBe("/bin/sh");
  expect(server.args.at(-1)).toBe(out);
  const allowed = valueOf("--allowedTools");
  expect(allowed).toBe(RUN_TOOL_NAMES.map(tool => `mcp__arev__${tool}`).join(","));
  // Spelled out as well, so widening the run's tool list cannot quietly widen what claude may call.
  expect(allowed).toBe("mcp__arev__arev_packet,mcp__arev__arev_rules,mcp__arev__arev_show,mcp__arev__arev_record");
});

// Issue #42: a host whose login lives in a relocated config home was started against the default one, so the reviewer ran
// as the wrong account - and the model attested was the one in a file that host would never read.
test("the selected host receives its config home, and reads its model from it", () => {
  const homes = mkdtempSync(join(tmpdir(), "arev-run-homes-"));
  scratch.push(homes);
  const codexHome = join(homes, "codex"), claudeHome = join(homes, "claude"), kimiHome = join(homes, "kimi");
  for (const directory of [codexHome, claudeHome, kimiHome]) mkdirSync(directory);
  writeFileSync(join(codexHome, "config.toml"), 'model = "codex-home-model"\n');
  const { cli, dir, home, out, hostHomesFile } = reviewer("json", "# Review\n", "codex", "",
    { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, KIMI_CODE_HOME: kimiHome });
  const result = cli("run", "--host", "codex", "--implementer", "qwen", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  // All three are set, and only the selected host's home is forwarded: the other two relocate hosts this run never starts.
  expect(JSON.parse(readFileSync(hostHomesFile, "utf8"))).toEqual({ CODEX_HOME: codexHome });
  // The attested model comes from $CODEX_HOME/config.toml, not from the fixture's ~/.codex/config.toml.
  expect(readLedger(dir, { home }).at(-1)).toMatchObject({ type: "record",
    record: { reviewer: { id: "codex", model: "codex-home-model" } } });
});

// Issue #42: the homes are the caller's own state, but a path inside the reviewed checkout would let that head supply the
// startup configuration of the host that reviews it. The refusal fires with the other checks that precede the bundle.
test("a host config home inside the source worktree refuses before anything is written", () => {
  const { cli, dir, home, out } = reviewer("json", "# Review\n", "codex", "", { CODEX_HOME: "." });
  const result = cli("run", "--host", "codex", "--implementer", "qwen", "--out", out);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("The CODEX_HOME directory is inside the source worktree");
  expect(result.stderr).toContain("point CODEX_HOME outside the reviewed worktree, or unset it");
  expect(existsSync(out)).toBe(false);
  expect(readLedger(dir, { home })).toEqual([]);
});

// Issue #42 review round 2: a home is read and refused for the host this run starts, so another host's variable cannot
// fail a run that never starts it - and claude's own home still gets through.
test("an in-worktree CODEX_HOME does not refuse a run that starts claude", () => {
  const claudeHome = mkdtempSync(join(tmpdir(), "arev-run-claudehome-"));
  scratch.push(claudeHome);
  const { cli, dir, home, out, hostHomesFile } = reviewer("json", "# Review\n", "claude", "",
    { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: "." });
  const result = cli("run", "--host", "claude", "--implementer", "qwen", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).not.toContain("inside the source worktree");
  expect(JSON.parse(readFileSync(hostHomesFile, "utf8"))).toEqual({ CLAUDE_CONFIG_DIR: claudeHome });
  expect(readLedger(dir, { home }).map(event => event.type)).toEqual(["packet", "record"]);
});

// Issue #42 review round 2: Bun loads a `.env` from the cwd, and arev runs from inside the reviewed checkout, so a
// committed `.env` naming a host config home would otherwise be forwarded as if the caller had set it. The entry point
// is started through its own shebang here, which is how the installed `arev` starts.
test("a repository .env cannot supply a host config home", () => {
  const dotenvHome = mkdtempSync(join(tmpdir(), "arev-run-dotenv-"));
  scratch.push(dotenvHome);
  writeFileSync(join(dotenvHome, "config.toml"), 'model = "dotenv-model"\n');
  const { dir, home, userHome, out, sandbox, hostHomesFile } = reviewer("json", "# Review\n", "codex", "", {},
    [`CODEX_HOME=${dotenvHome}`]);
  const bin = join(sandbox, "bin");
  // The shebang runs `bun` by name, so the fixture PATH needs one; nothing else is offered to the entry.
  symlinkSync(process.execPath, join(bin, "bun"));
  const result = spawnSync(join(import.meta.dir, "../bin/arev.js"),
    ["run", "--host", "codex", "--implementer", "qwen", "--out", out],
    { cwd: dir, encoding: "utf8", env: { HOME: userHome, AGENTHUB_HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
  expect(result.status, result.stderr).toBe(0);
  // The caller set no home, and the checkout's .env is not the caller: neither one reaches the reviewer.
  expect(JSON.parse(readFileSync(hostHomesFile, "utf8"))).toEqual({});
  expect(readLedger(dir, { home }).at(-1)).toMatchObject({ type: "record",
    record: { reviewer: { id: "codex", model: "fixture-model" } } });
});
