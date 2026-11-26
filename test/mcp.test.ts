import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLedger } from "../src/ledger.ts";
import { MCP_TOOLS, mcpHandlers } from "../src/mcp.ts";

const cleanup: string[] = [];
const savedHome = process.env.AGENTHUB_HOME;
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.AGENTHUB_HOME;
  else process.env.AGENTHUB_HOME = savedHome;
});

/** A repository with a base commit, one change on top, and an origin default branch sitting at the base. */
function repo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "arev-mcp-")), home = mkdtempSync(join(tmpdir(), "arev-mcp-home-"));
  cleanup.push(dir, home);
  // The ledger lives under AGENTHUB_HOME and is refused inside the reviewed worktree, so the home is a sibling.
  process.env.AGENTHUB_HOME = home;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (...args: string[]): string => {
    const result = spawnSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", env });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  const write = (path: string, content: string): void => {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/owner/repo.git");
  write("REVIEW.md", "# Review\n- Every change is reviewed against its packet.\n");
  write("src/a.ts", "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  write("src/a.ts", "export const a = 2;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  return { dir, base };
}

type Schema = { properties?: Record<string, { enum?: string[] }> };

test("the tool table is AC9's six tools: no accepted, no post", () => {
  expect(MCP_TOOLS.map(tool => tool.name))
    .toEqual(["arev_packet", "arev_rules", "arev_record", "arev_resolve", "arev_show", "arev_gate"]);
  const tools = MCP_TOOLS as unknown as { name: string; inputSchema: Schema }[];
  const resolve = tools.find(tool => tool.name === "arev_resolve")!;
  expect(resolve.inputSchema.properties?.as?.enum).toEqual(["fixed", "false_positive"]);
  // The one GitHub write stays CLI-only, whatever a description says: no tool takes a post flag.
  expect(tools.some(tool => Object.hasOwn(tool.inputSchema.properties ?? {}, "post"))).toBe(false);
});

test("arev_packet writes the packet event and prints nothing", () => {
  const { dir, base } = repo();
  const printed = spyOn(process.stdout, "write");
  const writes = (): number => printed.mock.calls.length;
  const result = mcpHandlers(dir).arev_packet({ subject: "range", base, head: "HEAD" }) as
    { packet: { id: string }; brief: string };
  // A spy's restore clears what it recorded, so the count is read before it.
  expect(writes()).toBe(0);
  printed.mockRestore();
  expect(result.brief).toContain("Review brief:");
  // `arev record` checks a report against the packet the ledger holds, so the tool has to have written it.
  const [event] = readLedger(dir).filter(entry => entry.type === "packet");
  expect(event?.type).toBe("packet");
  expect(event?.type === "packet" ? event.packet.id : undefined).toBe(result.packet.id);
});

test("arev_record refuses a report with no head, naming the tool argument", () => {
  const { dir } = repo();
  expect(() => mcpHandlers(dir).arev_record({ report: { v: 1, packet: { subject: {} } } }))
    .toThrow(/the report argument has no full commit SHA at packet\.subject\.head/);
});

test("arev_resolve refuses accepted, naming the terminal", () => {
  const { dir } = repo();
  expect(() => mcpHandlers(dir).arev_resolve({ finding: "bugs:x", as: "accepted" }))
    .toThrow(/person's decision/);
});

test("arev_gate answers through the same decision the CLI prints, and posts nothing", () => {
  const { dir } = repo();
  const printed = spyOn(process.stdout, "write");
  const result = mcpHandlers(dir).arev_gate({}) as { head: string; ok: boolean; open: string[] };
  const writes = printed.mock.calls.length;
  printed.mockRestore();
  expect(writes).toBe(0);
  expect(result.ok).toBe(false);
  expect(result.open.length).toBeGreaterThan(0);
  expect(result.head).toMatch(/^[a-f0-9]{40}$/);
});

test("the AC9 flow runs over the tools: packet, record, then a gate that passes", () => {
  const { dir, base } = repo();
  const handlers = mcpHandlers(dir);
  const built = handlers.arev_packet({ subject: "range", base, head: "HEAD" }) as
    { packet: { id: string; subject: unknown; units: { path: string }[] } };
  const report = {
    v: 1,
    packet: { id: built.packet.id, subject: built.packet.subject },
    reviewer: { id: "codex", modelFamily: "codex", started: "self", implementer: "qwen", sameFamilyFallback: false },
    coverage: { reviewed: built.packet.units.map(unit => unit.path), skipped: [] },
    findings: [],
    verdict: "approved",
    call: { ok: true },
  };
  const recorded = handlers.arev_record({ report }) as { id: string; head: string; blockingOpen: number };
  expect(recorded.blockingOpen).toBe(0);
  const shown = handlers.arev_show({}) as { view: { record?: string; counts: { important: number } } };
  expect(shown.view.record).toBe(recorded.id);
  const gated = handlers.arev_gate({}) as { ok: boolean; open: string[]; record?: string };
  expect(gated.open).toEqual([]);
  expect(gated.ok).toBe(true);
  expect(gated.record).toBe(recorded.id);
});
