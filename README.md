# agent-review

`arev` is a Bun CLI for deterministic review tooling. Build packets from Git changes and inspect the rules that apply to each path.

## Install

Bun 1.4.4 or newer is required. Install the published CLI with

```sh
bun add -g @staix/agent-review
```

## Commands

<!-- arev commands:start -->

- `arev host`: Choose the reviewer host for a pull request and the model it will use
- `arev packet`: Build a review packet
- `arev rules`: Read the rules that apply to paths
- `arev import`: Import a legacy review report
- `arev export`: Export a recorded review
- `arev run`: Run a read-only reviewer and record its report
- `arev status`: Show implementation status
- `arev record`: Validate a review report against the packet for its head and append it to the ledger
- `arev resolve`: Settle a recorded finding as fixed, false_positive or accepted
- `arev show`: Show the recorded review for a head
- `arev gate`: Answer whether this exact head is reviewed, and post the status with --post
- `arev mcp`: Serve the review tools over MCP on stdio
- `arev setup`: Register arev mcp with a coding host and install the review skill
- `arev --help`: Show usage
- `arev --version`: Show version

<!-- arev commands:end -->

Run `arev packet --help` for subject and output options. Code packets and
Git-backed rule selection require Git with support for `--attr-source` and
`check-attr --source`.
`arev packet --pr N` reads the pull request from the repository `origin` names
on `github.com`, never from the repository `gh` resolves for itself (`GH_REPO`,
the working directory), and refuses an origin that names no GitHub repository.
The standalone `arev rules` command compares against the default branch on `origin`.
A path the deny list withholds from review contributes no rule: the supplied
spelling is matched the way the packet matches it, so a folded or backslashed
spelling counts too, and the output counts it as `withheld as denied` instead of
echoing it.

`arev packet --pr N --out DIR` includes a framed `contract.md` with the PR title,
body, and referenced issue bodies. A reviewer can read this file without
GitHub access. For a local subject, use `--contract FILE` to embed a local brief.
Contract-bearing `--json` and MCP results return the packet and its framed
`contract` text together. Plain CLI output includes the contract below the brief.

For a manuscript or a rubric review, build a file-set packet:

```sh
arev packet --profile paper --files manuscript.md --evidence evidence.json --contract checklist.md --out paper-review
arev packet --profile rubric --files candidate-a.md candidate-b.md --contract rubric.json --out rubric-review
```

Paper takes one manuscript with optional JSON evidence and a checklist. Rubric
takes one or more text artifacts and a v1 JSON rubric with 1-20 criteria. Each
criterion has `id`, `description`, a `scale` of `binary` or `ordinal-1-5`, and
an optional boolean `blocking`. Select inputs within the Git worktree or, for
a standalone review, within the current directory.

These packets bind each included input's SHA-256 and carry the current commit
as context when available. The report copies the packet ID and file-set head
from `packet.json`. For rubric reports, also supply `rubricSha256` from
`packet.rubric.sha256` and `rubricScores` with one `{id, score}` per criterion.
Binary scores are booleans and ordinal scores are integers from 1 through 5.

### `arev gate`

The gate answers for the current full head and the base it would merge into now:
the merge base with `origin`'s default branch.

`arev gate --post` writes one commit status, `arev/gate`, on the head, and only
after a pass. It is the only GitHub write `arev` makes. Both the status and the
pull-request read before it pin `github.com` and the repository `origin` names,
never the host or repository `gh` resolves for itself, and the read takes every
page. The status is refused when the head belongs to more than one review
thread in the ledger or to an open pull request the gate was not asked about: a
commit status is per commit, so it would show as a pass on every other pull
request at that head, including one opened after the status was posted. For the
pull request the review names, the gate also re-reads that pull request's base,
and the rule it applies is that the pull request's current merge base must equal
the reviewed one. Both gh calls give up after 15 seconds, and a refusal that
reaches that bound names it and the retry, with the same `--head` and `--pr` the
run gated.

GitHub lists open pull requests for this endpoint only while the commit is
outside the default branch, so a head already on `main` has no open pull
request for a status to leak onto.

### `arev host`

Choose the reviewer for a pull request, and the model it will run.

The rotation starts at the pull request number over `claude, codex, kimi`, and
the implementer is skipped. A host whose CLI is not on `PATH`, or one named to
`--unavailable`, is skipped too. The implementer is chosen only when it is the
last one left, as `same-family fallback`, so a review never runs on the AI that
wrote the change unless nothing else can run.

`--unavailable` and `--hosts` are list flags: give the flag once per id
(`--unavailable kimi --unavailable claude`) or comma-separate the ids
(`--unavailable kimi,claude`). A bare second id is a positional and is refused,
so the flag itself has to repeat.

The model is the `model` key of `~/.codex/config.toml`, the `default_model` key
of `~/.kimi-code/config.toml`, and `unknown` for every other host. Only that
key's value reaches the answer. A value that is not a plain name reads as
`unknown` as well, and so does a config TOML itself does not accept; the command
reads no repository and writes no ledger.

`--json` prints `host`, `model`, `reason`, `considered` and, when no host can
run, `next` with the same instruction the lines carry. When no host can run it
exits nonzero either way.

## Import and export

Build a packet for the reviewed head before importing a report. Supply the
review's full `head` and `base` commit IDs, reviewer ID and model family,
`call.ok`, and reviewed or skipped paths. Coverage totals alone are insufficient.
Supply `packet_id` from the reviewed packet if more than one PR shares its
head and base.

- `arev import --from ocr report.json` accepts OCR comment entries or findings
  with `category`, `severity`, `path`, and optional `start_line` and `end_line`.
  OCR reports may use `head_commit`, `base_commit`, and a `files` coverage list.
- `arev import --from brief report.json` accepts P0–P3 findings in JSON. For a
  Markdown brief, prepend a fenced JSON block with the review metadata and list
  findings under a `Findings` heading as `P2. Title` or `P2: Title` entries.
- A JSON brief can wrap original `hub_review` arguments under the
  `hub_review` key. `arev export --to hub` reproduces those arguments and
  reflects subsequent finding resolutions.
- `arev export --to markdown` prints the recorded review and finding lifecycle.

## Setup receipts

`arev setup <host> --apply` stores its undo receipt under
`$AGENTHUB_HOME/setup/` (default `~/.agenthub/setup/`). The receipt is scoped
to the host configuration path. Run `arev setup <host> --undo` in the same
configuration to revert what setup installed.

## Running a review

Run `arev run --pr N --implementer ID` to select a reviewer, export the packet
and contract, and review a detached worktree. The reviewer and its scoped MCP
server start outside that worktree, and the reviewer gets its path for reading.
Without `--pr`,
the run reviews HEAD against the origin default branch and starts the
automatic host rotation at the first host. Pass `--host ID` to select an
installed reviewer explicitly.

Supported reviewers submit one validated report over the scoped MCP stdio
channel. The runner records the staged report after it verifies the checkout.
Codex waits for the run-scoped server and pre-approves only its four review
tools. Its global approval policy and read-only sandbox still apply. A
server startup failure stops the Codex run.

Claude starts in plan mode with user plugins and hooks disabled and the
scoped MCP config supplied explicitly. A Kimi CLI without an MCP config flag
reads the bundle files directly. If a reviewer finishes without staging a
report, the prompt gives an exact JSON example with string paths in
`coverage.reviewed`. The runner also accepts the opening-fence bullet that
Kimi's text renderer may add.

To verify the MCP channel with an installed and authenticated Codex CLI, run
`arev run --host codex --implementer <id> --out <fresh-dir>` on a reviewable
branch. A successful run with `report.json` in the output directory confirms
that the report was staged over MCP. A successful run without that file used
the output fallback.

The default timeout is 30 minutes. Use `--out DIR` outside the source
worktree to choose where packet files and reviewer output are saved. A dirty
reviewer checkout is retained for inspection and its review is void.
Use `arev gate` to check the recorded result.

## Release

The [Release workflow](.github/workflows/release.yml) publishes tags through
npm trusted publishing. An npm maintainer configures GitHub Actions for the
public `@staix/agent-review` package in the package settings on npmjs.com.
Set the owner to `STAIxBWLB`, repository to `agent-review`, workflow filename
to `release.yml`, and allow `npm publish`. Validate a new connection by
publishing within two days. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

- From the verified release commit on `main`, create and push the tag that
  matches `package.json`. For 0.1.1, run
  `git tag -a v0.1.1 -m "v0.1.1"` and `git push origin v0.1.1`.
- Confirm the **Release** workflow succeeded and check the published version
  with `npm view @staix/agent-review@0.1.1 version`. The workflow checks
  ancestry, version, tests and package contents before publishing via OIDC.

Release notes for
[v0.1.1](https://github.com/STAIxBWLB/agent-review/blob/main/docs/releases/v0.1.1.md)
and [v0.1.0](https://github.com/STAIxBWLB/agent-review/blob/main/docs/releases/v0.1.0.md).

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

- On 2026-11-26, documented the V2 decision to launch an installed reviewer
  CLI for read-only review without passing provider credentials.
