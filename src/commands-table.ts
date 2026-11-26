export const commands = [
  { name: "packet", aliases: [], description: "Build a review packet",
    syntax: "packet [--pr N | --from A --to B | --commit C | --workspace | --files P...] [--profile code] [--json | --out DIR]" },
  { name: "rules", aliases: [], description: "Read the rules that apply to paths",
    syntax: "rules [check] <path...>" },
  { name: "import", aliases: [], description: "Import a legacy review report",
    syntax: "import --from ocr|brief <file>" },
  { name: "export", aliases: [], description: "Export a recorded review",
    syntax: "export --to hub|markdown [--head SHA] [--pr N|none]" },
  { name: "status", aliases: [], description: "Show implementation status" },
  { name: "record", aliases: [], description: "Validate a review report against the packet for its head and append it to the ledger",
    syntax: "record <report.json> [--implementer NAME] [--light] [--json]" },
  { name: "resolve", aliases: [], description: "Settle a recorded finding as fixed, false_positive or accepted",
    syntax: "resolve <finding-id> --as fixed|false_positive|accepted [--evidence REF]... [--rationale TEXT] [--head SHA] [--pr N|none] [--json]" },
  { name: "show", aliases: [], description: "Show the recorded review for a head",
    syntax: "show [--head SHA] [--pr N|none] [--json]" },
  { name: "gate", aliases: [], description: "Answer whether this exact head is reviewed, and post the status with --post",
    syntax: "gate [--head SHA] [--pr N|none] [--post] [--json]" },
  { name: "mcp", aliases: [], description: "Serve the review tools over MCP on stdio", syntax: "mcp" },
  { name: "setup", aliases: [], description: "Register arev mcp with a coding host and install the review skill",
    syntax: "setup <host> [--apply | --undo]" },
  { name: "--help", aliases: ["-h"], description: "Show usage" },
  { name: "--version", aliases: ["-v"], description: "Show version" },
] as const;

export type Command = typeof commands[number];

export function commandUsage(command: Command): string {
  return "syntax" in command ? `Usage: arev ${command.syntax}` : `Usage: arev ${command.name}`;
}

export function usage(): string {
  const labels = commands.map(({ name, aliases }) => [name, ...aliases].join(", "));
  const width = Math.max(...labels.map(label => label.length));
  const lines = commands.map(({ description }, index) =>
    `  ${labels[index]?.padEnd(width)}  ${description}`);
  return ["Usage: arev [command]", "", ...lines].join("\n");
}
