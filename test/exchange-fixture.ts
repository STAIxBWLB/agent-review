import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fixture } from "./packet-fixture.ts";

type Format = "ocr" | "brief" | "hub";

export function exchangeFixture(review = "Review fixture\n") {
  const repo = fixture();
  const { write, git, cli } = repo;
  write("REVIEW.md", review);
  write("src/rules.ts", "old rule\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  write("src/rules.ts", "rule 1\nrule 2\nrule 3\nrule 4\n");
  git("commit", "-qam", "head");
  const head = git("rev-parse", "HEAD").trim();
  const packet = cli("packet", "--from", base, "--to", head, "--json");
  expect(packet.status).toBe(0);
  const packetId: string = JSON.parse(packet.stdout).id;
  function load(format: Format): Record<string, unknown> {
    const json = readFileSync(new URL(`./fixtures/exchange/${format}.json`, import.meta.url), "utf8");
    // The checked-in example is sanitized; the local test repository supplies the exact subject.
    const subject = format === "ocr" ? { head_commit: head, base_commit: base } : { head, base };
    return { ...JSON.parse(json), ...subject, packet_id: packetId };
  }
  function ingest(format: Format, report = load(format)) {
    write("report.json", JSON.stringify(report));
    return cli("import", "--from", format === "hub" ? "brief" : format, "report.json");
  }
  return { ...repo, head, base, load, ingest };
}
