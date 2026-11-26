import { expect, test } from "bun:test";
import { buildPacket } from "../src/packet.ts";
import { fixture } from "./packet-fixture.ts";

test("refuses absolute and traversal rule attributes from the base tree", () => {
  for (const value of ["/private/rules.md", "rules/../REVIEW.md", "C:/private/rules.md"]) {
    const { dir, git, write } = fixture();
    write(".gitattributes", `file.txt arev-review-rules=${value}\n`);
    git("add", ".");
    git("commit", "-qm", "base");
    write("file.txt", "content\n");
    expect(() => buildPacket(dir, { kind: "workspace" })).toThrow("repository-relative path");
  }
});

test("reports missing REVIEW.md and does not take an added rule from the head", () => {
  const { dir, git, write } = fixture();
  git("commit", "--allow-empty", "-qm", "base");
  write("REVIEW.md", "HEAD_ONLY\n");
  git("add", "REVIEW.md");
  git("commit", "-qm", "head");
  const packet = buildPacket(dir, { kind: "commit", commit: "HEAD" });
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
  const first = buildPacket(dir, { kind: "workspace" });
  expect(first.rules).toContain("[cut at 32000 bytes]");
  expect(first.rules).not.toContain("first tail");
  write("REVIEW.md", "x".repeat(32_000) + "second tail");
  git("commit", "-qam", "new base");
  const second = buildPacket(dir, { kind: "workspace" });
  expect(second.rules).toBe(first.rules);
  expect(second.packet.rules[0]?.sha256).not.toBe(first.packet.rules[0]?.sha256);
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
