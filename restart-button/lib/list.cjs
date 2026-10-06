"use strict";
// Lists asar entries (path, size, unpacked) for inspection.
//
// Usage: node lib/list.cjs [--asar=<path>] [--filter=<substring>] [--top=<n>]

const fs = require("node:fs");
const path = require("node:path");
const asar = require("./asar.cjs");

const DEFAULT_ASAR = "D:\\Dev Tools\\DeepSeek Harness\\resources\\app.asar";

function argument(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const archivePath = argument("asar", DEFAULT_ASAR);
const filter = argument("filter", "");
const top = Number(argument("top", "40"));

const fd = fs.openSync(archivePath, "r");
let files;
try {
  const header = asar.readHeader(fd);
  files = asar.walkFiles(header.json);
} finally {
  fs.closeSync(fd);
}

const matching = filter === "" ? files : files.filter((file) => file.path.includes(filter));
const unpacked = files.filter((file) => file.unpacked);
let total = 0;
for (const file of files) total += file.size;

process.stdout.write(`asar: ${archivePath}\n`);
process.stdout.write(`size: ${fs.statSync(archivePath).size}  entries: ${files.length}  data: ${total}  unpacked: ${unpacked.length}\n`);
process.stdout.write(`\n-- unpacked --\n`);
for (const file of unpacked) process.stdout.write(`${String(file.size).padStart(10)}  ${file.path}\n`);
process.stdout.write(`\n-- largest 20 --\n`);
for (const file of [...files].sort((left, right) => right.size - left.size).slice(0, 20)) {
  process.stdout.write(`${String(file.size).padStart(10)}  ${file.path}\n`);
}
process.stdout.write(`\n-- matching "${filter}" (${matching.length}) --\n`);
for (const file of matching.slice(0, top)) {
  process.stdout.write(`${String(file.size).padStart(10)}  ${String(file.offset).padStart(10)}  ${file.path}\n`);
}
