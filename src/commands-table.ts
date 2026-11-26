export const commands = [
  { name: "status", aliases: [], description: "Show implementation status" },
  { name: "--help", aliases: ["-h"], description: "Show usage" },
  { name: "--version", aliases: ["-v"], description: "Show version" },
] as const;

export function usage(): string {
  const labels = commands.map(({ name, aliases }) => [name, ...aliases].join(", "));
  const width = Math.max(...labels.map(label => label.length));
  const lines = commands.map(({ description }, index) =>
    `  ${labels[index]?.padEnd(width)}  ${description}`);
  return ["Usage: arev [command]", "", ...lines].join("\n");
}
