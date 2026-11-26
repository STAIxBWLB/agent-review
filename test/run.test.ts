import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLedger } from "../src/ledger.ts";
import { fixture } from "./packet-fixture.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function reviewer(mode: "json" | "dirty" | "timeout" | "brief" | "invalid", review = "# Review\n") {
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

  const executable = join(bin, "codex");
  writeFileSync(executable, `#!${process.execPath}
    import { readFileSync, writeFileSync } from "node:fs";
    const mode = ${JSON.stringify(mode)}, out = ${JSON.stringify(out)};
    const packet = JSON.parse(readFileSync(out + "/packet.json", "utf8"));
    if (!process.argv.includes("read-only") || process.env.OPENAI_API_KEY) process.exit(9);
    if (mode === "timeout") { await Bun.sleep(60_000); process.exit(1); }
    if (mode === "dirty") writeFileSync("changed-by-reviewer.txt", "fixture edit");
    if (mode === "invalid") { console.log("unparseable fixture"); process.exit(0); }
    const reviewer = { id: "untrusted-name", modelFamily: "untrusted-family", started: "self", sameFamilyFallback: false };
    const coverage = { reviewed: packet.units.map(unit => unit.path), skipped: [] };
    const call = { ok: true };
    const fence = String.fromCharCode(96).repeat(3);
    if (mode === "brief") {
      console.log(fence + "json\\n" + JSON.stringify({ head: packet.subject.head, base: packet.subject.base,
        packet_id: packet.id, reviewer, coverage, call }) + "\\n" + fence + "\\n## Findings\\nP0: None.\\nP1: None.\\nP2: None.\\nP3: None.");
    } else {
      console.log(fence + "json\\n" + JSON.stringify({ v: 1, packet, reviewer, coverage, call,
        verdict: "approved", findings: [] }) + "\\n" + fence);
    }
  `);
  chmodSync(executable, 0o755);
  return { ...repo, out, head };
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
