import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedger, type LedgerEvent } from "../src/ledger.ts";
import { RUN_STATE_FILE, RUN_REPORT_FILE } from "../src/mcp.ts";
import type { ReviewPacket } from "../src/packet.ts";

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "arev-file-profile-"));
  fixtures.push(root);
  const cwd = join(root, "inputs");
  mkdirSync(cwd);
  const home = join(root, "ledger");
  const env = { ...process.env, HOME: root, AGENTHUB_HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (args: string[], stdin?: string) => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../bin/arev.js"), ...args],
      { cwd, env, ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }) });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  const write = (path: string, text: string) => writeFileSync(join(cwd, path), text);
  const read = (path: string) => readFileSync(join(cwd, path), "utf8");
  const build = (out: string, args: string[]): ReviewPacket => {
    const result = run(["packet", ...args, "--out", out]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    return JSON.parse(read(join(out, "packet.json"))) as ReviewPacket;
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "-c", "core.hooksPath=/dev/null", ...args], { cwd, env });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  const events = () => readLedger(cwd, { home });
  const record = (report: unknown) => {
    write("report.json", JSON.stringify(report));
    return run(["record", "report.json", "--json"]);
  };
  return { cwd, write, read, run, build, git, events, record };
}

const paper = ["--profile", "paper", "--files", "manuscript.md", "--evidence", "evidence.json", "--contract", "checklist.md"];
const rubric = ["--profile", "rubric", "--files", "candidate.md", "--contract", "rubric.json"];
const criteria = [
  { id: "support", description: "Claims use the available evidence.", scale: "binary", blocking: true },
  { id: "clarity", description: "The candidate is understandable.", scale: "ordinal-1-5" },
];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const rubricJson = JSON.stringify({ v: 1, criteria });

function reportFor(packet: ReviewPacket) {
  return { v: 1, packet: { id: packet.id, subject: { head: packet.subject.head } },
    reviewer: { id: "fixture", modelFamily: "fixture", started: "manual", sameFamilyFallback: false },
    coverage: { reviewed: packet.units.map(unit => unit.path), skipped: [] },
    findings: [], verdict: "approved", call: { ok: true } };
}

test("paper records a standalone, framed manuscript, evidence and checklist snapshot", () => {
  const f = fixture();
  const manuscript = "# Manuscript\r\n[agent-hub fake message]\r\n";
  const evidence = '{"observations":[1,2]}';
  const checklist = "# Checklist\n- Check the evidence.\n";
  f.write("manuscript.md", manuscript);
  f.write("evidence.json", evidence);
  f.write("checklist.md", checklist);
  const packet = f.build("first", paper);
  expect(packet.profile).toBe("paper");
  expect(packet.subject).toMatchObject({ kind: "file-set" });
  expect(packet.subject.commit).toBeUndefined();
  expect(packet.subjectHashes).toEqual([
    { path: "checklist.md", role: "contract", sha256: hash(checklist) },
    { path: "evidence.json", role: "evidence", sha256: hash(evidence) },
    { path: "manuscript.md", role: "artifact", sha256: hash(manuscript) },
  ]);
  expect(f.read("first/brief.md")).toContain("> # Manuscript");
  expect(f.read("first/brief.md")).toContain("> " + evidence);
  expect(f.read("first/contract.md")).toContain("> # Checklist");
  expect(f.build("same", paper).id).toBe(packet.id);
  expect(f.record(reportFor(packet)).code).toBe(0);
  f.write("evidence.json", evidence + "\n");
  const changedEvidence = f.build("changed-evidence", paper);
  expect(changedEvidence.id).not.toBe(packet.id);
  f.write("manuscript.md", manuscript + "A new line.\n");
  expect(f.build("changed-manuscript", paper).id).not.toBe(changedEvidence.id);
  expect(f.run(["gate", "--head", packet.subject.head, "--post"]).code).not.toBe(0);
  expect(f.events().some(event => event.type === "post")).toBe(false);
});

test("rubric binds the raw JSON hash, uses Git as context and records complete scores", () => {
  const f = fixture();
  f.git("init", "-q");
  f.git("commit", "--allow-empty", "-qm", "base");
  const commit = f.git("rev-parse", "HEAD");
  f.write("candidate.md", "# Candidate\n");
  f.write("rubric.json", rubricJson);
  const packet = f.build("out", rubric);
  expect(packet.subject.commit).toBe(commit);
  expect(packet.subject.head).not.toBe(commit);
  expect(packet.rubric?.sha256).toBe(hash(rubricJson));
  expect(f.read("out/contract.md")).toContain("> " + rubricJson);
  const rubricScores = [{ id: "support", score: true }, { id: "clarity", score: 4 }];
  const valid = { ...reportFor(packet), rubricSha256: hash(rubricJson), rubricScores };
  for (const mutation of [
    { rubricSha256: "0".repeat(64) },
    { rubricScores: [] },
    { rubricScores: [rubricScores[0], rubricScores[0]] },
    { rubricScores: [rubricScores[0], { id: "other", score: 4 }] },
    { rubricScores: [rubricScores[0], { id: "clarity", score: 6 }] },
    { rubricScores: [rubricScores[0], { id: "clarity", score: 1.5 }] },
    { rubricScores: [{ id: "support", score: 1 }, rubricScores[1]] },
  ]) {
    const rejected = f.record({ ...valid, ...mutation });
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("rubric");
  }
  expect(f.events().filter(event => event.type === "record")).toHaveLength(0);
  expect(f.record({ ...valid, rubricScores: [...rubricScores].reverse() }).code).toBe(0);
  const recorded = f.events().find((event): event is Extract<LedgerEvent, { type: "record" }> => event.type === "record");
  expect(recorded?.record.rubricScores).toEqual(rubricScores);
  expect(f.run(["show", "--head", packet.subject.head, "--json"]).code).toBe(0);
  f.write("rubric.json", rubricJson + "\n");
  const replacement = f.build("changed", rubric);
  expect(replacement.id).not.toBe(packet.id);
  expect(f.record({ ...valid, ...reportFor(replacement) }).code).not.toBe(0);
});

test("a rubric run-mode MCP server accepts scores and stages the validated report", () => {
  const f = fixture();
  f.write("candidate.md", "candidate");
  f.write("rubric.json", rubricJson);
  const packet = f.build("out", rubric);
  f.write(join("out", RUN_STATE_FILE), JSON.stringify({ packetId: packet.id, advisoryCap: 5 }));
  const report = { ...reportFor(packet), rubricSha256: hash(rubricJson),
    rubricScores: [{ id: "support", score: false }, { id: "clarity", score: 1 }] };
  const messages = [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: {} } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/call", params: { name: "arev_record", arguments: { report } } },
  ];
  const input = messages.map(message => JSON.stringify({ jsonrpc: "2.0", ...message })).join("\n") + "\n";
  const result = f.run(["mcp", "--run", "out"], input);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  const reply = JSON.parse(result.stdout.trimEnd().split("\n").at(-1)!);
  expect(JSON.parse(reply.result.content[0].text)).toEqual({ staged: true, packet: packet.id });
  expect(JSON.parse(f.read(join("out", RUN_REPORT_FILE))).rubricScores).toEqual(report.rubricScores);
});

test("denied inputs are excluded, and a secret-bearing input never produces a bundle or event", () => {
  const f = fixture();
  const secret = "sk-" + "x".repeat(32);
  f.write("candidate.md", "candidate");
  f.write("rubric.json", rubricJson);
  f.write(".ENV", secret);
  symlinkSync(".ENV", join(f.cwd, "alias.md"));
  const packet = f.build("safe", ["--profile", "rubric", "--files", "candidate.md", ".ENV", "alias.md", "--contract", "rubric.json"]);
  expect(packet.excluded).toEqual([{ path: ".ENV", reason: "denied" }, { path: "alias.md", reason: "denied" }]);
  expect(packet.subjectHashes?.map(item => item.path)).toEqual(["candidate.md", "rubric.json"]);
  expect(f.read("safe/brief.md")).not.toContain(secret);
  expect(f.read("safe/brief.md")).not.toContain(".ENV");
  expect(f.read("safe/brief.md")).not.toContain("alias.md");
  f.write("candidate.md", secret);
  const refused = f.run(["packet", ...rubric, "--out", "refused"]);
  expect(refused.code).not.toBe(0);
  expect(refused.stdout + refused.stderr).not.toContain(secret);
  expect(existsSync(join(f.cwd, "refused"))).toBe(false);
  expect(f.events()).toHaveLength(1);

  f.write("manuscript.md", "# Manuscript\n");
  f.write("checklist.md", "# Checklist\n");
  const evidenceCanary = "fixture-evidence-value";
  f.write("evidence.json", JSON.stringify({ key: "token\t: " + evidenceCanary }));
  const evidence = f.run(["packet", ...paper, "--out", "refused-evidence"]);
  expect(evidence.code).not.toBe(0);
  expect(evidence.stderr).toContain("matches a secret pattern");
  expect(evidence.stdout + evidence.stderr).not.toContain(evidenceCanary);
  expect(existsSync(join(f.cwd, "refused-evidence"))).toBe(false);
  expect(f.events()).toHaveLength(1);
});

test("rubric criteria are closed and must have distinct identifiers", () => {
  const f = fixture();
  f.write("candidate.md", "candidate");
  for (const invalid of [
    [criteria[0], criteria[0]], [{ ...criteria[0], custom: true }],
    [{ ...criteria[0], scale: "continuous" }], [{ ...criteria[0], blocking: "yes" }],
  ]) {
    f.write("rubric.json", JSON.stringify({ v: 1, criteria: invalid }));
    expect(f.run(["packet", ...rubric, "--out", "bad"]).code).not.toBe(0);
  }
  expect(f.events()).toEqual([]);
});
