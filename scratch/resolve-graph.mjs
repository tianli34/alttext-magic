/**
 * 静态遍历 ESM 导入图，找出无法被 Node 解析的相对导入。无副作用（只读文件，不执行模块）。
 * 用法: node scratch/resolve-graph.mjs <入口文件>
 */
import fs from "node:fs";
import path from "node:path";

const entry = path.resolve(process.argv[2]);
const seen = new Set();
const broken = [];

const SPEC_RE = /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;

function specifiers(code) {
  const out = [];
  let m;
  while ((m = SPEC_RE.exec(code)) !== null) out.push(m[1] || m[2] || m[3]);
  return out;
}

function walk(file, from) {
  if (seen.has(file)) return;
  seen.add(file);
  let code;
  try {
    code = fs.readFileSync(file, "utf8");
  } catch {
    broken.push({ file, from });
    return;
  }
  for (const spec of specifiers(code)) {
    if (!spec.startsWith(".")) continue; // 只关心相对导入
    walk(path.resolve(path.dirname(file), spec), file);
  }
}

walk(entry, "<entry>");

console.log(`遍历模块数: ${seen.size}`);
console.log(`无法解析的相对导入: ${broken.length}`);
for (const b of broken.slice(0, 15)) {
  console.log(`  缺失 ${path.relative(process.cwd(), b.file)}`);
  console.log(`    ← 被 ${path.relative(process.cwd(), b.from)} 引用`);
}
