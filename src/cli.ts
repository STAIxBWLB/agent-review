import { EXIT, errorLine } from "@staix/cli-output";
import { version } from "../package.json";
import { commands, usage } from "./commands-table.ts";

export function main(args: readonly string[]): number {
  const [first = "--help", ...extra] = args;
  const command = commands.find(({ name, aliases }) =>
    name === first || aliases.some(alias => alias === first));

  if (!command || extra.length > 0) {
    for (const line of errorLine("arev", command ? `${command.name} takes no arguments` : "unknown command", "", {
      tty: Boolean(process.stderr.isTTY),
      next: "arev --help",
    })) console.error(line);
    return EXIT.usage;
  }

  switch (command.name) {
    case "--help":
      console.log(usage());
      break;
    case "--version":
      console.log(version);
      break;
    case "status":
      console.log("Review workflow implementation is pending.");
      break;
  }
  return EXIT.ok;
}
