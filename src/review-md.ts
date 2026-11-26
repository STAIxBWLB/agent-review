/**
 * REVIEW.md's settings sections, read from the whole rule blob at the packet's merge base (spec #1, Decisions
 * 2026-11-26): `[review] advisory_cap = N` and `[gate] same_family = allow|deny`. One parser for both sections, so
 * `arev packet` and `arev gate` read one spelling of the file and neither can drift from the other. `RuleText.text` is
 * the whole blob, not the 32,000-byte display text, so a section at the end of a long REVIEW.md is still read.
 *
 * A key arev does not read is refused by name rather than ignored, and so is a value outside its shape or range: a typo
 * would otherwise leave a guard off, or a cap unbounded, with nothing saying so. `REVIEW.md` is content under review,
 * so a refusal withholds a secret-shaped value instead of echoing it.
 */
import { Refusal, secretShaped } from "./ledger.ts";
import type { RuleText } from "./rules.ts";

/** The spec's default cap, and the largest one a report can honour: one report carries at most 64 findings. */
export const DEFAULT_ADVISORY_CAP = 5;
export const MAX_ADVISORY_CAP = 64;

export interface ReviewMdSettings {
  advisoryCap: number;
  sameFamily: "allow" | "deny";
}

type Section = "review" | "gate";

const HEADING = /^\[([A-Za-z_][A-Za-z0-9_-]*)\]\s*(.*)$/;
const SETTING = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|(\S+))\s*$/;
const KEYS: Record<Section, { accepts: readonly string[]; example: string }> = {
  review: { accepts: ["advisory_cap"], example: "advisory_cap = 3" },
  gate: { accepts: ["same_family"], example: 'same_family = "allow"' },
};

/** A value echoed back at most 64 bytes of, and never when it looks like a secret. */
const shown = (value: string): string =>
  secretShaped(value) ? "(withheld)" : value.length > 64 ? `${value.slice(0, 64)}...` : value;

/**
 * Both sections of the base-tree `REVIEW.md`, with the spec's defaults for whatever it does not set. A line is either a
 * heading carrying its setting inline (`[gate] same_family = "allow"`, the shape the spec names) or a heading that opens
 * a block of `key = value` lines; an optional Markdown bullet is accepted so it reads in this file's own style, and a
 * blank line, another heading or other bracketed prose closes the block so the rest of the file is never read as one.
 */
export function parseReviewMd(rules: readonly RuleText[]): ReviewMdSettings {
  const settings = new Map<string, string>();
  let open: Section | undefined;

  const record = (section: Section, line: string, where: string) => {
    if (!line) return;
    const match = SETTING.exec(line);
    if (!match) {
      throw new Refusal(`${where} in the [${section}] section of REVIEW.md is not "key = value"`,
        `write it as [${section}] ${KEYS[section].example}`);
    }
    const key = match[1]!, value = match[2] ?? match[3]!;
    if (!KEYS[section].accepts.includes(key)) {
      throw new Refusal(`REVIEW.md sets [${section}] ${shown(key)}, which arev does not read`,
        `REVIEW.md [${section}] accepts only ${KEYS[section].accepts.join(", ")}`);
    }
    if (settings.has(`${section}.${key}`)) {
      throw new Refusal(`REVIEW.md sets [${section}] ${key} twice`, `keep one ${key} setting in the [${section}] section`);
    }
    settings.set(`${section}.${key}`, value);
  };

  for (const raw of rules.find(rule => rule.name === "REVIEW.md")?.text.split("\n") ?? []) {
    const line = raw.trim().replace(/^-\s+/, "");
    if (!line) {
      open = undefined;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const name = heading[1]!.toLowerCase();
      open = name === "review" || name === "gate" ? name : undefined;
      if (open) record(open, heading[2]!.trim(), "the heading");
      continue;
    }
    if (line.startsWith("[")) {
      open = undefined;
      continue;
    }
    if (open) record(open, line, `a [${open}] line`);
  }

  const cap = settings.get("review.advisory_cap"), family = settings.get("gate.same_family");
  return {
    advisoryCap: cap === undefined ? DEFAULT_ADVISORY_CAP : capValue(cap),
    sameFamily: family === undefined ? "deny" : familyValue(family),
  };
}

function capValue(raw: string): number {
  if (!/^[0-9]+$/.test(raw) || Number(raw) > MAX_ADVISORY_CAP) {
    throw new Refusal(`REVIEW.md sets [review] advisory_cap = "${shown(raw)}", which is not a whole number in 0-${MAX_ADVISORY_CAP}`,
      `set advisory_cap to a number in 0-${MAX_ADVISORY_CAP}, or omit it for the default ${DEFAULT_ADVISORY_CAP}`);
  }
  return Number(raw);
}

function familyValue(raw: string): "allow" | "deny" {
  if (raw !== "allow" && raw !== "deny") {
    throw new Refusal(`REVIEW.md sets [gate] same_family = "${shown(raw)}", which arev does not read`,
      'set it to "allow" to permit a same-family fallback review, or "deny" to refuse one');
  }
  return raw;
}
