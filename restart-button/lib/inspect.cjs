"use strict";
// Focused asar inspection: root children, the patched entries, and unpacked files.
//
// Usage: node lib/inspect.cjs [--asar=<path>]

const fs = require("node:fs");
const asar = require("./asar.cjs");

const DEFAULT_ASAR = "D:\\Dev Tools\\DeepSeek Harness\\resources\\app.asar";
const archive = (process.argv.find((v) => v.startsWith("--asar=")) ?? `--asar=${DEFAULT_ASAR}`).slice(7);

const fd = fs.openSync(archive, "r");
try {
  const header = asar.readHeader(fd);
  const files = asar.walkFiles(header.json);
  const write = (line) => process.stdout.write(`${line}\n`);

  write(`asar  ${archive}`);
  write(`disk  ${fs.statSync(archive).size}  dataOffset ${header.dataOffset}  headerBuf ${header.headerBufSize}  jsonLen ${header.jsonLen}  entries ${files.length}`);
  write("");
  write("root children:");
  for (const [name, node] of Object.entries(header.json.files)) {
    const kind = node.files === undefined ? `file ${node.size}` : `dir ${asar.walkFiles({ files: node.files }).length}`;
    write(`  ${name}  (${kind}${node.unpacked === true ? ", unpacked" : ""})`);
  }
  write("");
  write("top level files (no node_modules):");
  for (const file of files.filter((f) => !f.path.includes("node_modules"))) {
    write(`  ${String(file.size).padStart(9)}  ${String(file.offset).padStart(10)}  ${file.path}`);
  }
  write("");
  for (const target of ["lib/main.js", "lib/preload-app.cjs"]) {
    try {
      const { entry, start } = asar.readEntry(fd, header, target);
      write(`${target}: size ${entry.size}  offset ${entry.offset}  abs ${start}  sha256 ${asar.sha256(asar.readEntry(fd, header, target).buf)}`);
      write(`  integrity ${JSON.stringify(entry.integrity ?? null)}`);
    } catch (error) {
      write(`${target}: ${error.message}`);
    }
  }
  write("");
  const unpacked = files.filter((f) => f.unpacked);
  write(`unpacked entries (${unpacked.length}):`);
  for (const file of unpacked.slice(0, 30)) write(`  ${String(file.size).padStart(9)}  ${file.path}`);
} finally {
  fs.closeSync(fd);
}
