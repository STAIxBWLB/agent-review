## Review report

### Coverage

| Files in diff | Read | Skipped |
|---|---|---|
| 1 | 1 | 0 |

### Findings, most severe first

**P2. Explain how empty rules are handled.** src/rules.ts:2-3.
The prior behavior was unclear to callers. Id: bugs:rule-result-explanation
Origin: introduced. Disposition: fixed.

**P3. Clarify rule precedence.** `src/rules.ts:4`.
This makes the example easier to follow. Id: compliance:brief-rule-precedence

### Scope

Runtime behavior outside the changed file was outside this review.
