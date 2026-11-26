import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";

const dependencies = {
  "@staix/agent-mem": "^0.40.0",
  "@staix/cli-output": "0.1.3",
  "@staix/mcp-stdio": "0.1.0",
};
const packages = new Set(["@staix/agent-mem/platform", "@staix/cli-output", "@staix/mcp-stdio"]);
const moduleLoaders = new Set(["createRequire", "Module", "default"]);
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

export function checkBoundary(directory: string): string[] {
  const root = realpathSync(directory);
  const failures: string[] = [];
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const declared = manifest.dependencies ?? {};
  if (Object.keys(declared).length !== Object.keys(dependencies).length ||
      Object.entries(dependencies).some(([name, version]) => declared[name] !== version) ||
      Object.keys(manifest.optionalDependencies ?? {}).length ||
      Object.keys(manifest.peerDependencies ?? {}).length ||
      (manifest.bundleDependencies ?? manifest.bundledDependencies ?? []).length) {
    failures.push("package.json: restore the approved runtime dependency versions and remove extra runtime dependencies.");
  }

  function checkFile(path: string): void {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);

    function checkImport(
      node: ts.Node,
      specifier: ts.Node | undefined,
      typeOnly = false,
      safeModuleBindings = false,
    ): void {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const location = `${relative(root, path)}:${line}`;
      if (!specifier || !ts.isStringLiteralLike(specifier)) {
        failures.push(`${location}: use a literal runtime import specifier.`);
        return;
      }
      const name = specifier.text;
      if (typeOnly && name === "@staix/agent-console/contract") return;
      if ((name === "node:module" || name === "module") && !typeOnly && !safeModuleBindings) {
        failures.push(`${location}: use explicit named imports from node:module without createRequire.`);
        return;
      }
      if (isBuiltin(name) || name.startsWith("bun:") || packages.has(name)) return;
      if (name.startsWith("./") || name.startsWith("../")) {
        try {
          const target = realpathSync(resolve(dirname(path), name));
          const rel = relative(root, target);
          const runtimeFile = extensions.has(extname(target)) &&
            (rel.startsWith("src/") || rel.startsWith("bin/"));
          if ((runtimeFile || rel === "package.json") && lstatSync(target).isFile()) return;
        } catch {
          // Missing targets and targets outside the runtime tree get the same repair hint.
        }
        failures.push(`${location}: invalid relative dependency ${name}. Import an explicit file under src/ or bin/.`);
        return;
      }
      failures.push(`${location}: unapproved dependency ${name}. Use a relative runtime file, a builtin, or an approved package.`);
    }

    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const typeOnly = clause?.isTypeOnly || (clause?.name === undefined && bindings !== undefined &&
          ts.isNamedImports(bindings) && bindings.elements.length > 0 &&
          bindings.elements.every(element => element.isTypeOnly));
        const safeModuleBindings = clause?.name === undefined && bindings !== undefined &&
          ts.isNamedImports(bindings) && bindings.elements.every(element =>
            element.isTypeOnly || !moduleLoaders.has((element.propertyName ?? element.name).text));
        checkImport(node, node.moduleSpecifier, typeOnly, safeModuleBindings);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const exports = node.exportClause;
        const safeModuleBindings = exports !== undefined && ts.isNamedExports(exports) &&
          exports.elements.every(element =>
            element.isTypeOnly || !moduleLoaders.has((element.propertyName ?? element.name).text));
        checkImport(node, node.moduleSpecifier, node.isTypeOnly, safeModuleBindings);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        checkImport(node, node.moduleReference.expression, node.isTypeOnly);
      } else if (ts.isImportTypeNode(node)) {
        checkImport(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true);
      } else if (ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
           (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        checkImport(node, node.arguments[0]);
      }
      if (ts.isIdentifier(node) && node.text === "require" &&
          !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        failures.push(`${relative(root, path)}:${line}: call require directly with a literal or use an import declaration.`);
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }

  function walk(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      failures.push(`${relative(root, path)}: replace the runtime symlink with a regular file or directory.`);
    } else if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) walk(resolve(path, entry));
    } else if (stat.isFile() && extensions.has(extname(path))) {
      checkFile(path);
    }
  }

  walk(resolve(root, "src"));
  walk(resolve(root, "bin"));
  return failures;
}

if (import.meta.main) {
  const failures = checkBoundary(resolve(import.meta.dir, ".."));
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Runtime dependency boundary: OK");
  }
}
