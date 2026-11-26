import { createHash } from "node:crypto";
import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { argumentError } from "@staix/mcp-stdio";
import { Refusal, appendEvent, readLedger } from "../src/ledger.ts";
import { MCP_TOOLS, mcpFailureText, mcpHandlers } from "../src/mcp.ts";
import { buildPacket } from "../src/packet.ts";

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

type Schema = {
  properties?: Record<string, { enum?: string[] }>;
  required?: string[];
  additionalProperties?: unknown;
};
const tools = MCP_TOOLS as unknown as { name: string; inputSchema: Schema }[];
const schemaOf = (name: string): Schema => tools.find(tool => tool.name === name)!.inputSchema;

/** A packet and the report written from it, so the schema cases run on the arguments the flow really passes. */
function flow(dir: string, base: string): { request: Record<string, unknown>; report: Record<string, unknown> } {
  const built = mcpHandlers(dir).arev_packet({ subject: "range", base, head: "HEAD" }) as
    { packet: { id: string; subject: unknown; units: { path: string }[] } };
  const request = { subject: "range", base, head: "HEAD" };
  const report = {
    v: 1,
    packet: { id: built.packet.id, subject: built.packet.subject },
    reviewer: { id: "codex", modelFamily: "codex", started: "self", implementer: "qwen", sameFamilyFallback: false },
    coverage: { reviewed: built.packet.units.map(unit => unit.path), skipped: [] },
    findings: [],
    verdict: "approved",
    call: { ok: true },
  };
  return { request, report };
}

test("the tool table routes accepted to the refusal and offers no post", () => {
  expect(MCP_TOOLS.map(tool => tool.name))
    .toEqual(["arev_packet", "arev_rules", "arev_record", "arev_resolve", "arev_show", "arev_gate"]);
  expect(schemaOf("arev_resolve").properties?.as?.enum).toEqual(["fixed", "false_positive", "accepted"]);
  // The one GitHub write stays CLI-only, whatever a description says: no tool takes a post flag.
  expect(tools.some(tool => Object.hasOwn(tool.inputSchema.properties ?? {}, "post"))).toBe(false);
});

test("every tool's schema accepts the arguments the flow passes, under the protocol's own validator", () => {
  const { dir, base } = repo();
  const { request, report } = flow(dir, base);
  const cases: [string, Record<string, unknown>][] = [
    ["arev_packet", request],
    ["arev_rules", { paths: ["src/a.ts"] }],
    ["arev_record", { report }],
    ["arev_resolve", { finding: "bugs:x", as: "fixed", evidence: ["src/a.ts:1"] }],
    ["arev_show", {}],
    ["arev_gate", {}],
  ];
  for (const [name, args] of cases) expect([name, argumentError(args, schemaOf(name))]).toEqual([name, undefined]);
  // The report's own fields are the handler's to read, but the envelope stays closed: a stray argument is refused
  // before a handler sees it.
  expect(argumentError({ report, post: true }, schemaOf("arev_record"))).toBe("unknown argument: post");
});

test("arev_rules takes no base argument, so the trusted merge base is the only one read", () => {
  expect(argumentError({ paths: ["src/a.ts"], base: "HEAD" }, schemaOf("arev_rules"))).toBe("unknown argument: base");
  const { dir, base } = repo();
  const result = mcpHandlers(dir).arev_rules({ paths: ["src/a.ts"] }) as { base: string; rules: string };
  expect(result.base).toBe(base);
});

test("arev_record takes no light argument, so lightness stays a statement a person makes at a terminal", () => {
  expect(Object.hasOwn(schemaOf("arev_record").properties ?? {}, "light")).toBe(false);
  expect(argumentError({ report: {}, light: true }, schemaOf("arev_record"))).toBe("unknown argument: light");
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

test("arev_resolve refuses arguments it will not echo: the id and the head", () => {
  const { dir } = repo();
  const handlers = mcpHandlers(dir);
  const complaint = (args: Record<string, unknown>): string => {
    try {
      handlers.arev_resolve(args);
    } catch (error) {
      return error instanceof Error ? error.message : "no error";
    }
    return "no error";
  };
  // An id is a shape before it is a lookup: a value outside the finding-id charset is named by its argument only.
  const idMessage = complaint({ finding: "review text with spaces and sk-live-abc123", as: "fixed" });
  expect(idMessage).toContain("arev_resolve needs finding");
  expect(idMessage).not.toContain("sk-live-abc123");
  expect(idMessage).not.toContain("review text");
  // A head keys the resolve event, so it is a full SHA or refused, and the value is not repeated.
  const headMessage = complaint({ finding: "bugs:x", as: "fixed", head: "HEAD-of-someone" });
  expect(headMessage).toContain("arev_resolve needs head: a full commit SHA");
  expect(headMessage).not.toContain("HEAD-of-someone");
});

test("a failed tool call carries a cause and a next step, and never an internal message", () => {
  expect(mcpFailureText(new Refusal("no origin default branch is available", "fetch origin and retry")))
    .toBe("no origin default branch is available Next: fetch origin and retry");
  const internal = mcpFailureText(new Error("EACCES: open /tmp/secret-report.json"));
  expect(internal).not.toContain("secret-report");
  expect(internal).toContain("arev <command> --help");
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

test("the AC9 flow runs over the tools, validated as the protocol validates it", () => {
  const { dir, base } = repo();
  const { report } = flow(dir, base);
  // The report the flow writes is what the protocol has to accept before any handler runs.
  expect(argumentError({ report }, schemaOf("arev_record"))).toBeUndefined();
  const handlers = mcpHandlers(dir);
  const recorded = handlers.arev_record({ report }) as { id: string; head: string; blockingOpen: number };
  expect(recorded.blockingOpen).toBe(0);
  const shown = handlers.arev_show({}) as { view: { record?: string; counts: { important: number } } };
  expect(shown.view.record).toBe(recorded.id);
  const gated = handlers.arev_gate({}) as { ok: boolean; open: string[]; record?: string };
  expect(gated.open).toEqual([]);
  expect(gated.ok).toBe(true);
  expect(gated.record).toBe(recorded.id);
});

test("stdio packet, record and gate complete over actual JSON-RPC", () => {
  const { dir, base } = repo();
  const { packet } = buildPacket(dir, { kind: "range", base, head: "HEAD" });
  const report = {
    v: 1, packet,
    reviewer: { id: "reviewer-fixture", modelFamily: "fixture-family", started: "manual",
      implementer: "implementer-fixture", sameFamilyFallback: false },
    coverage: { reviewed: packet.units.map(unit => unit.path), skipped: [] },
    findings: [], verdict: "approved", call: { ok: true },
  };
  const call = (id: number, name: string, args: Record<string, unknown>) =>
    ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    call(2, "arev_packet", { subject: "range", base, head: "HEAD" }),
    call(3, "arev_record", { report }),
    call(4, "arev_gate", { pr: "none" }),
    call(5, "arev_resolve", { finding: "bugs:fixture", as: "accepted" }),
  ].map(message => JSON.stringify(message)).join("\n") + "\n";
  const run = spawnSync(process.execPath, [join(import.meta.dir, "../bin/arev.js"), "mcp"],
    { cwd: dir, input, encoding: "utf8", timeout: 15_000 });
  expect(run.status).toBe(0);
  expect(run.stderr).toBe("");
  const replies = run.stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(replies.map(reply => reply.id)).toEqual([1, 2, 3, 4, 5]);
  expect(JSON.parse(replies[1].result.content[0].text).packet.id).toBe(packet.id);
  const recorded = JSON.parse(replies[2].result.content[0].text);
  expect(recorded.id).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.parse(replies[3].result.content[0].text)).toMatchObject({ ok: true, record: recorded.id });
  expect(replies[4].error).toBeUndefined();
  expect(replies[4].result.isError).toBe(true);
  expect(replies[4].result.content[0].text).toContain("arev resolve <id> --as accepted");
  expect(replies[4].result.content[0].text).toContain("at their terminal");
  expect(readLedger(dir).map(event => event.type)).toEqual(["packet", "record"]);
});

test("MCP selects and resolves findings only in the requested PR thread", () => {
  const { dir, base } = repo();
  const handlers = mcpHandlers(dir);
  for (const pr of [undefined, 7] as const) {
    const { packet } = buildPacket(dir, { kind: "range", base, head: "HEAD", pr });
    appendEvent(dir, { v: 1, type: "packet", at: "2026-11-26T00:00:00Z", packet });
    handlers.arev_record({ report: {
      v: 1, packet,
      reviewer: { id: "reviewer-fixture", modelFamily: "fixture-family", started: "manual",
        implementer: "implementer-fixture", sameFamilyFallback: false },
      coverage: { reviewed: packet.units.map(unit => unit.path), skipped: [] },
      findings: [{ id: "bugs:fixture", term: "bugs", severity: "blocking",
        text: "Fixture finding", disposition: "open", origin: "introduced" }],
      verdict: "changes_requested", call: { ok: true },
    } });
  }
  expect(() => handlers.arev_show({})).toThrow("more than one thread");
  handlers.arev_resolve({ finding: "bugs:fixture", as: "fixed", pr: 7 });
  expect(handlers.arev_show({ pr: "none" })).toMatchObject({ view: { openBlocking: ["bugs:fixture"] } });
  expect(handlers.arev_show({ pr: 7 })).toMatchObject({ view: { openBlocking: [] } });
  expect(handlers.arev_gate({ pr: "none" })).toMatchObject({ ok: false });
});

test("MCP records a contract-bearing packet without rereading the original contract", () => {
  const { dir, base } = repo();
  const entry = join(import.meta.dir, "../bin/arev.js");
  const contract = join(dir, "local-contract.md");
  writeFileSync(contract, "Original fixture contract\n");
  const built = spawnSync(process.execPath, [entry, "packet", "--from", base, "--to", "HEAD",
    "--contract", contract, "--json"], { cwd: dir, encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
  const { packet } = JSON.parse(built.stdout);
  expect(packet.contract).toMatchObject({ kind: "brief", ref: "local-contract.md" });
  rmSync(contract);
  const report = {
    v: 1, packet,
    reviewer: { id: "fixture-reviewer", modelFamily: "fixture-family", started: "manual", sameFamilyFallback: false },
    coverage: { reviewed: ["src/a.ts"], skipped: [] },
    findings: [], verdict: "approved", call: { ok: true },
  };
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "arev_record", arguments: { report } } },
  ].map(message => JSON.stringify(message)).join("\n") + "\n";
  const recorded = spawnSync(process.execPath, [entry, "mcp"], { cwd: dir, input, encoding: "utf8", timeout: 15_000 });
  expect(recorded.status, recorded.stderr).toBe(0);
  const response = JSON.parse(recorded.stdout.trim().split("\n").at(-1)!);
  expect(response.result.isError).toBeUndefined();
  expect(JSON.parse(response.result.content[0].text).id).toMatch(/^[a-f0-9]{64}$/);
  const event = readLedger(dir).at(-1);
  expect(event).toMatchObject({ type: "record", record: { packet: { id: packet.id, contract: packet.contract } } });
});

test("MCP PR packet delivers the framed contract whose digest it binds", () => {
  const { dir, base } = repo();
  const head = buildPacket(dir, { kind: "range", base, head: "HEAD" }).packet.subject.head;
  const bin = mkdtempSync(join(tmpdir(), "arev-mcp-contract-gh-"));
  cleanup.push(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$1:$3" in
  pr:7) printf '%s\\n' '{"baseRefOid":"${base}","headRefOid":"${head}","title":"PR fixture","body":"Contract in #8"}' ;;
  issue:8) printf '%s\\n' '{"body":"## Issue requirement"}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "arev_packet", arguments: { subject: "pr", number: "7" } } },
  ].map(message => JSON.stringify(message)).join("\n") + "\n";
  const run = spawnSync(process.execPath, [join(import.meta.dir, "../bin/arev.js"), "mcp"], {
    cwd: dir, input, encoding: "utf8", timeout: 15_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  expect(run.status, run.stderr).toBe(0);
  const response = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  expect(response.result.isError).toBeUndefined();
  const result = JSON.parse(response.result.content[0].text);
  expect(result.contract).toContain("> ## Issue requirement");
  expect(result.packet.contract.sha256).toBe(createHash("sha256").update(result.contract).digest("hex"));
  expect(result.brief).toContain("the contract field of this result");
  expect(result.brief).not.toContain("contract.md");
});
