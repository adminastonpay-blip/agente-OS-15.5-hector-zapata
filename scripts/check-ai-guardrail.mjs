import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("src");
const allowed = path.resolve("src/core/model-runner.ts");
const violations = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\\.(?:[cm]?[jt]sx?)$/i.test(entry.name)) {
      const absolute = path.resolve(file);
      if (absolute === allowed) continue;
      const source = await readFile(file, "utf8");
      const direct = /\\b(?:env|this\\s*\\.\\s*env)\\s*\\?\\.\\s*AI\\s*\\?\\.\\s*run\\s*\\(/g;
      for (const match of source.matchAll(direct)) {
        const line = source.slice(0, match.index).split("\\n").length;
        violations.push(`${path.relative(process.cwd(), file)}:${line}: direct AI binding execution`);
      }
      const alias = /\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:env|this\\s*\\.\\s*env)\\s*\\.\\s*AI\\b/g;
      for (const match of source.matchAll(alias)) {
        const name = match[1];
        const tail = source.slice(match.index + match[0].length);
        const call = new RegExp(`\\\\b${name}\\\\s*\\\\.\\\\s*run\\\\s*\\\\(`);
        const found = call.exec(tail);
        if (found) {
          const line = source.slice(0, match.index + match[0].length + found.index).split("\\n").length;
          violations.push(`${path.relative(process.cwd(), file)}:${line}: aliased AI binding execution`);
        }
      }
    }
  }
}

await walk(root);
if (violations.length) {
  console.error("AI Control Gate guardrail failed:");
  for (const violation of violations) console.error(` - ${violation}`);
  process.exitCode = 1;
} else {
  console.log("AI Control Gate guardrail passed: no direct Workers AI execution outside ModelRunner.");
}
