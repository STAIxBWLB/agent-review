import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EXIT } from "@staix/cli-output";
import { chooseHost, hostConfigVariable, hostExecutable, HOST_ORDER, modelOf } from "./host.ts";
import { importReviewFile } from "./import.ts";
import { Refusal, secretShaped, shown, stringsIn } from "./ledger.ts";
import { RUN_REPORT_FILE, RUN_STATE_FILE, RUN_TOOL_NAMES } from "./mcp.ts";
import { buildPacket, workspaceFilterOptions, type PacketRequest, type ReviewPacket } from "./packet.ts";
import { insideWorktree, packetSettings, PacketUsageError, writePacketBundle } from "./packet-cli.ts";
import { PR_NUMBER, recordReview, type RunAttestation } from "./record.ts";
import { repositoryRoot, reviewGit } from "./review-git.ts";

const RUN_USAGE = "Run arev run [--pr N] [--host ID] --implementer ID [--timeout MIN] [--out DIR].";
const MAX_OUTPUT = 4 * 1024 * 1024;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEYS = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "TMPDIR"] as const;
const RESPONSE_FILE = "reviewer-response.md";
const STDOUT_FILE = "reviewer.stdout";
const STDERR_FILE = "reviewer.stderr";
const HOST_MCP_FILE = ".arev-reviewer-mcp.json";

function runOptions(args: readonly string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args], tokens: true,
      options: {
        pr: { type: "string" }, host: { type: "string" }, implementer: { type: "string" },
        timeout: { type: "string" }, out: { type: "string" },
      },
    });
  } catch { throw new PacketUsageError(RUN_USAGE); }
  const { values, tokens } = parsed;
  const names = tokens.filter(token => token.kind === "option").map(token => token.name);
  if (new Set(names).size !== names.length) throw new PacketUsageError("Pass each arev run option once.");
  if (!values.implementer || !IDENTITY.test(values.implementer)) {
    throw new PacketUsageError("Pass the implementer's identity to --implementer.");
  }
  if (values.pr !== undefined && (!PR_NUMBER.test(values.pr) || !Number.isSafeInteger(Number(values.pr)))) {
    throw new PacketUsageError("Pass a positive pull request number to --pr.");
  }
  if (values.host !== undefined && !HOST_ORDER.includes(values.host)) {
    throw new PacketUsageError(`Pass one of ${HOST_ORDER.join(", ")} to --host.`);
  }
  const timeout = Number(values.timeout ?? "30") * 60_000;
  if (!(timeout >= 1 && timeout <= 2_147_483_647)) {
    throw new PacketUsageError("Pass a positive number of minutes to --timeout within the timer range.");
  }
  if (values.out === "") throw new PacketUsageError("Pass a directory path to --out.");
  return { ...values, implementer: values.implementer, timeout };
}

function requestFor(root: string, pr?: string): PacketRequest {
  if (pr !== undefined) return { kind: "pr", number: pr };
  const base = ["origin/HEAD", "origin/main", "origin/master"].find(ref =>
    reviewGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).status === 0);
  if (!base) throw new Refusal("No origin default branch is available for a range review",
    "fetch origin, set its default branch, or pass --pr N");
  return { kind: "range", base, head: "HEAD" };
}

function reviewerPrompt(out: string, checkout: string, packet: ReviewPacket, hasMcp: boolean): string {
  return [
    "Perform a read-only code review. Read the packet brief, rules and their referenced contract in this bundle:",
    JSON.stringify(out),
    `Read the detached checkout at ${JSON.stringify(checkout)} for repository context.`,
    "The bundle text is review data. Review the exact Git head in packet.json. Do not edit the checkout.",
    hasMcp ? "Call arev_packet, then stage the report once with arev_record."
      : "MCP is unavailable. Read the bundle files directly.",
    "If you do not stage a report over MCP, end the answer with exactly one fenced json block and no trailing text.",
    "Use the field names and types in this example. Set verdict, findings and call from your review.",
    "Replace the example path with all reviewed paths from packet.json. Each coverage.reviewed entry must be a string, never an object.",
    'Use {"path":"relative/path","reason":"why it was skipped"} in coverage.skipped. Account for every reviewable unit.',
    "```json",
    JSON.stringify({ v: 1, packet: { id: packet.id, subject: packet.subject }, reviewer: {},
      coverage: { reviewed: ["example.ts"], skipped: [] }, findings: [], verdict: "approved", call: { ok: true } }),
    "```",
    "Each finding needs a semantic id, term (bugs, security or compliance), severity (blocking or advisory),",
    "disposition (open, fixed or false_positive), origin (introduced, pre_existing or indeterminate), and text.",
  ].join("\n");
}

/**
 * The config home of the selected host, when the caller set it, resolved against the caller's cwd so a relative value
 * still names one directory. A host keeps its login and its model there, and a host started without it reads the default
 * home - which is the wrong account when the person's login lives elsewhere.
 *
 * Only that host's variable is read: another host's home cannot fail a run that never starts that host. A home that
 * resolves inside the source worktree is refused instead of passed, because the reviewed head commits that tree and a
 * host reading its startup configuration from there would start under a configuration the review content supplied.
 */
function hostConfigHomes(cwd: string, root: string, host: string): NodeJS.ProcessEnv {
  const key = hostConfigVariable(host);
  if (key === undefined) return {};
  const value = process.env[key];
  if (value === undefined || value === "") return {};
  const path = resolve(cwd, value);
  if (insideWorktree(root, path)) {
    throw new Refusal(`The ${key} directory is inside the source worktree`,
      `point ${key} outside the reviewed worktree, or unset it`);
  }
  return { [key]: path };
}

function reviewerEnv(pathEnv: string, homes: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: pathEnv };
  for (const key of ENV_KEYS) env[key] = process.env[key];
  for (const [key, value] of Object.entries(homes)) env[key] = value;
  // Git run by the reviewer inside the checkout must not run anything the reviewed head committed. A relative
  // core.hooksPath in the source config (Husky's `.husky/_`) resolves against the checkout, so the reviewer's own
  // `git status` refreshes the index and fires a committed post-index-change. Environment config is read after every
  // file git would otherwise consult, and optional locks off means that status does not write the index at all.
  env.GIT_CONFIG_COUNT = "2";
  env.GIT_CONFIG_KEY_0 = "core.hooksPath";
  env.GIT_CONFIG_VALUE_0 = "/dev/null";
  env.GIT_CONFIG_KEY_1 = "core.fsmonitor";
  env.GIT_CONFIG_VALUE_1 = "false";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

function kimiMcpFlag(executable: string, cwd: string, pathEnv: string, homes: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(executable, ["--help"], {
    cwd, env: reviewerEnv(pathEnv, homes), encoding: "utf8", timeout: 2_000,
    maxBuffer: 64 * 1024, killSignal: "SIGKILL",
  });
  if (result.status !== 0) return undefined;
  return /(?:^|[ \t])(--mcp-config(?:-file)?)(?=[ \t=]|$)/m.exec(result.stdout)?.[1];
}

function mcpArgs(host: string, arev: string, out: string, launch: string, kimiFlag?: string): string[] {
  const command = "/bin/sh";
  const args = ["-c", 'CDPATH= cd "$1" && exec "$2" mcp --run "$3"', "sh", launch, arev, out];
  if (host === "codex") {
    // Wait for this run's cold tool catalog before Codex sends its first turn.
    return ["-c", "mcp_servers.arev.required=true", "-c", `mcp_servers.arev.command=${JSON.stringify(command)}`,
      "-c", `mcp_servers.arev.args=${JSON.stringify(args)}`,
      ...RUN_TOOL_NAMES.flatMap(tool => ["-c", `mcp_servers.arev.tools.${tool}.approval_mode="approve"`])];
  }
  const configFlag = host === "kimi" ? kimiFlag : "--mcp-config";
  if (configFlag === undefined) return [];
  const file = join(out, HOST_MCP_FILE);
  writeFileSync(file, JSON.stringify({ mcpServers: { arev: { command, args } } }) + "\n",
    { flag: "wx", mode: 0o600 });
  if (host === "kimi") return [configFlag, file];
  return [configFlag, file, "--strict-mcp-config", "--allowedTools",
    RUN_TOOL_NAMES.map(tool => `mcp__arev__${tool}`).join(",")];
}

function hostArgs(host: string, model: string, checkout: string, launch: string, out: string, prompt: string, mcp: string[]): string[] {
  if (host === "codex") {
    return ["exec", "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "-C", launch, "--add-dir", checkout,
      ...(model === "unknown" ? [] : ["-m", model]), "-o", join(out, RESPONSE_FILE), ...mcp, "-"];
  }
  // Kimi refuses --plan together with the -p this run always passes (`error: Cannot combine --prompt with --plan`), and
  // the OCR flow this replaces ran it without one: the detached worktree and the clean-checkout check are the guard.
  if (host === "kimi") return ["--skills-dir", launch, "--add-dir", checkout, "--add-dir", out, "--output-format", "text", ...mcp, "-p", prompt];
  return ["-p", "--permission-mode", "plan", "--setting-sources", "", "--settings", '{"disableAllHooks":true,"enabledPlugins":{}}', "--add-dir", checkout, "--add-dir", out, ...mcp];
}

function runReviewer(
  executable: string, host: string, args: string[], launch: string, out: string, prompt: string, timeout: number,
  pathEnv: string, homes: NodeJS.ProcessEnv,
) {
  const env = reviewerEnv(pathEnv, homes);
  const stdout = openSync(join(out, STDOUT_FILE), "wx", 0o600);
  let stderr: number;
  try { stderr = openSync(join(out, STDERR_FILE), "wx", 0o600); }
  catch (error) { closeSync(stdout); throw error; }

  return new Promise<{ code: number | null; reason?: string }>((done, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, args, { cwd: launch, env, detached: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) { closeSync(stdout); closeSync(stderr); reject(error); return; }
    let reason: string | undefined;
    let total = 0;
    function stop(why: string) {
      if (reason !== undefined) return;
      reason = why;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }
    }
    const timer = setTimeout(() => stop("the reviewer timed out"), timeout);
    function capture(fd: number, chunk: Buffer) {
      if (reason !== undefined) return;
      try { writeSync(fd, chunk.subarray(0, Math.max(0, MAX_OUTPUT - total))); }
      catch { stop("the reviewer output could not be saved"); }
      total += chunk.length;
      if (total > MAX_OUTPUT) stop("the reviewer output exceeded 4 MiB");
    }
    child.stdout?.on("data", chunk => capture(stdout, chunk));
    child.stderr?.on("data", chunk => capture(stderr, chunk));
    child.on("error", () => stop("the reviewer executable could not be started"));
    child.on("close", code => {
      clearTimeout(timer);
      closeSync(stdout);
      closeSync(stderr);
      done({ code, reason });
    });
    child.stdin?.on("error", () => { /* A host may finish before it consumes stdin. */ });
    child.stdin?.end(host === "kimi" ? undefined : prompt);
  });
}

const OUTPUT_MARKER = "[redacted reviewer output]";
const REVIEWER_FILES = [STDOUT_FILE, STDERR_FILE, RESPONSE_FILE] as const;

function hasSecret(line: string): boolean {
  if (secretShaped(line)) return true;
  const first = line.trimStart()[0];
  if (first === "{" || first === "[" || first === '"') {
    try {
      if ([...stringsIn(JSON.parse(line))].some(secretShaped)) return true;
    } catch { /* A pretty-printed JSON property is not a complete document. */ }
  }
  for (const [literal] of line.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
    try {
      if (secretShaped(JSON.parse(literal))) return true;
    } catch { /* Leave invalid string escapes to the report parser. */ }
  }
  return false;
}

/** What the screen removed, split by whether the file can become the recorded review. */
type Screening = { refused: string[]; warned: string[] };

/** Process complete lines after the pipes close so a split chunk cannot split a secret. */
function screenReviewerFiles(out: string): Screening {
  const screening: Screening = { refused: [], warned: [] };
  for (const name of REVIEWER_FILES) {
    // reviewer.stderr is a diagnostic log that is never recorded, so a redaction or the oversize marker there is named
    // as a warning and the review still records. The two record-bearing files refuse, and so does every file the screen
    // could not read or remove: that content was never screened, which no file's purpose excuses.
    const messages = name === STDERR_FILE ? screening.warned : screening.refused;
    const path = join(out, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) throw new Error("not a regular output file");
      if (stat.size > MAX_OUTPUT) {
        writeFileSync(path, `${OUTPUT_MARKER}\n`);
        messages.push(`${name}: oversized output withheld`);
        continue;
      }
      let count = 0;
      const source = readFileSync(path, "utf8");
      // JSON strings can contain raw Unicode line and paragraph separators.
      const screened = source.replace(/[^\n]+/g, line => {
        if (!hasSecret(line)) return line;
        count++;
        return OUTPUT_MARKER;
      });
      if (count > 0) {
        writeFileSync(path, screened);
        messages.push(`${name}: ${count} redacted line(s)`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // Do not preserve unchecked output if the artifact cannot be opened or overwritten.
      try {
        unlinkSync(path);
        screening.refused.push(`${name}: removed after screening failed`);
      } catch {
        screening.refused.push(`${name}: could not be screened or removed`);
      }
    }
  }
  return screening;
}

function cleanCheckout(checkout: string, head: string, gitFile: string, filters: string[]): boolean {
  try {
    if (readFileSync(join(checkout, ".git"), "utf8") !== gitFile) return false;
    const actual = reviewGit(checkout, ["rev-parse", "--verify", "HEAD"]);
    if (actual.status !== 0 || actual.stdout.trim() !== head) return false;
    const status = reviewGit(checkout, [...filters, "-c", "core.fileMode=true", "status",
      "--porcelain", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]);
    return status.status === 0 && status.stdout === "";
  } catch { return false; }
}

function lastJsonReport(source: string, host: string): unknown {
  // Kimi's text renderer prefixes the first line of an answer with a bullet.
  if (host === "kimi") source = source.replace(/^[ \t]*•[ \t]+(?=```json[ \t]*\r?$)/gim, "");
  const blocks = [...source.matchAll(/^[ \t]*```json[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gim)];
  const value = blocks.at(-1)?.[1];
  if (value === undefined) return undefined;
  try {
    const report: unknown = JSON.parse(value);
    return report && typeof report === "object" && Object.hasOwn(report, "packet") ? report : undefined;
  } catch { return undefined; }
}

export async function runCommand(cwd: string, args: readonly string[]): Promise<number> {
  const options = runOptions(args);
  const root = repositoryRoot(cwd);
  // Resolve relative PATH entries before changing cwd; the checkout cannot change which binary runs.
  const pathEnv = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
    .map(path => resolve(cwd, path)).filter(path => !insideWorktree(root, path)).join(delimiter);
  const executables = new Map<string, string>();
  for (const host of HOST_ORDER) {
    const executable = hostExecutable(host, pathEnv, path => !insideWorktree(root, path));
    if (executable !== undefined) executables.set(host, executable);
  }
  const choice = options.host === undefined
    ? chooseHost(Number(options.pr ?? 0), options.implementer, new Set(executables.keys()), HOST_ORDER)
    : { host: options.host };
  const host = choice.host;
  const executable = host === undefined ? undefined : executables.get(host);
  if (host === undefined || executable === undefined) {
    throw new Refusal("No selected reviewer executable is available", "put claude, codex or kimi on PATH, or select an available --host");
  }
  const homes = hostConfigHomes(cwd, root, host);

  const out = options.out === undefined ? mkdtempSync(join(tmpdir(), "arev-run-output-")) : resolve(cwd, options.out);
  if (insideWorktree(root, out)) {
    throw new Refusal("The reviewer output directory is inside the source worktree", "choose an --out directory outside the worktree");
  }
  try { mkdirSync(out, { recursive: true, mode: 0o700 }); }
  catch { throw new Refusal("Cannot create the reviewer output directory", "choose a writable --out path outside the repository"); }
  const hasOutput = [STDOUT_FILE, STDERR_FILE, RESPONSE_FILE, RUN_REPORT_FILE, RUN_STATE_FILE, HOST_MCP_FILE].some(name => {
    try { lstatSync(join(out, name)); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return false;
    }
  });
  if (hasOutput) {
    throw new Refusal("The output directory already has reviewer output files", "choose a fresh --out directory");
  }

  // The reviewer attaches arev over MCP unless its host offers no config flag to pass one. This is resolved before the
  // bundle is written, because a run that cannot attach MCP refuses here: a retry into the same --out would otherwise
  // trip over the packet files this command had already written. The probe still needs a cwd of its own - a host reads
  // startup configuration from it, and --out belongs to the caller, so a private directory is used and removed at once.
  let kimiFlag: string | undefined;
  if (host === "kimi") {
    const probe = mkdtempSync(join(tmpdir(), "arev-review-probe-"));
    try { kimiFlag = kimiMcpFlag(executable, probe, pathEnv, homes); }
    finally { rmSync(probe, { recursive: true, force: true }); }
  }
  const attachMcp = host !== "kimi" || kimiFlag !== undefined;
  const arev = attachMcp ? hostExecutable("arev", pathEnv, path => !insideWorktree(root, path)) : undefined;
  if (attachMcp && arev === undefined) {
    throw new Refusal("The arev executable is unavailable for reviewer MCP", "put the installed arev command on PATH outside the source worktree");
  }

  const bundle = buildPacket(root, requestFor(root, options.pr));
  const { head } = bundle.packet.subject;
  const model = modelOf(host, process.env.HOME ?? homedir(), homes);
  const run: RunAttestation = {
    packetId: bundle.packet.id, host, model, implementer: options.implementer,
    sameFamilyFallback: host === options.implementer,
  };
  const filters = workspaceFilterOptions(root);
  const settings = packetSettings(root, bundle);
  writePacketBundle(root, bundle, settings, out);

  const temp = mkdtempSync(join(tmpdir(), "arev-review-worktree-"));
  const checkout = join(temp, "checkout");
  const add = reviewGit(root, [...filters, "-c", "submodule.recurse=false", "worktree", "add", "--detach", checkout, head]);
  if (add.status !== 0) {
    if (!existsSync(checkout)) rmSync(temp, { recursive: true, force: true });
    throw new Refusal("Cannot create the detached reviewer worktree", "check Git worktree permissions and retry");
  }

  let screening: Screening = { refused: [], warned: [] };
  const retained = () => {
    // A void review reports everything the screen removed, not only what would have refused the record.
    const removed = [...screening.refused, ...screening.warned];
    return new Refusal(
      `Reviewer worktree ${shown(checkout)} changed or could not be verified, so this review is void${removed.length ? `. ${removed.join(", ")}` : ""}`,
      "inspect the retained checkout and save any changes before removing it");
  };
  let gitFile: string;
  try { gitFile = readFileSync(join(checkout, ".git"), "utf8"); }
  catch { throw retained(); }
  if (!cleanCheckout(checkout, head, gitFile, filters)) throw retained();
  let outcome: Awaited<ReturnType<typeof runReviewer>>;
  try {
    // Keep host and Bun startup outside the reviewed checkout and the caller-owned output directory.
    const launch = join(temp, "launch");
    mkdirSync(launch, { mode: 0o700 });
    if (arev !== undefined) {
      writeFileSync(join(out, RUN_STATE_FILE), JSON.stringify({
        packetId: bundle.packet.id, advisoryCap: settings.advisoryCap,
      }) + "\n", { flag: "wx", mode: 0o600 });
    }
    const prompt = reviewerPrompt(out, checkout, bundle.packet, attachMcp);
    const mcp = arev === undefined ? [] : mcpArgs(host, arev, out, launch, kimiFlag);
    outcome = await runReviewer(executable, host, hostArgs(host, model, checkout, launch, out, prompt, mcp), launch, out, prompt,
      options.timeout, pathEnv, homes);
  } finally {
    try { screening = screenReviewerFiles(out); }
    finally {
      if (!cleanCheckout(checkout, head, gitFile, filters)) throw retained();
      const removed = reviewGit(root, ["worktree", "remove", checkout]);
      if (removed.status !== 0) throw new Refusal("Cannot remove the clean reviewer worktree", `inspect ${shown(checkout)} and run git worktree remove for it`);
      rmSync(temp, { recursive: true, force: true });
    }
  }

  // The warning prints before the refusal check because the stderr redaction happened either way, and it names no
  // part of the redacted line: the kept file already holds the marker in its place.
  for (const warning of screening.warned) console.error(`arev: warning: ${warning} in ${shown(out)}`);
  if (screening.refused.length) {
    throw new Refusal(`Reviewer output was withheld (${screening.refused.join(", ")})`,
      `inspect the redacted output in ${shown(out)} and rerun with a reviewer that does not print sensitive values`);
  }

  const stdout = join(out, STDOUT_FILE);
  const response = join(out, RESPONSE_FILE);
  const staged = join(out, RUN_REPORT_FILE);
  const hasStagedReport = existsSync(staged);
  const file = hasStagedReport ? staged : existsSync(response) ? response : stdout;
  const retry = hasStagedReport
    ? `inspect ${shown(file)} and rerun arev run with a fresh output directory`
    : `inspect ${shown(file)} and use arev record or arev import --from brief with a corrected report`;
  if (outcome.reason !== undefined || outcome.code !== 0) {
    throw new Refusal(outcome.reason ?? "The reviewer exited unsuccessfully", retry);
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_OUTPUT) throw new Refusal("The reviewer report is not a bounded regular file", retry);

  const source = readFileSync(file, "utf8");
  let id: string;
  try {
    const raw = hasStagedReport ? JSON.parse(source) : lastJsonReport(source, host);
    id = raw === undefined
      ? importReviewFile(root, file, "brief", run).id
      : recordReview(root, raw, { label: file, run }).id;
  } catch (error) {
    throw new Refusal(error instanceof Refusal ? error.message : "Cannot read a valid reviewer report", retry);
  }
  console.log(`Recorded review ${id} for head ${head}. Artifacts are in ${shown(out)}.`);
  return EXIT.ok;
}
