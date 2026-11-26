import { memoryGitEnv, memoryGitSync } from "@staix/agent-mem/platform";

const gitArgs = (cwd: string, args: string[], literalPathspecs = true) =>
  ["-C", cwd, "-c", "protocol.allow=never", "-c", "core.attributesFile=/dev/null", ...(literalPathspecs ? ["--literal-pathspecs"] : []), ...args];

const gitOptions = () => ({
  env: {
    ...memoryGitEnv(process.env, { repositoryIsolation: true, readOnlyDiagnostic: true }),
    LC_ALL: "C",
    GIT_ATTR_NOSYSTEM: "1",
  },
  maxBuffer: 16 * 1024 * 1024,
  timeout: 15_000,
});

export function reviewGit(cwd: string, args: string[], options: {
  input?: string;
  maxBuffer?: number;
  indexFile?: string;
  literalPathspecs?: boolean;
} = {}) {
  const { indexFile, literalPathspecs, ...limits } = options;
  const defaults = gitOptions();
  return memoryGitSync(gitArgs(cwd, args, literalPathspecs), {
    ...defaults, encoding: "utf8", ...limits,
    ...(indexFile === undefined ? {} : { env: { ...defaults.env, GIT_INDEX_FILE: indexFile } }),
  });
}

export function reviewBlob(cwd: string, object: string) {
  return memoryGitSync(gitArgs(cwd, ["cat-file", "blob", object]), { ...gitOptions(), encoding: "buffer" });
}

export function repositoryRoot(cwd: string): string {
  const result = reviewGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0 && /dubious ownership/i.test(result.stderr)) {
    throw new Error("Git refused the worktree because its owner differs from the current user. Run arev as the worktree owner; review Git calls isolate global trust settings.");
  }
  if (result.status !== 0) throw new Error("No Git worktree found. Run arev from a repository.");
  return result.stdout.replace(/\r?\n$/, "");
}

export function commitOid(cwd: string, ref: string): string {
  const result = reviewGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (ref === "HEAD" && result.status !== 0 && reviewGit(cwd, ["symbolic-ref", "-q", "HEAD"]).status === 0) {
    throw new Error("The current branch has no commits yet. Create an initial commit and retry.");
  }
  if (result.status !== 0) throw new Error("A specified commit is unavailable. Fetch the required refs or use a local commit.");
  return result.stdout.trim();
}

export function mergeBaseOid(cwd: string, base: string, head: string): string {
  const result = reviewGit(cwd, ["merge-base", base, head]);
  if (result.status !== 0) throw new Error("No merge base found. Fetch the missing history and retry.");
  return result.stdout.trim();
}

/** Resolve only the effective ignore file, without loading user config for the review commands. */
export function globalIgnoreOptions(cwd: string): string[] {
  const options = gitOptions();
  const result = memoryGitSync(gitArgs(cwd, ["config", "--includes", "--type=path", "--null", "--get", "core.excludesFile"]), {
    ...options,
    env: {
      ...options.env,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    },
    encoding: "utf8",
  });
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error("Cannot read the effective Git ignore setting. Check git config --includes and retry.");
  return ["-c", `core.excludesFile=${result.stdout.replace(/\0$/, "")}`];
}
