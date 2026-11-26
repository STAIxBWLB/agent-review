import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { commands } from "../src/commands-table.ts";

const start = "<!-- arev commands:start -->";
const end = "<!-- arev commands:end -->";

export function renderReadme(readme: string): string {
  const before = readme.indexOf(start);
  const after = readme.indexOf(end);
  if (before < 0 || after < before) {
    throw new Error("README.md must contain the arev command section markers in order.");
  }
  const list = commands.map(({ name, description }) =>
    `- \`arev ${name}\`: ${description}`).join("\n");
  return `${readme.slice(0, before)}${start}\n\n${list}\n\n${readme.slice(after)}`;
}

if (import.meta.main) {
  const path = resolve(import.meta.dir, "../README.md");
  const current = readFileSync(path, "utf8");
  const expected = renderReadme(current);
  if (process.argv.includes("--check")) {
    if (current !== expected) {
      console.error("README command list is stale. Run bun scripts/gen-readme.ts.");
      process.exitCode = 1;
    } else {
      console.log("README command list: OK");
    }
  } else {
    writeFileSync(path, expected);
  }
}
