"use strict";
// Small filesystem/JSON helpers shared by the recovery backend.
// No third-party dependencies: the recovery console must work even when the
// target profile's node_modules is broken.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function pathExists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function lstatOrUndefined(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return undefined;
  }
}

/** Read and parse JSON, tolerating a UTF-8 BOM. Returns a result object rather than throwing. */
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, error: `无法读取 ${file}: ${error.code ?? String(error)}` };
  }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `${file} 不是合法 JSON: ${error.message}` };
  }
}

/** Write a file through a sibling temp file plus rename, so readers never see a partial file. */
function writeFileAtomic(file, data, options = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  fs.writeFileSync(temp, data, options);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    throw error;
  }
}

/** Match dsh-app-boot's writeProfileManifest: 2-space JSON with a trailing newline. */
function writeJsonAtomic(file, value, mode) {
  writeFileAtomic(file, JSON.stringify(value, undefined, 2) + "\n", mode === undefined ? {} : { mode });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function two(value) {
  return String(value).padStart(2, "0");
}

/** Checkpoint id: local time, sortable and human readable (20261006-143932). */
function timestampId(date = new Date()) {
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}` +
    `-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  );
}

function formatLocalTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? "");
  return (
    `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  );
}

function timestampSuffix(date = new Date()) {
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T` +
    `${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, "0")}`
  );
}

function fileSizeOrZero(target) {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}

/** Recursive byte total; symlinks/junctions are counted as their own entry, never followed. */
function directorySize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) total += fileSizeOrZero(child);
    }
  }
  return total;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

/** Remove a path; for a symlink or junction only the link itself is removed. */
function removeEntry(target) {
  const stat = lstatOrUndefined(target);
  if (stat === undefined) return false;
  if (stat.isSymbolicLink()) {
    // A directory junction / symlink must be unlinked, never recursed into: on
    // Windows `fs.rmSync(link, { force: true })` fails with ERR_FS_EISDIR for a
    // junction, and a recursive delete would walk the link target and destroy
    // the user's working copy (plugins installed with `link:` are exactly this
    // shape). `unlink` removes the reparse point itself.
    try {
      fs.unlinkSync(target);
    } catch (error) {
      // Some Windows builds expose a junction as a directory to lstat; the
      // rmdir below removes the link without touching its contents.
      if (error.code !== "EPERM" && error.code !== "EISDIR") throw error;
      fs.rmdirSync(target);
    }
  } else if (stat.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    fs.rmSync(target, { force: true });
  }
  return true;
}

function uniquePath(base) {
  if (!pathExists(base)) return base;
  for (let ordinal = 1; ordinal < 1000; ordinal += 1) {
    const candidate = `${base}-${ordinal}`;
    if (!pathExists(candidate)) return candidate;
  }
  throw new Error(`无法为 ${base} 找到未占用的名称`);
}

function copyFileIfPresent(source, destination) {
  if (!isFile(source)) return false;
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  return true;
}

function homeDisplay(resolvedHome) {
  return resolvedHome === path.join(os.homedir(), ".dsh") ? "~/.dsh" : "$DSH_HOME";
}

module.exports = {
  copyFileIfPresent,
  directorySize,
  ensureDir,
  fileSizeOrZero,
  formatBytes,
  formatLocalTime,
  homeDisplay,
  isDirectory,
  isFile,
  lstatOrUndefined,
  pathExists,
  readJson,
  removeEntry,
  timestampId,
  timestampSuffix,
  uniquePath,
  writeFileAtomic,
  writeJsonAtomic,
};
