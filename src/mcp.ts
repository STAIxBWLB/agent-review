/**
 * `arev mcp`: the six review tools of AC9 over newline JSON-RPC on stdin and stdout, through `@staix/mcp-stdio`.
 *
 * A handler returns data and never prints. The protocol owns stdout, so a command wrapper that writes there would
 * corrupt the stream: every tool calls the same function its command calls and hands back the result. `arev_resolve`
 * offers `fixed` and `false_positive` only, because `accepted` is the person's decision at a terminal and a server
 * never has one; `arev_gate` takes no `--post`, so the one GitHub write stays CLI-only (AC5, AC9).
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT } from "@staix/cli-output";
import { serve, type Handler, type Tool } from "@staix/mcp-stdio";
import { version } from "../package.json";
import { gateReport } from "./gate.ts";
import { MAX_REPORT_BYTES, Refusal, readLedger } from "./ledger.ts";
import { buildPacket, packetBrief, packetResult, type PacketRequest, type ReviewPacket } from "./packet.ts";
import { appendPacketEvent, packetSettings, rulesForPaths } from "./packet-cli.ts";
import { assertReviewReportSafe, ledgerEventsView, parseReviewRecord, recordReview, resolveFinding, resolveHead, type ThreadSelector } from "./record.ts";

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** A refusal is the only way a handler reports a caller mistake; the message is already screened of report text. */
const fail = (message: string, next: string): never => {
  throw new Refusal(message, next);
};

function pathsArgument(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0
    || !value.every(item => typeof item === "string" && item.trim() !== "")) return undefined;
  return value as string[];
}

/** A recorded finding id's charset (the report's own bound), so an argument the ledger names is checked first. */
const FINDING_ID = /^[A-Za-z0-9._:-]{1,96}$/;
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function reviewThread(value: unknown): ThreadSelector | undefined {
  if (value === undefined || value === "none") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  return fail("pr must be a positive pull request number or none", "pass the review's PR number, or none to select the no-PR thread");
}

function reviewHead(value: unknown, tool: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && FULL_OID.test(value)) return value;
  return fail(`${tool} needs head: a full commit SHA`, "pass the full head SHA from the review packet");
}

/** The `arev packet` subject a call asks for. No refusal echoes an argument: each names the argument instead. */
function packetRequest(args: Record<string, unknown>): PacketRequest {
  const subject = text(args.subject);
  if (subject === "pr") {
    const number = text(args.number);
    if (number === undefined) return fail("arev_packet needs number for a pr subject", "pass number: the pull request number");
    return { kind: "pr", number };
  }
  if (subject === "range") {
    const base = text(args.base), head = text(args.head);
    if (base === undefined || head === undefined) return fail("arev_packet needs base and head for a range subject", "pass base and head: a ref or a full commit SHA");
    return { kind: "range", base, head };
  }
  if (subject === "commit") {
    const commit = text(args.commit);
    if (commit === undefined) return fail("arev_packet needs commit for a commit subject", "pass commit: the commit SHA or ref");
    return { kind: "commit", commit };
  }
  if (subject === "workspace") return { kind: "workspace" };
  if (subject === "files") {
    const paths = pathsArgument(args.paths);
    if (paths === undefined) return fail("arev_packet needs paths for a files subject", "pass paths: one or more repository-relative paths");
    return { kind: "files", paths };
  }
  return fail("arev_packet needs subject pr, range, commit, workspace or files", "pass subject: one of pr, range, commit, workspace, files");
}

/**
 * AC9's tool list, named once: the handler record and the tool table are both keyed by it, so a tool can be neither
 * served without a handler nor handled without a schema.
 */
export const MCP_TOOL_NAMES = ["arev_packet", "arev_rules", "arev_record", "arev_resolve", "arev_show", "arev_gate"] as const;
export type McpToolName = typeof MCP_TOOL_NAMES[number];

/**
 * The tool table and its handlers, bound to the repository `cwd`. Handlers are exported separately from `MCP_TOOLS` so
 * a test can drive a tool directly and assert that nothing was printed.
 */
export function mcpHandlers(cwd: string): Record<McpToolName, Handler> {
  return {
    arev_packet: args => {
      const bundle = buildPacket(cwd, packetRequest(args));
      // `arev record` checks a report against the packet the ledger holds, so the tool writes it exactly as the command
      // does - the same cap from the same REVIEW.md - and only then hands the packet back.
      appendPacketEvent(cwd, bundle, packetSettings(cwd, bundle));
      return packetResult(bundle);
    },
    arev_rules: args => {
      const paths = pathsArgument(args.paths);
      if (paths === undefined) return fail("arev_rules needs paths: one or more repository-relative paths", "pass paths: the files whose rules you need");
      // The merge base is always the computed one: a caller-supplied base could name HEAD, and rules read from the head
      // are the rules the change itself rewrote, which is what AC2 exists to prevent.
      const { base, rules } = rulesForPaths(cwd, paths);
      return { base, ...rules };
    },
    arev_record: args => {
      const report = args.report;
      if (!report || typeof report !== "object" || Array.isArray(report)) {
        return fail("arev_record needs report: the report body as an object", "pass report: the JSON you wrote for this packet");
      }
      const implementer = text(args.implementer);
      // No `light` here: a report's lightness is the reviewer's claim about how the review was made and it relaxes the
      // gate, so only `arev record --light` at a terminal states it (AC2). A server is never a person.
      return recordReview(cwd, report, { label: "argument",
        ...(implementer === undefined ? {} : { implementer }) });
    },
    arev_resolve: args => {
      const finding = text(args.finding);
      if (finding === undefined || !FINDING_ID.test(finding)) {
        return fail("arev_resolve needs finding: a recorded finding id", "pass finding: an id from arev_show");
      }
      const as = args.as;
      // `accepted` is the person's decision, and a server has no terminal: the CLI refuses it there too.
      if (as === "accepted") {
        return fail("accepted is the person's decision and is refused over MCP",
          `ask them to run arev resolve <id> --as accepted --rationale "<what was accepted>" at their terminal`);
      }
      if (as !== "fixed" && as !== "false_positive") {
        return fail("arev_resolve settles a finding as fixed or false_positive", "pass as: fixed or false_positive");
      }
      const evidence = args.evidence === undefined ? [] : pathsArgument(args.evidence);
      if (evidence === undefined) return fail("arev_resolve evidence must be one or more strings", "pass evidence: a path:line or a command's output that settles the finding");
      const rationale = text(args.rationale);
      const head = reviewHead(args.head, "arev_resolve");
      const pr = reviewThread(args.pr);
      return resolveFinding(cwd, finding, { as, person: false, evidence, head, pr, rationale });
    },
    arev_show: args => {
      const requested = reviewHead(args.head, "arev_show");
      const head = requested === undefined ? undefined : resolveHead(cwd, requested);
      const pr = reviewThread(args.pr);
      const events = readLedger(cwd);
      if (events.length === 0) return { events: 0 };
      return { events: events.length, view: ledgerEventsView(events, head, pr) };
    },
    arev_gate: args => {
      const head = reviewHead(args.head, "arev_gate");
      const pr = reviewThread(args.pr);
      return gateReport(cwd, { head, pr });
    },
  };
}

const REPORT_SCHEMA = {
  type: "object",
  description: "The report body you wrote for this packet, as JSON. arev checks it field by field against the packet.",
  // Advertise rubric report fields while leaving the rest of the report envelope open. Only parseReviewRecord knows
  // the packet's criterion IDs, scales and digest, so it performs the authoritative validation.
  properties: {
    rubricSha256: { type: "string", description: "SHA-256 of the rubric bound in the packet." },
    rubricScores: {
      type: "array", maxItems: 20,
      items: {
        type: "object", required: ["id", "score"], additionalProperties: false,
        properties: { id: { type: "string" }, score: { oneOf: [{ type: "boolean" }, { type: "integer" }] } },
      },
    },
  },
  additionalProperties: {},
} as const;

const THREAD_SCHEMA = {
  oneOf: [{ type: "integer", minimum: 1 }, { type: "string", enum: ["none"] }],
} as const;

export const MCP_TOOLS: readonly (Tool & { name: McpToolName })[] = [
  {
    name: "arev_packet",
    description: "Build the review packet for one subject: its units, excluded paths and framed review brief. Use arev packet --out DIR in the CLI when the diff is too large for one response.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", enum: ["pr", "range", "commit", "workspace", "files"] },
        number: { type: "string", description: "Pull request number, for subject pr." },
        base: { type: "string", description: "Base ref or full commit SHA, for subject range." },
        head: { type: "string", description: "Head ref or full commit SHA, for subject range." },
        commit: { type: "string", description: "Commit SHA or ref, for subject commit." },
        paths: { type: "array", items: { type: "string" }, maxItems: 500, description: "Repository-relative paths, for subject files." },
      },
      required: ["subject"],
      additionalProperties: false,
    },
  },
  {
    name: "arev_rules",
    description: "Read the rule files that apply to paths, at the merge base of the origin default branch against HEAD, so a change cannot rewrite the rules it is reviewed under. The merge base is always computed here; there is no way to ask for another base.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, maxItems: 500, description: "Repository-relative paths." },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "arev_record",
    description: "Validate a report against the packet in the ledger for its head and append it: the record id, verdict and finding tally come back. A refused report returns the reason and the next step. A review made without REVIEW.md is recorded with arev record --light in the CLI: lightness relaxes the gate, so only a person at a terminal states it.",
    inputSchema: {
      type: "object",
      properties: {
        report: REPORT_SCHEMA,
        implementer: { type: "string", description: "Who wrote the reviewed change, when the report does not say." },
      },
      required: ["report"],
      additionalProperties: false,
    },
  },
  {
    name: "arev_resolve",
    description: "Settle one recorded finding as fixed or false_positive, with the evidence or rationale the disposition needs. accepted is refused with the terminal command because it is the person's decision.",
    inputSchema: {
      type: "object",
      properties: {
        finding: { type: "string", description: "The recorded finding id, as arev_show reports it." },
        // Admit the spelling at the protocol boundary so the handler can give the terminal-only refusal.
        as: { type: "string", enum: ["fixed", "false_positive", "accepted"],
          description: "MCP can apply fixed or false_positive. For accepted, run arev resolve <id> --as accepted --rationale <reason> at your terminal." },
        evidence: { type: "array", items: { type: "string" }, maxItems: 16, description: "path:line or command output, required for false_positive." },
        rationale: { type: "string", description: "What was settled and why, at most 2048 bytes." },
        head: { type: "string", description: "Full head SHA to resolve against; defaults to the newest record's." },
        pr: THREAD_SCHEMA,
      },
      required: ["finding", "as"],
      additionalProperties: false,
    },
  },
  {
    name: "arev_show",
    description: "Show the recorded review for a head: findings with their lifecycle, the counts, and the blocking ids that keep arev_gate failing.",
    inputSchema: {
      type: "object",
      properties: {
        head: { type: "string", description: "Full head SHA; defaults to the newest record's head." },
        pr: THREAD_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "arev_gate",
    description: "Answer whether this exact head is reviewed, naming each open condition. Reads the ledger and git only, and posts no status: arev gate --post is CLI-only.",
    inputSchema: {
      type: "object",
      properties: {
        head: { type: "string", description: "Full head SHA; defaults to the repository's HEAD." },
        pr: THREAD_SCHEMA,
      },
      additionalProperties: false,
    },
  },
];

export const RUN_STATE_FILE = ".arev-run.json";
export const RUN_REPORT_FILE = "report.json";
export const RUN_TOOL_NAMES = ["arev_packet", "arev_rules", "arev_show", "arev_record"] as const;

function runArtifact(dir: string, name: string, limit: number): string {
  const path = join(dir, name);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > limit) throw new Error("not a bounded regular file");
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text) > limit) throw new Error("artifact exceeds its limit");
    return text;
  } catch {
    return fail(`Cannot read the run artifact ${name}`, "use the output directory of the current arev run");
  }
}

function runJson(dir: string, name: string): unknown {
  const text = runArtifact(dir, name, MAX_REPORT_BYTES);
  try { return JSON.parse(text); }
  catch { return fail(`The run artifact ${name} is not valid JSON`, "use the output directory of the current arev run"); }
}

function runHandlers(dir: string): Record<typeof RUN_TOOL_NAMES[number], Handler> {
  const state = runJson(dir, RUN_STATE_FILE) as { packetId?: string; advisoryCap?: number } | null;
  const packet = runJson(dir, "packet.json") as ReviewPacket | null;
  const cap = state?.advisoryCap;
  if (!packet?.subject || !state || !/^[a-f0-9]{64}$/.test(state.packetId ?? "") ||
      packet.id !== state.packetId || typeof cap !== "number" || !Number.isInteger(cap) || cap < 0 || cap > 64) {
    return fail("The run metadata does not match a packet", "restart arev run with a fresh output directory");
  }
  const contract = packet.contract === undefined ? undefined : runArtifact(dir, "contract.md", 128 * 1024);
  if (contract !== undefined && createHash("sha256").update(contract).digest("hex") !== packet.contract?.sha256) {
    return fail("The run contract does not match the packet digest", "restart arev run with a fresh output directory");
  }
  const reportPath = join(dir, RUN_REPORT_FILE);
  const rules = () => runArtifact(dir, "rules.md", 2 * 1024 * 1024);
  return {
    arev_packet: () => {
      const briefFile = runArtifact(dir, "brief.md", 32 * 1024 * 1024);
      // Remove the file-only pointer before packetResult supplies the structured result's pointer.
      const bundle = { packet, brief: "", contractText: contract, rules: "", rulesMissing: [], diff: "" };
      const pointer = packetBrief(bundle, "file");
      const brief = pointer && briefFile.endsWith(pointer + "\n") ? briefFile.slice(0, -pointer.length - 1) : briefFile.trimEnd();
      return packetResult({ ...bundle, brief });
    },
    arev_rules: () => ({ base: packet.subject.mergeBase, rules: rules() }),
    arev_show: () => ({ head: packet.subject.head, packet: packet.id, staged: existsSync(reportPath) }),
    arev_record: ({ report }) => {
      if (!report || typeof report !== "object" || Array.isArray(report)) {
        return fail("arev_record needs a report object", "pass the JSON report for this run's packet");
      }
      assertReviewReportSafe(report, "argument");
      const staged = { ...report, reviewer: {} };
      // Validate the report against the active packet, with no reviewer claim supplied by the caller.
      // The outer runner alone attests and records it after checking the checkout.
      parseReviewRecord(staged, { packet, maxAdvisories: cap,
        run: { packetId: packet.id, host: "pending", model: "unknown", implementer: "pending", sameFamilyFallback: false } });
      try {
        writeFileSync(reportPath, JSON.stringify(staged) + "\n", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return fail("A report is already staged for this run", "leave it in place and let arev run finish");
        }
        return fail("Cannot stage the reviewer report", "check the run output directory permissions and retry");
      }
      return { staged: true, packet: packet.id };
    },
  };
}

const RUN_TOOLS: readonly Tool[] = RUN_TOOL_NAMES.map(name => ({
  name,
  description: {
    arev_packet: "Read the active run packet, framed brief and contract.",
    arev_rules: "Read the framed rules of the active run packet.",
    arev_show: "Show the active packet head and whether a report has been staged.",
    arev_record: "Validate and stage one report for this run. arev run records it after checkout verification.",
  }[name],
  inputSchema: name === "arev_record"
    ? { type: "object", properties: { report: REPORT_SCHEMA }, required: ["report"], additionalProperties: false }
    : { type: "object", properties: {}, additionalProperties: false },
}));

const INSTRUCTIONS = "arev is deterministic review tooling. Build a packet, read its brief, record the report you wrote, settle findings, then gate the head. accepted findings, arev record --light and arev gate --post are CLI-only.";

/**
 * What a failed tool call answers with. A refusal already carries its cause and the next step. Anything else is an
 * internal failure whose own message can hold reviewed content or a path, so the caller gets a fixed, bounded line that
 * names the CLI as the way to see the cause; an unrun check is never reported as a pass.
 */
export function mcpFailureText(error: unknown): string {
  if (error instanceof Refusal) return `${error.message} Next: ${error.next}`;
  return "the tool failed before it answered. Run the same step with the CLI (arev <command> --help) to see the cause.";
}

const RUN_FRAME_BYTES = MAX_REPORT_BYTES + 8192;

/** `arev mcp`: serve until stdin closes. `bin/arev.js` sets an exit code and leaves the loop alive on stdin. */
export function mcpCommand(cwd: string, args: readonly string[]): number {
  const run = args.length === 2 && args[0] === "--run" && args[1] ? resolve(cwd, args[1]) : undefined;
  if (args.length > 0 && run === undefined) {
    console.error("arev: mcp takes no arguments or --run DIR. Run arev mcp --help.");
    return EXIT.usage;
  }
  void serve({ name: "arev", version,
    tools: run === undefined ? MCP_TOOLS : RUN_TOOLS,
    handlers: run === undefined ? mcpHandlers(cwd) : runHandlers(run),
    instructions: run === undefined ? INSTRUCTIONS : "Read the active packet with arev_packet, then stage one report using arev_record. The runner records it after checkout verification.",
    failureText: mcpFailureText,
    ...(run === undefined ? {} : { limits: { frameBytes: RUN_FRAME_BYTES, resultBytes: 32 * 1024 * 1024 } }),
  })
    .catch(error => {
      console.error(`arev mcp: ${error instanceof Error ? error.message : "the server stopped"}`);
      process.exitCode = EXIT.fail;
    });
  return EXIT.ok;
}
