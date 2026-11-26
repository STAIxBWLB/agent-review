import { memoryGitEnv, memoryGitSync } from "@staix/agent-mem/platform";

const gitArgs = (cwd: string, args: string[]) =>
  ["-C", cwd, "-c", "protocol.allow=never", "--literal-pathspecs", ...args];

const gitOptions = () => ({
  env: memoryGitEnv(process.env, { repositoryIsolation: true, readOnlyDiagnostic: true }),
  maxBuffer: 16 * 1024 * 1024,
  timeout: 15_000,
});

export function reviewGit(cwd: string, args: string[], options: {
  input?: string;
  maxBuffer?: number;
} = {}) {
  return memoryGitSync(gitArgs(cwd, args), { ...gitOptions(), encoding: "utf8", ...options });
}

export function reviewBlob(cwd: string, object: string) {
  return memoryGitSync(gitArgs(cwd, ["cat-file", "blob", object]), { ...gitOptions(), encoding: "buffer" });
}

export function repositoryRoot(cwd: string): string {
  const result = reviewGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0) throw new Error("No Git worktree found. Run arev from a repository.");
  return result.stdout.replace(/\r?\n$/, "");
}

export function commitOid(cwd: string, ref: string): string {
  const result = reviewGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (result.status !== 0) throw new Error("A specified commit is unavailable. Fetch the required refs or use a local commit.");
  return result.stdout.trim();
}

export function mergeBaseOid(cwd: string, base: string, head: string): string {
  const result = reviewGit(cwd, ["merge-base", base, head]);
  if (result.status !== 0) throw new Error("No merge base found. Fetch the missing history and retry.");
  return result.stdout.trim();
}

/** Preserve the user's global ignore file without importing global config into review Git commands. */
export function globalIgnoreOptions(cwd: string): string[] {
  const local = reviewGit(cwd, ["config", "--get", "core.excludesFile"]);
  if (local.status === 0) return [];
  if (local.status !== 1) throw new Error("Cannot read the repository's Git ignore setting. Check git config and retry.");
  const options = gitOptions();
  const result = memoryGitSync(gitArgs(cwd, ["config", "--global", "--type=path", "--null", "--get", "core.excludesFile"]), {
    ...options,
    env: { ...options.env, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL },
    encoding: "utf8",
  });
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error("Cannot read the global Git ignore setting. Check git config --global and retry.");
  return ["-c", `core.excludesFile=${result.stdout.replace(/\0$/, "")}`];
}
