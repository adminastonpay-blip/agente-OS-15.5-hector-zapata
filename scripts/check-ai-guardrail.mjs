import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("src");
const allowed = path.resolve("src/core/model-runner.ts");
const violations = [];
const binding = "(?:env|this\\s*\\.\\s*env)\\s*(?:\\?\\.|\\.)\\s*AI";
const directCall = new RegExp("\\b" + binding + "\\s*(?:\\?\\.|\\.)\\s*run\\s*\\(", "g");
const aliasDeclaration = new RegExp(
  "\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*" + binding + "\\b",
  "g",
);
const destructuredDeclaration =
  /\b(?:const|let|var)\s*\{\s*AI(?:\s*:\s*(\w+))?\s*\}\s*=\s*(?:env|this\s*\.\s*env)\b/g;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(file);
      continue;
    }
    if (!/\.(?:[cm]?[jt]sx?)$/i.test(entry.name)) continue;
    if (path.resolve(file) === allowed) continue;

    const source = await readFile(file, "utf8");
    const relative = path.relative(process.cwd(), file);
    for (const match of source.matchAll(directCall)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(relative + ":" + line + ": direct AI binding execution");
    }

    const aliases = new Set();
    for (const match of source.matchAll(aliasDeclaration)) aliases.add(match[1]);
    for (const match of source.matchAll(destructuredDeclaration)) aliases.add(match[1] || "AI");

    for (const name of aliases) {
      const call = new RegExp("\\b" + name + "\\s*(?:\\?\\.|\\.)\\s*run\\s*\\(", "g");
      for (const match of source.matchAll(call)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(relative + ":" + line + ": aliased AI binding execution (" + name + ")");
      }
    }
  }
}

await walk(root);
if (violations.length) {
  console.error("AI Control Gate guardrail failed:");
  for (const violation of violations) console.error(" - " + violation);
  process.exitCode = 1;
} else {
  console.log("AI Control Gate guardrail passed: no direct Workers AI execution outside ModelRunner.");
}
