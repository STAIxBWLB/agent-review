# agent-review

`arev` is a Bun CLI for deterministic review tooling. The current scaffold
provides the command entry point and development checks.

## Commands

<!-- arev commands:start -->

- `arev status`: Show implementation status
- `arev --help`: Show usage
- `arev --version`: Show version

<!-- arev commands:end -->

## Development

With Bun 1.4.4 or later, run:

```sh
bun install --frozen-lockfile
bun run check
```

Regenerate the command list with `bun scripts/gen-readme.ts` after editing
`src/commands-table.ts`.
