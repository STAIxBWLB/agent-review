import { spawnSync } from "node:child_process";

const rootFiles = new Set(["package.json", "README.md", "LICENSE"]);
const directories = ["bin/", "src/", "skills/"];

export function manifestPaths(raw: string): string[] {
  const manifest = JSON.parse(raw);
  const packs = Array.isArray(manifest) ? manifest
    : manifest !== null && typeof manifest === "object" ? Object.values(manifest) : [];
  const files = Array.isArray(packs) && packs.length === 1 ? packs[0]?.files : undefined;
  if (!Array.isArray(files) || files.length === 0) throw new Error("missing file list");
  return files.map((file: { path?: unknown } | null) => {
    if (typeof file?.path !== "string" || file.path.length === 0) throw new Error("invalid file entry");
    return file.path;
  });
}

if (import.meta.main) {
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--offline", "--ignore-scripts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    timeout: 30_000,
  });
  if (pack.status !== 0) {
    console.error("Cannot inspect the npm package. Check that npm is installed and run npm pack --dry-run --json from the repository root.");
    if (pack.stderr) console.error(pack.stderr.trim());
    process.exit(1);
  }

  let paths: string[];
  try {
    paths = manifestPaths(pack.stdout);
  } catch {
    console.error("npm pack returned an invalid file manifest. Run npm pack --dry-run --json and check its output.");
    process.exit(1);
  }

  const unexpected = paths.filter(path => !rootFiles.has(path) && !directories.some(dir => path.startsWith(dir)));
  for (const path of unexpected) {
    console.error(`Unexpected npm package file ${JSON.stringify(path)}. Remove it from package.json's files list.`);
  }
  if (unexpected.length > 0) process.exit(1);
  console.log(`npm package files: OK (${paths.length} files)`);
}
