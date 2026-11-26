import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function gitOut(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) throw new Error(`${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

type BuiltPacket = { id: string; subject: Record<string, unknown>; units: { path: string }[] };

/**
 * Spec AC8: the whole flow in a fixture repository, with no agent-hub and no `$AGENTHUB_HOME` set. `HOME` is a
 * temporary directory, so "the default `~/.agenthub`" the flow writes to is a temp path: the run proves the default
 * home is used, and proves the flow creates only the review ledger there (no board, queue or session state).
 */
test("packet, record, resolve and gate run with no hub and the default home", () => {
  const home = temp("arev-home-");
  const root = temp("arev-standalone-");
  const repo = join(root, "repo"), reports = temp("arev-reports-");
  mkdirSync(repo);
  gitOut(repo, ["init", "-q", "-b", "main"]);
  gitOut(repo, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  writeFileSync(join(repo, "REVIEW.md"), "# Review\n- Every change is reviewed against its packet.\n");
  writeFileSync(join(repo, "src-a.ts"), "export const a = 1;\n");
  gitOut(repo, ["add", "."]);
  gitOut(repo, ["commit", "-qm", "base"]);
  const base = gitOut(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "src-a.ts"), "export const a = 2;\n");
  gitOut(repo, ["add", "."]);
  gitOut(repo, ["commit", "-qm", "head"]);
  const head = gitOut(repo, ["rev-parse", "HEAD"]);

  const env: Record<string, string | undefined> = { ...GIT_ENV, HOME: home };
  delete env.AGENTHUB_HOME;
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve(import.meta.dir, "../bin/arev.js"), ...args],
    { cwd: repo, encoding: "utf8", env });

  const built = cli("packet", "--from", base, "--to", head, "--json");
  expect(built.status).toBe(0);
  const packet = JSON.parse(built.stdout) as BuiltPacket;
  expect(packet.units.map(unit => unit.path)).toEqual(["src-a.ts"]);

  // A hand-written report, the way a session without arev's own tooling produces one.
  const report = join(reports, "report.json");
  writeFileSync(report, JSON.stringify({
    v: 1,
    packet: { id: packet.id, subject: packet.subject },
    reviewer: { id: "qwen", modelFamily: "qwen", started: "self", implementer: "codex", sameFamilyFallback: false },
    coverage: { reviewed: packet.units.map(unit => unit.path), skipped: [] },
    findings: [{
      id: "bugs:unframed-rule",
      term: "bugs",
      severity: "blocking",
      path: "src-a.ts",
      text: "the rules line was printed unframed",
      disposition: "open",
      origin: "introduced",
    }],
    verdict: "changes_requested",
    call: { ok: true },
  }));

  const recorded = cli("record", report);
  expect(recorded.stderr).toBe("");
  expect(recorded.status).toBe(0);
  expect(recorded.stdout).toContain("1 finding(s), 1 blocking open");

  const blocked = cli("gate", "--json");
  expect(blocked.status).toBe(1);
  expect(JSON.parse(blocked.stdout).open).toEqual(["blocking findings are open: bugs:unframed-rule"]);

  const resolved = cli("resolve", "bugs:unframed-rule", "--as", "fixed", "--evidence", "src-a.ts:1");
  expect(resolved.stderr).toBe("");
  expect(resolved.status).toBe(0);

  const passed = cli("gate");
  expect(passed.stderr).toBe("");
  expect(passed.status).toBe(0);
  expect(passed.stdout).toContain("gate: passes");
  expect(JSON.parse(cli("show", "--json").stdout).openBlocking).toEqual([]);

  // The default home is where the ledger landed, and the flow wrote nothing else there.
  expect(readdirSync(join(home, ".agenthub"))).toEqual(["review"]);
  const ledger = join(home, ".agenthub", "review", "github.com/owner/repo", "ledger.jsonl");
  expect(existsSync(ledger)).toBe(true);
  const types = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map(line => (JSON.parse(line) as { type: string }).type);
  expect(types).toEqual(["packet", "record", "resolve"]);
});
