import { EXIT, errorLine } from "@staix/cli-output";
import { version } from "../package.json";
import { commandUsage, commands, usage } from "./commands-table.ts";
import { PacketUsageError, runPacket, runRules } from "./packet-cli.ts";

export function main(args: readonly string[]): number {
  const [first = "--help", ...extra] = args;
  const command = commands.find(({ name, aliases }) =>
    name === first || aliases.some(alias => alias === first));

  if (command && "syntax" in command) {
    if (extra.length === 1 && ["-h", "--help"].includes(extra[0]!)) {
      console.log(commandUsage(command));
      return EXIT.ok;
    }
    try {
      const run = command.name === "packet" ? runPacket : runRules;
      run(process.cwd(), extra);
      return EXIT.ok;
    } catch (error) {
      for (const line of errorLine("arev", error instanceof Error ? error.message : "Command failed.", "", {
        tty: Boolean(process.stderr.isTTY),
        next: `arev ${command.name} --help`,
      })) console.error(line);
      return error instanceof PacketUsageError ? EXIT.usage : EXIT.fail;
    }
  }

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
      console.log("Packet and rules commands are available.");
      break;
  }
  return EXIT.ok;
}
