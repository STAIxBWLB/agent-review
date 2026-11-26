import { expect, test } from "bun:test";
import { manifestPaths } from "../scripts/check-pack.ts";

const files = [{ path: "package.json" }, { path: "bin/arev.js" }];
const pack = { name: "@staix/agent-review", files };

test("reads npm 11 and npm 12 package manifests", () => {
  const paths = ["package.json", "bin/arev.js"];
  expect(manifestPaths(JSON.stringify([pack]))).toEqual(paths);
  expect(manifestPaths(JSON.stringify({ [pack.name]: pack }))).toEqual(paths);
});

test("rejects a missing, ambiguous, or malformed package file list", () => {
  for (const manifest of [{}, [pack, pack], { a: pack, b: pack }, { a: { files: [{ path: 1 }] } }]) {
    expect(() => manifestPaths(JSON.stringify(manifest))).toThrow();
  }
});
