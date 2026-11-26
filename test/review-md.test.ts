import { expect, test } from "bun:test";
import type { RuleText } from "../src/rules.ts";
import { DEFAULT_ADVISORY_CAP, MAX_ADVISORY_CAP, parseReviewMd } from "../src/review-md.ts";

const rules = (...texts: string[]): RuleText[] =>
  texts.map((text, index) => ({ name: index === 0 ? "REVIEW.md" : `rule-${index}.md`, sha256: "e".repeat(64), appliesTo: [], text }));
const review = (text: string) => parseReviewMd(rules(text));

test("a REVIEW.md without a section, or no REVIEW.md at all, gives the spec's defaults", () => {
  expect(parseReviewMd([])).toEqual({ advisoryCap: DEFAULT_ADVISORY_CAP, sameFamily: "deny" });
  expect(review("# Review\nEvery change gets a packet.\n")).toEqual({ advisoryCap: DEFAULT_ADVISORY_CAP, sameFamily: "deny" });
  expect(review("# Review\n[review]\n[gate]\n")).toEqual({ advisoryCap: DEFAULT_ADVISORY_CAP, sameFamily: "deny" });
});

test("[review] advisory_cap and [gate] same_family read inline, blocked and bulleted", () => {
  expect(review('# Review\n\n[review] advisory_cap = 3\n\n[gate] same_family = "allow"\n')).toEqual({ advisoryCap: 3, sameFamily: "allow" });
  expect(review("# Review\n[review]\nadvisory_cap = 2\n[gate]\nsame_family = allow\n")).toEqual({ advisoryCap: 2, sameFamily: "allow" });
  expect(review('- [review] advisory_cap = "0"\n- [gate] same_family = "deny"\n')).toEqual({ advisoryCap: 0, sameFamily: "deny" });
  // A cap of 0 is a real setting: a review may carry no advisory at all.
  expect(review("[review] advisory_cap = 0\n").advisoryCap).toBe(0);
});

test("a blank line or another heading ends a section, so prose is never read as a setting", () => {
  expect(review("[review]\n\nadvisory_cap = 3\n").advisoryCap).toBe(DEFAULT_ADVISORY_CAP);
  expect(review("[review]\nadvisory_cap = 3\n\n[gate] same_family = \"allow\"\n")).toEqual({ advisoryCap: 3, sameFamily: "allow" });
  expect(review("[review]\nadvisory_cap = 3\n[docs]\nother = 1\n").advisoryCap).toBe(3);
  expect(review("[review]\nadvisory_cap = 3\n[see the docs](https://example.test)\nnot a setting\n").advisoryCap).toBe(3);
});

test("a key arev does not read is refused by name, in either section", () => {
  expect(() => review("[review] advisory_capp = 3\n")).toThrow("REVIEW.md sets [review] advisory_capp, which arev does not read");
  expect(() => review("[gate] same_famly = \"allow\"\n")).toThrow("REVIEW.md sets [gate] same_famly, which arev does not read");
  expect(() => review("[review]\nadvisory_cap = 3\ncap = 4\n")).toThrow("sets [review] cap, which arev does not read");
  expect(() => review("[gate] allow\n")).toThrow('is not "key = value"');
  expect(() => review('[gate]\nsame_family = "allow"\nsame_family = "deny"\n')).toThrow("sets [gate] same_family twice");
});

test("a value outside its shape or range is refused by name", () => {
  for (const value of ["many", "-1", "1.5", String(MAX_ADVISORY_CAP + 1)]) {
    expect(() => review(`[review] advisory_cap = "${value}"\n`), value)
      .toThrow(`REVIEW.md sets [review] advisory_cap = "${value}", which is not a whole number in 0-${MAX_ADVISORY_CAP}`);
  }
  expect(review(`[review] advisory_cap = ${MAX_ADVISORY_CAP}\n`).advisoryCap).toBe(MAX_ADVISORY_CAP);
  expect(() => review('[gate] same_family = "allw"\n')).toThrow('REVIEW.md sets [gate] same_family = "allw", which arev does not read');
  // Only the file's own REVIEW.md is read: another rule file carrying a section changes nothing.
  expect(parseReviewMd(rules("# Review\n", "[review] advisory_cap = 3\n"))).toEqual({ advisoryCap: DEFAULT_ADVISORY_CAP, sameFamily: "deny" });
});

test("a refusal withholds a secret-shaped value and cuts a long one before printing it", () => {
  const secret = `ghp_${"a".repeat(36)}`;
  expect(() => review(`[review] advisory_cap = "${secret}"\n`)).toThrow('REVIEW.md sets [review] advisory_cap = "(withheld)"');
  const long = "b".repeat(100);
  expect(() => review(`[gate] same_family = "${long}"\n`)).toThrow(`same_family = "${"b".repeat(64)}..."`);
});
