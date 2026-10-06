"use strict";
// Prepares `.runtime/` — a private Electron runtime directory that loads
// `./app` as its application through `resources/app`, without touching the
// installed `resources/app.asar` or the DSH profile.
//
// Why a private runtime instead of the installed shell: a packaged Electron
// binary resolves its application from its own `resources/` directory, so the
// console cannot be hosted by the installed executable without replacing the
// installed application. Hard-linking the Electron runtime files (same volume,
// no extra disk space) and pointing `resources/app` at this project keeps the
// installed application byte-for-byte untouched.
//
// The step is idempotent and never deletes recursively: linked files are
// re-linked in place and the `resources/app` directory junction is removed with
// rmdir, which unlinks only the junction itself.
//
// Usage:
//   node setup-runtime.js [--target=<install dir>] [--list] [--quiet]

const fs = require("node:fs");
const path = require("node:path");

const paths = require("./app/backend/paths");
const { ensureDir, isDirectory, pathExists } = require("./app/backend/util");

const PROJECT_ROOT = __dirname;
const APP_DIR = path.join(PROJECT_ROOT, "app");
const RUNTIME_DIR = path.join(PROJECT_ROOT, ".runtime");
const RESOURCES_DIR = path.join(RUNTIME_DIR, "resources");
const APP_LINK = path.join(RESOURCES_DIR, "app");
const RUNTIME_EXE = path.join(RUNTIME_DIR, "dsh-recovery.exe");
const MARKER_FILE = path.join(RUNTIME_DIR, "runtime.json");

// Top-level directories that are never part of the Electron runtime. `locales`
// is handled separately below (only its .pak files are linked).
const SKIP_ENTRIES = new Set(["resources"]);

function log(message) {
  if (!process.argv.includes("--quiet")) process.stdout.write(`${message}\n`);
}

function parseArgs(argv) {
  const target = argv.find((argument) => argument.startsWith("--target="));
  return {
    target: target === undefined ? undefined : target.slice("--target=".length),
    list: argv.includes("--list"),
    quiet: argv.includes("--quiet"),
  };
}

function stripExtendedPrefix(value) {
  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

/** Hard-links (or copies, across volumes) one file, replacing a stale target. */
function linkFile(source, destination) {
  const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (!existing.isFile()) throw new Error(`运行时目标被占用且不是文件: ${destination}`);
    fs.unlinkSync(destination);
  }
  try {
    fs.linkSync(source, destination);
    return "hardlink";
  } catch {
    fs.copyFileSync(source, destination);
    return "copy";
  }
}

/** Creates (or repairs) resources/app -> <project>/app as a directory junction. */
function ensureAppLink() {
  ensureDir(RESOURCES_DIR);
  const existing = fs.lstatSync(APP_LINK, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`${APP_LINK} 已存在且不是目录联接。请先手动删除它，再运行本脚本。`);
    }
    const current = path.resolve(stripExtendedPrefix(fs.readlinkSync(APP_LINK)));
    if (current.toLowerCase() === path.resolve(APP_DIR).toLowerCase()) return "kept";
    // rmdir removes the reparse point only — never the link target.
    fs.rmdirSync(APP_LINK);
  }
  fs.symlinkSync(APP_DIR, APP_LINK, "junction");
  return "created";
}

function resolveTarget(explicit) {
  if (typeof explicit === "string" && explicit !== "") {
    const info = paths.inspectInstall(path.resolve(explicit));
    if (info.exe === undefined) throw new Error(`${explicit} 不是可识别的 Electron 安装目录（找不到应用可执行文件）。`);
    return info;
  }
  const targets = paths.detectTargets();
  if (targets.length === 0) {
    throw new Error("没有找到 DeepSeek Harness 或 DSH Desktop 安装目录。请用 --target=<安装目录> 指定。");
  }
  const preferred = targets.find((entry) => entry.kind === "deepseek-harness") ?? targets[0];
  return preferred;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    for (const target of paths.detectTargets()) {
      process.stdout.write(`${target.kind}\t${target.label}\tv${target.appVersion ?? "?"}\telectron ${target.electronVersion ?? "?"}\t${target.dir}\n`);
    }
    return 0;
  }

  const target = resolveTarget(args.target);
  if (!isDirectory(APP_DIR) || !pathExists(path.join(APP_DIR, "package.json"))) {
    throw new Error(`恢复器应用目录不完整: ${APP_DIR}`);
  }
  if (target.exe === undefined) throw new Error("安装目录中找不到应用可执行文件。");

  log(`目标安装: ${target.label}（${target.dir}）`);
  log(`Electron: ${target.electronVersion ?? "未知"}`);

  ensureDir(RUNTIME_DIR);
  ensureDir(RESOURCES_DIR);

  let files = 0;
  let copies = 0;
  for (const entry of fs.readdirSync(target.dir, { withFileTypes: true })) {
    const lower = entry.name.toLowerCase();
    if (SKIP_ENTRIES.has(lower)) continue;
    const source = path.join(target.dir, entry.name);
    if (entry.isDirectory()) {
      // Only the locale packs matter; every other directory belongs to the
      // installed application, not to the Electron runtime.
      if (lower !== "locales") continue;
      const localeDir = path.join(RUNTIME_DIR, entry.name);
      ensureDir(localeDir);
      for (const locale of fs.readdirSync(source)) {
        if (!locale.toLowerCase().endsWith(".pak")) continue;
        const kind = linkFile(path.join(source, locale), path.join(localeDir, locale));
        files += 1;
        if (kind === "copy") copies += 1;
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (lower.endsWith(".exe")) continue; // linked explicitly below
    if (lower.endsWith(".log")) continue;
    const kind = linkFile(source, path.join(RUNTIME_DIR, entry.name));
    files += 1;
    if (kind === "copy") copies += 1;
  }

  const exeKind = linkFile(target.exe, RUNTIME_EXE);
  if (exeKind === "copy") copies += 1;
  const linkKind = ensureAppLink();

  fs.writeFileSync(
    MARKER_FILE,
    `${JSON.stringify(
      {
        source: target.dir,
        sourceExe: target.exe,
        sourceLabel: target.label,
        sourceAppVersion: target.appVersion,
        electronVersion: target.electronVersion,
        executable: RUNTIME_EXE,
        app: APP_DIR,
        linkedAt: new Date().toISOString(),
      },
      undefined,
      2,
    )}\n`,
    "utf8",
  );

  log(`已链接 ${files + 1} 个运行时文件（${copies} 个因跨卷改为复制）`);
  log(`resources/app 目录联接: ${linkKind}`);
  log(`可执行文件: ${RUNTIME_EXE}`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`[错误] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
