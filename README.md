# agent-review

`arev` is a Bun CLI for deterministic review tooling. Build packets from Git changes and inspect the rules that apply to each path.

## Commands

<!-- arev commands:start -->

- `arev packet`: Build a review packet
- `arev rules`: Read the rules that apply to paths
- `arev status`: Show implementation status
- `arev record`: Validate a review report against the packet for its head and append it to the ledger
- `arev resolve`: Settle a recorded finding as fixed, false_positive or accepted
- `arev show`: Show the recorded review for a head
- `arev --help`: Show usage
- `arev --version`: Show version

<!-- arev commands:end -->

Run `arev packet --help` for subject and output options. Packet and rule
commands require Git with support for `--attr-source` and `check-attr --source`.
The standalone `arev rules` command compares against the default branch on `origin`.

## Development

With Bun 1.4.4 or later, run:

```sh
bun install --frozen-lockfile
bun run check
```

Regenerate the command list with `bun scripts/gen-readme.ts` after editing
`src/commands-table.ts`.

## AGENTS.md background

- On 2026-11-26, aligned the dependency rule with AC10's declared range for
  `@staix/agent-mem` and exact pins for the other two runtime packages.
