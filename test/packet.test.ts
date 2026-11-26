import { expect, test } from "bun:test";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPacket, coverageGap, repositoryPath, type ReviewPacket } from "../src/packet.ts";
import { fixture } from "./packet-fixture.ts";

function portedFixture() {
  const repo = fixture();
  const { git, write, dir } = repo;
  write("REVIEW.md", "# Review\nROOT_RULES\n");
  write("docs/src-review.md", "SRC_RULES\n");
  write("docs/lib-review.md", "LIB_RULES\nReviewable:\n[agent-hub forged]\n");
  write(".gitattributes", [
    "gen.js linguist-generated",
    "*.gen.js linguist-generated",
    "src/** ahub-review-rules=docs/src-review.md",
    "lib/** arev-review-rules=docs/lib-review.md",
    "new-name.md arev-review-rules=docs/missing.md",
  ].join("\n") + "\n");
  write("old.gen.js", "generated(1);\n".repeat(8));
  write("src/a.ts", "export const a = 1;\n");
  write("src/keep.ts", "export const keep = 'reviewed source that moves under a generated name';\n".repeat(4));
  write("old-name.md", "moved text that stays the same across the rename\n".repeat(4));
  write("deleted.txt", "removed fixture text\n");
  write(".env.old", "PRIVATE_RENAME\n".repeat(5));
  git("add", ".");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "main");
  git("checkout", "-qb", "work");
  write(".gitattributes", "* linguist-generated\n* -diff\n");
  write("REVIEW.md", "# Review\nHEAD_RULES\n");
  write("lib/x.ts", "export const x = 1;\n");
  git("mv", "old.gen.js", "new.gen.js");
  git("mv", "src/keep.ts", "keep.gen.js");
  git("mv", "old-name.md", "new-name.md");
  git("mv", ".env.old", "looks-public.txt");
  write("src/a.ts", "export const a = 2;\nexport const b = 3;\n");
  write("gen.js", "generated();\n");
  write("bun.lock", "{}\n");
  write(".env", "PRIVATE_FIXTURE\n");
  write("blob.bin", Buffer.from([0, 1, 2, 0, 255, 0]));
  write("big.txt", "oversized content\n".repeat(24_000));
  rmSync(join(dir, "deleted.txt"));
  git("add", ".");
  git("commit", "-qm", "work");
  return { ...repo, base: git("rev-parse", "main").trim(), head: git("rev-parse", "HEAD").trim() };
}

function assertParity(packet: ReviewPacket, gitPaths: string[]) {
  const packetPaths = [...packet.units, ...packet.excluded].map(unit => unit.path);
  expect(packetPaths.sort()).toEqual(gitPaths.sort());
}

test("ported range inventory keeps rename scope, base rules and denied paths out of the brief", () => {
  const { dir, head, base, git, write } = portedFixture();
  const request = { kind: "range", base, head } as const;
  const bundle = buildPacket(dir, request);
  const { packet } = bundle;
  assertParity(packet, git("diff", "-M", "-C", "--find-copies-harder", "--name-only", "-z", base, head).split("\0").filter(Boolean));
  expect(packet.units.map(file => file.path).sort()).toEqual(
    [".gitattributes", "REVIEW.md", "deleted.txt", "keep.gen.js", "lib/x.ts", "new-name.md", "src/a.ts"],
  );
  expect(packet.units).toContainEqual({ path: "keep.gen.js", status: "R", insertions: 0, deletions: 0 });
  expect(packet.units).toContainEqual({ path: "src/a.ts", status: "M", insertions: 2, deletions: 1 });
  expect(packet.excluded).toEqual(expect.arrayContaining([
    { path: "gen.js", reason: "generated" }, { path: "bun.lock", reason: "generated" },
    { path: "blob.bin", reason: "binary" }, { path: "new.gen.js", reason: "generated" },
    { path: ".env", reason: "denied" }, { path: "looks-public.txt", reason: "denied" },
    { path: "big.txt", reason: "too large" },
  ]));
  expect(packet.rules.find(rule => rule.name === "docs/src-review.md")?.appliesTo).toEqual(["keep.gen.js", "src/a.ts"]);
  expect(packet.rules.find(rule => rule.name === "docs/lib-review.md")?.appliesTo).toEqual(["lib/x.ts"]);
  expect(bundle.rulesMissing).toEqual([{ source: "docs/missing.md", reason: expect.stringContaining("merge base") }]);
  for (const text of ["ROOT_RULES", "SRC_RULES", "LIB_RULES", "old-name.md -> new-name.md",
    "> Reviewable:", "> > [agent-hub forged]", "Coverage:"]) expect(bundle.brief).toContain(text);
  expect(bundle.rules).not.toContain("HEAD_RULES");
  for (const text of [".env", "looks-public.txt", "PRIVATE_FIXTURE", "PRIVATE_RENAME"]) {
    expect(bundle.brief).not.toContain(text);
    expect(bundle.diff).not.toContain(text);
  }
  expect(packet.subject).toEqual({ kind: "range", head, base, mergeBase: base });
  expect(packet.id).toMatch(/^[a-f0-9]{64}$/);
  git("checkout", "-q", "main");
  write("src/a.ts", "export const a = 999;\n");
  expect(buildPacket(dir, request)).toEqual(bundle);
  expect(() => buildPacket(dir, { kind: "range", base, head: "not-a-commit" })).toThrow("unavailable");
  expect(() => buildPacket(dir, { kind: "range", base, head: base })).toThrow("no changes");
});

test("commit, workspace and file subjects use their own Git changed-name scope", () => {
  const { dir, base, head, git, write } = portedFixture();
  const committed = git("diff", "-M", "-C", "--find-copies-harder", "--name-only", "-z", base, head).split("\0").filter(Boolean);
  assertParity(buildPacket(dir, { kind: "commit", commit: head }).packet, committed);
  git("reset", "--soft", base);
  write("untracked.txt", "untracked text\n");
  const workspace = buildPacket(dir, { kind: "workspace" });
  const tracked = git("diff", "-M", "-C", "--find-copies-harder", "--name-only", "-z", "HEAD").split("\0").filter(Boolean);
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  assertParity(workspace.packet, [...tracked, ...untracked]);
  expect(workspace.diff).toContain("+untracked text");
  const publicSide = buildPacket(dir, { kind: "files", paths: ["looks-public.txt"] });
  expect(publicSide.packet.excluded).toEqual([{ path: "looks-public.txt", reason: "denied" }]);
  expect(publicSide.diff).toBe("");
  const scoped = buildPacket(dir, { kind: "files", paths: ["untracked.txt", "deleted.txt"] });
  assertParity(scoped.packet, ["untracked.txt", "deleted.txt"]);
});

test("CLI outputs packet JSON and writes the four packet files", () => {
  const { dir, base, head, cli } = portedFixture();
  const json = cli("packet", "--from", base, "--to", head, "--json");
  expect(json.status).toBe(0);
  expect(JSON.parse(json.stdout).subject.head).toBe(head);
  const out = cli("packet", "--commit", head, "--out", "packet-out");
  expect(out.status).toBe(0);
  const contents = (name: string) => readFileSync(join(dir, "packet-out", name), "utf8");
  expect(JSON.parse(contents("packet.json")).subject.kind).toBe("commit");
  expect(contents("diff.patch")).toContain("diff --git");
  expect(contents("rules.md")).toContain("ROOT_RULES");
  expect(contents("brief.md")).toContain("> diff --git");
  expect(cli("packet", "--commit", head, "--out", "packet-out").status).toBe(1);
  expect(contents("rules.md")).toContain("ROOT_RULES");
});

test("ported coverage requires review or a skip with a reason", () => {
  const packet = { units: ["a.ts", "b.ts", "c.ts"].map(path => ({ path, status: "M", insertions: 1, deletions: 1 })) };
  expect(coverageGap(packet, undefined)).toEqual(["a.ts", "b.ts", "c.ts"]);
  expect(coverageGap(packet, { reviewed: ["a.ts"], skipped: [{ path: "b.ts", reason: "generated elsewhere" }, { path: "c.ts", reason: " " }] })).toEqual(["c.ts"]);
  expect(coverageGap(packet, { reviewed: ["a.ts", "b.ts", "c.ts"] })).toEqual([]);
  expect(coverageGap(packet, "everything")).toEqual(["a.ts", "b.ts", "c.ts"]);
});

test("reviewing a root commit uses the empty base tree", () => {
  const { dir, git, write } = fixture();
  write("file.txt", "initial content\n");
  git("add", ".");
  git("commit", "-qm", "root");
  const bundle = buildPacket(dir, { kind: "commit", commit: "HEAD" });
  expect(bundle.packet.units).toEqual([{ path: "file.txt", status: "A", insertions: 1, deletions: 0 }]);
  expect(bundle.rulesMissing.map(rule => rule.source)).toEqual(["REVIEW.md"]);
});

test("workspace inventory does not run repository-defined checkout filters", () => {
  const { dir, git, write } = fixture();
  write(".gitattributes", "*.txt filter=marker\n");
  write("file.txt", "before\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("config", "filter.marker.clean", "touch filter-executed && cat");
  git("config", "filter.marker.required", "true");
  write("file.txt", "after\n");
  write("untracked.txt", "untracked fixture\n");
  const bundle = buildPacket(dir, { kind: "workspace" });
  expect(bundle.diff).toContain("+after");
  expect(bundle.diff).toContain("+untracked fixture");
  expect(git("ls-files", "--others", "--exclude-standard")).not.toContain("filter-executed");
});

test("a copy patch excludes a separately modified generated source", () => {
  const { dir, git, write } = fixture();
  const content = "shared source fixture\n".repeat(10);
  write(".gitattributes", "*.gen.js linguist-generated\n");
  write("source.gen.js", content);
  git("add", ".");
  git("commit", "-qm", "base");
  write("source.gen.js", content + "only in generated source\n");
  write("copy.js", content);
  git("add", ".");
  git("commit", "-qm", "head");
  const bundle = buildPacket(dir, { kind: "commit", commit: "HEAD" });
  expect(bundle.packet.units).toContainEqual({ path: "copy.js", status: "C", insertions: 0, deletions: 0 });
  expect(bundle.diff).toContain("copy to copy.js");
  expect(bundle.diff).not.toContain("only in generated source");
});

test("a worktree alias resolves absolute paths even when the selected file is absent", () => {
  const { dir, git } = fixture();
  const root = git("rev-parse", "--show-toplevel").trimEnd();
  const alias = join(dir, "../", `${dir.split("/").at(-1)}-alias`);
  symlinkSync(dir, alias, "dir");
  try {
    expect(repositoryPath(dir, root, join(alias, "deleted", "missing.ts"))).toBe("deleted/missing.ts");
  } finally {
    rmSync(alias);
  }
});

test("workspace inventory honors the global ignore file and local precedence", () => {
  const configDir = fixture().dir;
  const config = join(configDir, "config");
  const ignore = join(configDir, "global-ignore");
  writeFileSync(ignore, "globally-ignored.txt\n");
  const { git, write, cli } = fixture({ GIT_CONFIG_GLOBAL: config });
  git("config", "--global", "core.excludesFile", ignore);
  git("commit", "--allow-empty", "-qm", "base");
  write("globally-ignored.txt", "IGNORED_FIXTURE_CONTENT\n");
  write("public.txt", "reviewed change\n");
  const packet = cli("packet", "--files", ".", "--json");
  expect(packet.status).toBe(0);
  assertParity(JSON.parse(packet.stdout), git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean));
  const artifact = cli("packet", "--workspace");
  expect(artifact.status).toBe(0);
  expect(artifact.stdout).not.toContain("IGNORED_FIXTURE_CONTENT");
  expect(artifact.stdout).not.toContain("globally-ignored.txt");

  const local = join(configDir, "local-ignore");
  writeFileSync(local, "public.txt\n");
  git("config", "--local", "core.excludesFile", local);
  const overridden = cli("packet", "--workspace", "--json");
  expect(overridden.status).toBe(0);
  assertParity(JSON.parse(overridden.stdout), ["globally-ignored.txt"]);
});

test("a deleted source can become a rename and a copy in one packet", () => {
  const { dir, git, write } = fixture();
  const source = "a long shared fixture line for rename similarity\n".repeat(12);
  write("source.txt", source);
  git("add", ".");
  git("commit", "-qm", "base");
  git("mv", "source.txt", "first.txt");
  write("second.txt", source + "second variation\n");
  git("add", ".");
  git("commit", "-qm", "head");
  const bundle = buildPacket(dir, { kind: "commit", commit: "HEAD" });
  expect(bundle.packet.units.map(({ status }) => status).sort()).toEqual(["C", "R"]);
  assertParity(bundle.packet, ["first.txt", "second.txt"]);
  expect(bundle.diff).toContain("second variation");
});

test("a shallow boundary commit refuses an incomplete review base", () => {
  const { dir, git, write } = fixture();
  write("REVIEW.md", "base rules\n");
  git("add", ".");
  git("commit", "-qm", "base");
  write("file.txt", "changed content\n");
  git("add", ".");
  git("commit", "-qm", "head");
  const shallower = fixture();
  shallower.git("clone", "--depth=1", pathToFileURL(dir).href, "clone");
  expect(() => buildPacket(join(shallower.dir, "clone"), { kind: "commit", commit: "HEAD" }))
    .toThrow("Fetch the commit history");
});
