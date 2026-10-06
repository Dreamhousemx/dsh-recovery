"use strict";
// Finds comment blocks in a bundled JS file, largest first.
//
// The restart button patch must keep lib/main.js byte-for-byte the same size
// (see lib/asar.cjs for why). This helper lists the documentation comments
// available for the padding trade, so the choice stays reviewable.
//
// Usage: node lib/find-slack.cjs <file> [--min=<bytes>] [--after=<line>] [--top=<n>]

const fs = require("node:fs");

const file = process.argv[2];
if (file === undefined) {
  process.stderr.write("用法: node lib/find-slack.cjs <file> [--min=120] [--after=0] [--top=20]\n");
  process.exit(1);
}
const numeric = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit === undefined ? fallback : Number(hit.slice(name.length + 3));
};
const min = numeric("min", 120);
const after = numeric("after", 0);
const top = numeric("top", 20);

const text = fs.readFileSync(file, "utf8");
const lines = text.split(/\r?\n/);
const starts = [];
const lineStart = [0];
for (let index = 0; index < text.length; index += 1) {
  if (text[index] === "\n") lineStart.push(index + 1);
}
const lineOf = (offset) => {
  let low = 0;
  let high = lineStart.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStart[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
};

const blocks = [];
for (const match of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
  const bytes = Buffer.byteLength(match[0], "utf8");
  const line = lineOf(match.index) + 1;
  if (bytes >= min && line >= after) blocks.push({ bytes, line, text: match[0] });
}

process.stdout.write(`${file}: ${lines.length} 行, ${fs.statSync(file).size} 字节；符合条件 ${blocks.length} 块\n`);
for (const block of blocks.sort((left, right) => right.bytes - left.bytes).slice(0, top)) {
  const first = block.text.split(/\r?\n/)[0].slice(0, 70);
  process.stdout.write(`${String(block.bytes).padStart(6)} 行 ${String(block.line).padStart(6)}  ${block.text.split(/\r?\n/).length} 行  ${first}\n`);
}
