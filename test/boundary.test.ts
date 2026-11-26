import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBoundary } from "../scripts/check-boundary.ts";
import manifest from "../package.json";

function fixture(source: string, bootstrap = "", dependencies = manifest.dependencies): string[] {
  const root = mkdtempSync(join(tmpdir(), "arev-boundary-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies }));
    writeFileSync(join(root, "src", "cli.ts"), source);
    writeFileSync(join(root, "bin", "arev.js"), bootstrap);
    writeFileSync(join(root, "outside.js"), "");
    return checkBoundary(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts approved dependencies and the type-only anchor contract", () => {
  expect(fixture(`
    import "node:fs";
    import "bun:sqlite";
    import "@staix/agent-mem/platform";
    export * from "@staix/cli-output";
    import("@staix/mcp-stdio");
    import type { ReviewAnchor } from "@staix/agent-console/contract";
  `, 'import "../src/cli.ts";')).toEqual([]);
});

test("rejects runtime dependencies in source and the bootstrap", () => {
  const errors = fixture(`
    import "third-party";
    export * from "@staix/agent-mem";
    require("@staix/agent-console/contract");
    import(packageName);
    import "../outside.js";
  `, 'import "bootstrap-package";');
  expect(errors).toHaveLength(6);
  for (const name of ["third-party", "@staix/agent-mem", "@staix/agent-console/contract",
    "literal runtime import", "../outside.js", "bootstrap-package"]) {
    expect(errors.some(error => error.includes(name))).toBe(true);
  }
});

test("rejects a loosened pin and an extra manifest dependency", () => {
  expect(fixture("", "", { ...manifest.dependencies, "@staix/cli-output": "^0.1.3" })).toHaveLength(1);
  const extra = { ...manifest.dependencies, thirdParty: "1.0.0" };
  expect(fixture("", "", extra)).toHaveLength(1);
});

test("permits named node:module helpers and rejects indirect runtime loaders", () => {
  expect(fixture('import { isBuiltin as known } from "node:module";')).toEqual([]);
  const errors = fixture(`
    import { createRequire as load } from "node:module";
    import * as moduleNamespace from "module";
    export { createRequire as loadModule } from "node:module";
    const dynamic = import("node:module");
    const alias = require;
  `);
  expect(errors).toHaveLength(5);
  expect(errors.slice(0, 4).every(error => error.includes("without createRequire"))).toBe(true);
  expect(errors[4]).toContain("call require directly");
});
