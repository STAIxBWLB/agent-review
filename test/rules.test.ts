import { expect, test } from "bun:test";
import { fixture, isolatedPacket } from "./packet-fixture.ts";

test("refuses absolute and traversal rule attributes from the base tree", () => {
  for (const value of ["/private/rules.md", "rules/../REVIEW.md", "C:/private/rules.md"]) {
    const { dir, git, write } = fixture();
    write(".gitattributes", `file.txt arev-review-rules=${value}\n`);
    git("add", ".");
    git("commit", "-qm", "base");
    write("file.txt", "content\n");
    expect(() => isolatedPacket(dir, { kind: "workspace" })).toThrow("repository-relative path");
  }
});

test("reports missing REVIEW.md and does not take an added rule from the head", () => {
  const { dir, git, write } = fixture();
  git("commit", "--allow-empty", "-qm", "base");
  write("REVIEW.md", "HEAD_ONLY\n");
  git("add", "REVIEW.md");
  git("commit", "-qm", "head");
  const packet = isolatedPacket(dir, { kind: "commit", commit: "HEAD" });
  expect(packet.packet.rules).toEqual([]);
  expect(packet.rulesMissing).toEqual([{ source: "REVIEW.md", reason: expect.stringContaining("merge base") }]);
  expect(packet.rules).not.toContain("HEAD_ONLY");
  expect(packet.brief).toContain("Rule unavailable");
});

test("rules and rules check report the applicable primary rule from the base", () => {
  const { git, write, cli } = fixture();
  write(".gitattributes", "file.txt arev-review-rules=primary.md ahub-review-rules=legacy.md\n");
  write("REVIEW.md", "ROOT_BASE\n");
  write("primary.md", "PRIMARY_BASE\n");
  write("legacy.md", "LEGACY_BASE\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  write("REVIEW.md", "ROOT_HEAD\n");
  git("commit", "-qam", "head");
  const rules = cli("rules", "file.txt");
  expect(rules.status).toBe(0);
  expect(rules.stdout).toContain("ROOT_BASE");
  expect(rules.stdout).toContain("PRIMARY_BASE");
  expect(rules.stdout).not.toContain("LEGACY_BASE");
  expect(rules.stdout).not.toContain("ROOT_HEAD");
  const check = cli("rules", "check", "file.txt");
  expect(check.status).toBe(0);
  expect(check.stdout).toContain("primary.md");
  expect(check.stdout).toContain("file.txt");
  expect(check.stdout).toContain("base-tree arev-review-rules attribute");
  expect(check.stdout).not.toContain("PRIMARY_BASE");
});

test("oversized rule display is bounded while its digest represents the entire blob", () => {
  const { dir, git, write } = fixture();
  write("REVIEW.md", "x".repeat(32_000) + "first tail");
  git("add", ".");
  git("commit", "-qm", "base");
  write("file.txt", "reviewable content");
  const first = isolatedPacket(dir, { kind: "workspace" });
  expect(first.rules).toContain("[cut at 32000 bytes]");
  expect(first.rules).not.toContain("first tail");
  write("REVIEW.md", "x".repeat(32_000) + "second tail");
  git("commit", "-qam", "new base");
  const second = isolatedPacket(dir, { kind: "workspace" });
  expect(second.rules).toBe(first.rules);
  expect(second.packet.rules[0]?.sha256).not.toBe(first.packet.rules[0]?.sha256);
});

// Issue #9: a denied path never reaches the rules, so without this line the block reads "(no reviewable paths)" - the
// same words an unknown path gives - and the reader cannot tell a withheld path from one that no rule applies to. The
// line counts the paths instead of echoing them, because a supplied path is the caller's text and this is output.
test("rules names withheld paths by count and never echoes their spelling", () => {
  const { git, write, cli } = fixture();
  write("REVIEW.md", "ROOT_BASE\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  write("src/host.ts", "export const x = 1;\n");
  git("add", ".");
  git("commit", "-qm", "head");

  // One withheld path, in the singular, and its spelling appears nowhere: the block it would have applied to is the
  // empty one, which is the answer rather than a failure, so the exit stays 0.
  const one = cli("rules", ".env");
  expect(one.status).toBe(0);
  expect(one.stdout).toContain("1 supplied path is withheld as denied, so no rule applies to it.");
  expect(one.stdout).toContain("(no reviewable paths)");
  expect(one.stdout).not.toContain(".env");

  const two = cli("rules", ".env", "id_rsa");
  expect(two.status).toBe(0);
  expect(two.stdout).toContain("2 supplied paths are withheld as denied, so no rule applies to them.");

  // A reviewable path beside a withheld one keeps its rules and still reports the denial.
  const mixed = cli("rules", ".env", "src/host.ts");
  expect(mixed.status).toBe(0);
  expect(mixed.stdout).toContain("1 supplied path is withheld as denied");
  expect(mixed.stdout).toContain("src/host.ts");
  expect(mixed.stdout).not.toContain(".env");

  // A denied path spelled differently is denied too - the deny match folds case and width and reads a backslash as a
  // separator - so it gets the same line and reaches neither `Applies to:` nor the output at all. This is the arm worth
  // pinning: the rule reader screens with the case-sensitive isDenied, so without the filter in rulesForPaths these three
  // were echoed under `Applies to:` and took the root rule while the line said they were withheld.
  for (const spelling of [".ENV", ".ＥＮＶ", "docs\\.env"]) {
    const folded = cli("rules", spelling);
    expect(folded.status).toBe(0);
    expect(folded.stdout).toContain("1 supplied path is withheld as denied, so no rule applies to it.");
    expect(folded.stdout).toContain("(no reviewable paths)");
    expect(folded.stdout).not.toContain(spelling);
  }
  const foldedMixed = cli("rules", ".ENV", "src/host.ts");
  expect(foldedMixed.status).toBe(0);
  expect(foldedMixed.stdout).toContain("1 supplied path is withheld as denied");
  expect(foldedMixed.stdout).toContain("src/host.ts");
  expect(foldedMixed.stdout).not.toContain(".ENV");

  // And a query that withheld nothing says nothing about denials.
  const clean = cli("rules", "src/host.ts");
  expect(clean.status).toBe(0);
  expect(clean.stdout).not.toContain("withheld");
  expect(clean.stdout).toContain("src/host.ts");
});

test("rules refuses to use HEAD when the origin default branch is unavailable", () => {
  const { git, write, cli } = fixture();
  write("REVIEW.md", "HEAD_ONLY");
  git("add", ".");
  git("commit", "-qm", "head");
  const result = cli("rules", "file.txt");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("No origin default branch");
  expect(result.stderr).toContain("Fetch origin");
  expect(result.stdout).not.toContain("HEAD_ONLY");
});
