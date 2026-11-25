# Review

- Compare the complete diff with the phase spec (V1 is #1) and its acceptance criteria; name each AC the PR claims and the test that proves it.
- Important: a packet whose reviewable plus excluded paths differ from git's changed-name list for the same subject, or an excluded path without a reason.
- Important: rules read from the head instead of the merge base, or an attribute value that is absolute or contains `..` accepted.
- Important: `arev gate` passing without a valid record for the current full head and base, with an unjudged blocking finding, with an unflagged same-family or implementer review, or with a failed call; or giving different answers for the same ledger and git state.
- Important: a commit status posted for a head the gate did not pass, or any other GitHub write.
- Important: reviewed content reaching a packet's text without `src/frame.ts`, a deny-listed path's content in a packet, or a secret value in the ledger or output.
- Important: a ledger line rewritten or removed, `accepted` settable from MCP, or a ported behaviour changed in the porting PR.
- Important: a runtime import outside the boundary in `AGENTS.md`, a model call, or a provider key setting.
- Error messages: a new or changed error a person or agent sees names the cause and the next step (the command, setting or file that fixes it).
- Check that tests stay offline, use a temporary `AGENTHUB_HOME`, and that each claimed AC has a test.
- Do not report: formatting, naming preferences, `ponytail:` simplifications that state their ceiling, generated `bun.lock`. At most five nits.
