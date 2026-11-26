import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { isDenied } from "@staix/agent-mem/platform";
import { frame } from "./frame.ts";
import { reviewBlob, reviewGit } from "./review-git.ts";

const RULE_BYTES = 32_000;
const MAX_RULE_FILES = 8;
const attributes = ["linguist-generated", "arev-review-rules", "ahub-review-rules"] as const;
type RuleAttribute = typeof attributes[number];
export interface RuleMissing { source: string; reason: string }
export interface RuleText { name: string; sha256: string; appliesTo: string[]; text: string }
export interface RuleSet {
  rules: RuleText[];
  missing: RuleMissing[];
  via: Map<string, Set<RuleAttribute>>;
}
export interface RuleTarget { path: string; sides: readonly string[] }

export function readAttributes(cwd: string, mergeBase: string, paths: readonly string[]) {
  const result = new Map<string, Partial<Record<RuleAttribute, string>>>();
  const readable = [...new Set(paths)].filter(path => !isDenied(path));
  if (!readable.length) return result;

  const read = reviewGit(cwd, ["check-attr", "-z", "--stdin", `--source=${mergeBase}`, ...attributes], {
    input: readable.join("\0") + "\0",
  });
  if (read.status !== 0) {
    throw new Error("Cannot read base-tree Git attributes. Use Git with check-attr --source support and verify the base tree.");
  }
  const fields = read.stdout.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, attribute, value] = [fields[i]!, fields[i + 1]! as RuleAttribute, fields[i + 2]!];
    const entry = result.get(path) ?? {};
    entry[attribute] = value;
    result.set(path, entry);
  }
  return result;
}

export function readRules(
  cwd: string,
  mergeBase: string,
  targets: readonly RuleTarget[],
  attrs = readAttributes(cwd, mergeBase, targets.flatMap(target => [...target.sides])),
): RuleSet {
  const loaded = new Map<string, RuleText>();
  const missed = new Map<string, RuleMissing>();
  const via = new Map<string, Set<RuleAttribute>>();

  function read(name: string): RuleText | undefined {
    if (loaded.has(name) || missed.has(name)) return loaded.get(name);
    if (loaded.size >= MAX_RULE_FILES) {
      missed.set(name, { source: name, reason: `over the limit of ${MAX_RULE_FILES} rule files` });
      return;
    }
    const object = `${mergeBase}:${name}`;
    const type = reviewGit(cwd, ["cat-file", "-t", object]);
    if (type.status !== 0 || type.stdout.trim() !== "blob") {
      missed.set(name, { source: name, reason: "not found as a file at the merge base" });
      return;
    }
    const content = reviewBlob(cwd, object);
    if (content.status !== 0) {
      missed.set(name, { source: name, reason: "cannot read the rule at the merge base" });
      return;
    }
    const bytes = content.stdout;
    const text = bytes.length > RULE_BYTES
      ? `${bytes.subarray(0, RULE_BYTES).toString("utf8")}\n[cut at ${RULE_BYTES} bytes]`
      : bytes.toString("utf8");
    const rule = { name, sha256: createHash("sha256").update(bytes).digest("hex"), appliesTo: [], text };
    loaded.set(name, rule);
    return rule;
  }

  const root = read("REVIEW.md");
  for (const { path, sides } of targets) {
    if (sides.some(side => isDenied(side))) continue;
    const names = new Set<string>();
    for (const side of sides) {
      const entry = attrs.get(side);
      const attribute = entry?.["arev-review-rules"] === undefined || entry["arev-review-rules"] === "unspecified"
        ? "ahub-review-rules" : "arev-review-rules";
      const name = entry?.[attribute];
      if (!name || ["unspecified", "unset", "set"].includes(name)) continue;
      if (posix.isAbsolute(name) || win32.isAbsolute(name) || /^[a-z]:/i.test(name) ||
          name.split(/[\\/]/).includes("..")) {
        throw new Error("Invalid base-tree review-rule attribute. Set it to a repository-relative path without '..'.");
      }
      const normalized = posix.normalize(name);
      if (isDenied(normalized) || normalized === "REVIEW.md") continue;
      names.add(normalized);
      const sources = via.get(normalized) ?? new Set<RuleAttribute>();
      sources.add(attribute);
      via.set(normalized, sources);
    }
    root?.appliesTo.push(path);
    for (const name of names) read(name)?.appliesTo.push(path);
  }
  return { rules: [...loaded.values()], missing: [...missed.values()], via };
}

export function renderRules({ rules, missing, via }: RuleSet, includeText = true): string {
  return [
    ...rules.map(rule => [
      "Rule from merge base:",
      frame(rule.name),
      "Applies to:",
      frame(rule.appliesTo.join("\n") || "(no reviewable paths)"),
      ...(includeText ? [frame(rule.text.trimEnd())] : [
        rule.name === "REVIEW.md" ? "Source: repository-wide REVIEW.md." :
          `Source: base-tree ${[...(via.get(rule.name) ?? [])].join(" or ")} attribute.`,
      ]),
    ].join("\n")),
    ...missing.map(rule => `Rule unavailable (${rule.reason}):\n${frame(rule.source)}`),
  ].join("\n\n");
}
