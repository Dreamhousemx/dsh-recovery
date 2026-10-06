"use strict";
// Diagnostics bundle: a self-contained ZIP describing the console's view of
// the Harness home, the selected application, every profile, and recent logs.
//
// The bundle is written locally and never uploaded, mirroring the desktop
// shell's diagnostics tab. It contains local paths and log text, and the
// README inside says so.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ensureDir, formatBytes, isDirectory } = require("./util");
const { PROJECT_ROOT, userDataDirs } = require("./paths");
const { createZip } = require("./zip");

const LOG_TAIL_BYTES = 128 * 1024;
const MAX_LOG_FILES = 5;
const MAX_INLINE_FILE_BYTES = 4 * 1024 * 1024;

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._@+-]/gu, "_");
}

function readTextIfSmall(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_INLINE_FILE_BYTES) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function tailFile(file) {
  let handle;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return undefined;
    const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    handle = fs.openSync(file, "r");
    fs.readSync(handle, buffer, 0, length, start);
    const prefix = start > 0 ? `…[已截断，仅保留最后 ${formatBytes(length)}]\n` : "";
    return prefix + buffer.toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function collectLogs(extraDirs = []) {
  const files = [];
  const dirs = [...userDataDirs().map((dir) => path.join(dir, "logs")), ...extraDirs];
  for (const dir of dirs) {
    if (!isDirectory(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {}
      files.push({ file, mtime });
    }
  }
  files.sort((left, right) => right.mtime - left.mtime);
  return files.slice(0, MAX_LOG_FILES);
}

function buildEntries(context) {
  const { homeInfo, home, profiles, checkpoints, targets, selected, running, safeModeHomes, consoleVersion } = context;
  const entries = [];
  const createdAt = new Date().toISOString();

  entries.push({
    name: "README.txt",
    data: [
      "DSH Recovery 诊断包",
      `生成时间: ${createdAt}`,
      "",
      "本文件包由 DSH 恢复器（dsh-recovery）在本地生成，不会自动上传。",
      "",
      "包含内容：",
      "  environment.json        运行环境与版本",
      "  summary.json            Harness home、Profile 与所选应用的概览",
      "  profiles/<名称>/…        该 Profile 的清单、补丁与插件清单（只读快照）",
      "  checkpoints.json        检查点列表",
      "  processes.json          当前运行中的目标应用进程",
      "  logs/…                  最近的应用日志尾部（可能被截断）",
      "",
      "注意：诊断包可能包含本地路径、日志文本与插件配置片段。",
      "分享给他人前请先自行检查其中的敏感信息。",
      "",
      "本包不包含 node_modules，也不包含任何会话内容或凭据。",
    ].join("\r\n"),
  });

  entries.push({
    name: "environment.json",
    data: JSON.stringify(
      {
        createdAt,
        console: { name: "dsh-recovery", version: consoleVersion, root: PROJECT_ROOT },
        platform: { platform: process.platform, arch: process.arch, release: os.release(), type: os.type(), hostname: os.hostname(), cpus: os.cpus().length },
        versions: process.versions,
        totalMemoryBytes: os.totalmem(),
        home: { path: home, source: homeInfo.source, envValue: homeInfo.envValue || undefined, defaultPath: homeInfo.defaultPath },
        userDataDirs: userDataDirs(),
        safeModeHomes,
      },
      undefined,
      2,
    ),
  });

  entries.push({
    name: "summary.json",
    data: JSON.stringify(
      {
        createdAt,
        home,
        selected: selected === undefined ? undefined : { id: selected.id, kind: selected.kind, label: selected.label, exe: selected.exe, dir: selected.dir, appVersion: selected.appVersion, electronVersion: selected.electronVersion },
        targets: (targets ?? []).map((target) => ({ id: target.id, kind: target.kind, label: target.label, exe: target.exe, dir: target.dir, appVersion: target.appVersion })),
        profiles: profiles.map((profile) => ({
          name: profile.name,
          dir: profile.dir,
          manifestValid: profile.manifestValid,
          manifestError: profile.manifestError,
          bundles: profile.bundles,
          patchExists: profile.patchExists,
          patchDisabledCount: profile.patchDisabledCount,
          pluginCount: profile.plugins.length,
          quarantineCount: profile.removed.length,
          hasLock: profile.hasLock,
        })),
        checkpointCount: checkpoints.length,
        running,
      },
      undefined,
      2,
    ),
  });

  for (const profile of profiles) {
    const segment = safeSegment(profile.name);
    for (const [file, label] of [
      [profile.manifestPath, "manifest.json"],
      [profile.patchPath, "cordis.patch.yml"],
      [path.join(profile.dir, "cordis.yml"), "cordis.yml"],
    ]) {
      const text = readTextIfSmall(file);
      if (text !== undefined) entries.push({ name: `profiles/${segment}/${label}`, data: text });
    }
    entries.push({ name: `profiles/${segment}/plugins.json`, data: JSON.stringify(profile.plugins, undefined, 2) });
    entries.push({ name: `profiles/${segment}/removed.json`, data: JSON.stringify(profile.removed, undefined, 2) });
    entries.push({ name: `profiles/${segment}/patch-entries.json`, data: JSON.stringify(profile.patchEntries, undefined, 2) });
  }

  entries.push({ name: "checkpoints.json", data: JSON.stringify(checkpoints, undefined, 2) });
  entries.push({ name: "processes.json", data: JSON.stringify(running, undefined, 2) });

  const warnings = [];
  for (const log of collectLogs()) {
    const text = tailFile(log.file);
    if (text === undefined) continue;
    entries.push({ name: `logs/${safeSegment(path.basename(log.file))}`, data: text });
    if (text.length >= LOG_TAIL_BYTES) warnings.push(`${path.basename(log.file)} 仅保留了尾部内容`);
  }

  return { entries, warnings, createdAt };
}

/** Suggested file name, matching the desktop shell's diagnostics naming. */
function diagnosticsFileName(date = new Date()) {
  return `diagnostics-${date.getTime()}-${crypto.randomUUID()}.zip`;
}

function diagnosticsDir() {
  return path.join(PROJECT_ROOT, "diagnostics");
}

/**
 * Build and write a diagnostics bundle.
 * @returns {{file: string, bytes: number, entryCount: number, warnings: string[]}}
 */
function exportDiagnostics(context) {
  const { entries, warnings } = buildEntries(context);
  const dir = ensureDir(diagnosticsDir());
  const file = path.join(dir, diagnosticsFileName());
  const archive = createZip(entries);
  fs.writeFileSync(file, archive);
  return { file, bytes: archive.length, entryCount: entries.length, warnings };
}

/** Newest diagnostics bundles, for the "show in folder" affordance. */
function listDiagnostics() {
  const dir = diagnosticsDir();
  if (!isDirectory(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      const stat = fs.statSync(file);
      return { name: entry.name, file, bytes: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() };
    })
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt, "en"));
}

function readDiagnosticsSummary() {
  const latest = listDiagnostics()[0];
  if (latest === undefined) return { dir: diagnosticsDir(), latest: undefined };
  return { dir: diagnosticsDir(), latest };
}

module.exports = {
  buildEntries,
  diagnosticsDir,
  diagnosticsFileName,
  exportDiagnostics,
  listDiagnostics,
  readDiagnosticsSummary,
};
