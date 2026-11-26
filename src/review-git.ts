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
