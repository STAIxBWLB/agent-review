export const commands = [
  { name: "packet", aliases: [], description: "Build a review packet",
    syntax: "packet [--pr N | --from A --to B | --commit C | --workspace | --files P...] [--profile code] [--json | --out DIR]" },
  { name: "rules", aliases: [], description: "Read the rules that apply to paths",
    syntax: "rules [check] <path...>" },
  { name: "status", aliases: [], description: "Show implementation status" },
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
