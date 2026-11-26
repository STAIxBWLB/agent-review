import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLedger } from "../src/ledger.ts";
import { fixture } from "./packet-fixture.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function reviewer(mode: "json" | "dirty" | "timeout" | "brief" | "invalid" | "secret" | "escaped-secret" | "mcp" | "mcp-dirty", review = "# Review\n", host = "codex", separator = "") {
  const sandbox = mkdtempSync(join(tmpdir(), "arev-run-test-"));
  scratch.push(sandbox);
  const bin = join(sandbox, "bin"), userHome = join(sandbox, "home"), out = join(sandbox, "out");
  mkdirSync(bin);
  mkdirSync(join(userHome, ".codex"), { recursive: true });
  writeFileSync(join(userHome, ".codex", "config.toml"), 'model = "fixture-model"\n');
  const repo = fixture({ HOME: userHome, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENAI_API_KEY: "fixture-not-for-reviewer" });
  const { git, write } = repo;
  git("remote", "add", "origin", "https://github.com/owner/repo.git");
  write("REVIEW.md", review);
  write("file.txt", "before\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  git("update-ref", "refs/remotes/origin/main", base);
  write("file.txt", "after\n");
  git("commit", "-qam", "head");
  const head = git("rev-parse", "HEAD").trim();
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/bin/sh
test "$1:$3" = pr:7 || exit 1
printf '%s\\n' '{"baseRefOid":"${base}","headRefOid":"${head}","title":"Review fixture","body":"Contract fixture text"}'
`);
  chmodSync(gh, 0o755);

  const arev = join(bin, "arev");
  const cliEntry = new URL("../bin/arev.js", import.meta.url).href;
  writeFileSync(arev, `#!${process.execPath}\nawait import(${JSON.stringify(cliEntry)});\n`, { mode: 0o755 });
  const executable = join(bin, host);
  writeFileSync(executable, `#!${process.execPath}
    import { readFileSync, writeFileSync } from "node:fs";
    const mode = ${JSON.stringify(mode)}, out = ${JSON.stringify(out)}, host = ${JSON.stringify(host)};
    if (process.argv.includes("--help")) { console.log("fixture help: --plan"); process.exit(0); }
    const packet = JSON.parse(readFileSync(out + "/packet.json", "utf8"));
    if (!process.argv.includes(host === "kimi" ? "--plan" : "read-only") || process.env.OPENAI_API_KEY) process.exit(9);
    if (mode === "timeout") { await Bun.sleep(60_000); process.exit(1); }
    if (mode === "dirty") writeFileSync("changed-by-reviewer.txt", "fixture edit");
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
    if (mode === "mcp" || mode === "mcp-dirty") {
      const config = Object.fromEntries(process.argv.filter(arg => arg.startsWith("mcp_servers.arev."))
        .map(arg => [arg.slice(0, arg.indexOf("=")), JSON.parse(arg.slice(arg.indexOf("=") + 1))]));
      const command = config["mcp_servers.arev.command"];
      const args = config["mcp_servers.arev.args"];
      const report = { v: 1, packet, reviewer, coverage, call, verdict: "approved", findings: [] };
      const callTool = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      const input = [
        { jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        callTool(3, "arev_packet", {}),
        callTool(4, "arev_record", { report: { ...report, packet: { ...packet, id: "a".repeat(64) } } }),
        callTool(5, "arev_record", { report }),
        callTool(6, "arev_record", { report }),
        callTool(7, "arev_show", {}),
      ].map(value => JSON.stringify(value)).join("\\n") + "\\n";
      const mcp = Bun.spawnSync([command, ...args], { stdin: Buffer.from(input) });
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
      if (mode === "mcp-dirty") writeFileSync("changed-by-reviewer.txt", "fixture edit");
      console.log("review was submitted via MCP");
      process.exit(0);
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
  return { ...repo, out, head, arev };
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
  const { cli, dir, home, out, arev } = reviewer("json", "# Review\n", "kimi");
  rmSync(arev);
  const result = cli("run", "--host", "kimi", "--implementer", "qwen", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(out, ".arev-run.json"))).toBe(false);
  expect(readLedger(dir, { home }).at(-1)).toMatchObject({ type: "record",
    record: { reviewer: { started: "run", id: "kimi", implementer: "qwen" } },
  });
});
