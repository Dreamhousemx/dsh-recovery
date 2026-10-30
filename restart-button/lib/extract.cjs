"use strict";
// dsh-recovery / restart-button : extract the unpatched lib entries from app.asar.
//
// DeepSeek Harness updates replace resources/app.asar wholesale, so the payload
// must be rebuilt from the new bytes. This writes lib/main.js and
// lib/preload-app.cjs out as the new baseline for lib/build-payload.cjs.
//
//   node lib\extract.cjs [outDir] [--archive <app.asar>]
//
// Default outDir: <workspace>\.dsh-src\lib  (the path build-payload.cjs reads).

// Inside the recovery console Electron's fs treats any `*.asar` path as a
// virtual directory; every access below is a raw read of the archive file.
process.noAsar = true;

const fs = require("node:fs");
const path = require("node:path");
const asar = require("./asar.cjs");

const ROOT = path.resolve(__dirname, "..");
const WORKSPACE = path.resolve(ROOT, "..", "..");
const ENTRIES = ["lib/main.js", "lib/preload-app.cjs"];

function parseArgs(argv) {
  const args = { outDir: path.join(WORKSPACE, ".dsh-src", "lib"), archive: "D:/Dev Tools/DeepSeek Harness/resources/app.asar" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--archive" || flag === "--asar") {
      args.archive = argv[i + 1];
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else if (!flag.startsWith("-")) {
      args.outDir = path.resolve(flag);
    } else {
      throw new Error(`无法识别的参数：${flag}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`dsh-recovery / restart-button : extract

  node lib/extract.cjs [输出目录] [--archive <app.asar>]

默认输出  ${path.join(WORKSPACE, ".dsh-src", "lib")}
默认 asar  D:/Dev Tools/DeepSeek Harness/resources/app.asar

写出的是**未打补丁**的 lib/main.js 与 lib/preload-app.cjs，
即 build-payload.cjs 读取的基线。`);
    return 0;
  }
  const fd = fs.openSync(args.archive, "r");
  try {
    const header = asar.readHeader(fd);
    const size = fs.statSync(args.archive).size;
    console.log(`asar      ${args.archive}`);
    console.log(`整包大小  ${size} 字节，dataOffset ${header.dataOffset}`);
    console.log(`输出目录  ${args.outDir}`);
    console.log("");
    fs.mkdirSync(args.outDir, { recursive: true });
    for (const entryPath of ENTRIES) {
      const { buf, entry } = asar.readEntry(fd, header, entryPath);
      const file = path.join(args.outDir, path.basename(entryPath));
      fs.writeFileSync(file, buf);
      console.log(`${entryPath}  ${entry.size} 字节  offset ${Number(entry.offset)}  sha256 ${asar.sha256(buf)}`);
      console.log(`  已写出 ${file}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[X] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
