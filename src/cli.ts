import { EXIT, errorLine } from "@staix/cli-output";
import { version } from "../package.json";
import { commandUsage, commands, usage } from "./commands-table.ts";
import { PacketUsageError, runPacket, runRules } from "./packet-cli.ts";
import { recordCommand, resolveCommand, showCommand } from "./record.ts";

type Runner = (cwd: string, args: readonly string[]) => number | void;
const RUN = {
  packet: runPacket,
  rules: runRules,
  record: recordCommand,
  resolve: resolveCommand,
  show: showCommand,
} as const satisfies Record<string, Runner>;
const dispatchable = (name: string): name is keyof typeof RUN => Object.hasOwn(RUN, name);

export function main(args: readonly string[]): number {
  const [first = "--help", ...extra] = args;
  const command = commands.find(({ name, aliases }) =>
    name === first || aliases.some(alias => alias === first));

  if (command && dispatchable(command.name)) {
    if (extra.length === 1 && ["-h", "--help"].includes(extra[0]!)) {
      console.log(commandUsage(command));
      return EXIT.ok;
    }
    try {
      const code = RUN[command.name](process.cwd(), extra);
      return typeof code === "number" ? code : EXIT.ok;
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
