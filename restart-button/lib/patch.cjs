"use strict";
// dsh-recovery / restart-button : in-place, length-preserving asar patcher.
//
// Library behind both the command line (lib/apply.cjs) and the recovery
// console tab (app/backend/restart-button.js). Only lib/main.js and
// lib/preload-app.cjs are replaced, and only by byte sequences exactly as long
// as the header's `size`. Entry offsets therefore stay valid for the header the
// running application already holds, so a patch may be applied while DeepSeek
// Harness is open; the new menu shows up after the next restart.
//
//   status  read only : current vs payload vs backup, header integrity state
//   verify  read only : header integrity + syntax of the installed bytes
//   apply   write     : back both entries up, then replace them in place
//   revert  write     : put the backed up bytes back
//
// Every function takes an optional `log(line)` sink and returns structured data
// instead of printing, so nothing here writes to stdout on its own.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const asar = require("./asar.cjs");

const ROOT = path.resolve(__dirname, "..");
const PAYLOAD_DIR = path.join(ROOT, "payload", "lib");
const DEFAULT_BACKUP_DIR = path.join(ROOT, "backup");
const DEFAULT_STATE_FILE = path.join(ROOT, "state.json");
const ENTRIES = ["lib/main.js", "lib/preload-app.cjs"];
const DEFAULT_ARCHIVE = "D:\\Dev Tools\\DeepSeek Harness\\resources\\app.asar";
const TOOL_VERSION = "1.3.0";

const none = () => {};
const short = (hash) => (hash ? `${hash.slice(0, 16)}…` : "(无)");
const backupName = (entryPath) => `${entryPath.replace(/\//g, "__")}.orig`;
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Run synchronous filesystem work with Electron's asar support disabled.
 *
 * Inside Electron (the recovery console) the patched `fs` treats any path
 * containing `.asar` as a virtual directory: `fs.openSync(".../app.asar", "r+")`
 * fails with ENOENT and reads return archive members instead of the raw pickle.
 * Every archive access below therefore runs with `process.noAsar` set, which is
 * safe because all of it is synchronous.
 */
function withoutAsar(fn) {
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = previous;
  }
}

/**
 * Backup directory and state file to use for one archive.
 *
 * The tool root keeps the historical single-install layout, so an install made
 * by an earlier version of this tool stays recognised. Any other archive gets
 * its own scoped directory: two installs must never share one backup, or a
 * revert would restore the wrong bytes.
 */
function pathsFor(archive, options = {}) {
  const resolved = path.resolve(archive);
  if (options.backupDir && options.stateFile) {
    return { archive: resolved, backupDir: path.resolve(options.backupDir), stateFile: path.resolve(options.stateFile), layout: "explicit" };
  }
  const rootState = readState(DEFAULT_STATE_FILE);
  const rootOwns = rootState?.archive ? samePath(rootState.archive, resolved) : samePath(resolved, DEFAULT_ARCHIVE);
  if (rootOwns) {
    return { archive: resolved, backupDir: DEFAULT_BACKUP_DIR, stateFile: DEFAULT_STATE_FILE, layout: "root" };
  }
  const slug = crypto.createHash("sha256").update(resolved.toLowerCase()).digest("hex").slice(0, 12);
  return {
    archive: resolved,
    backupDir: path.join(ROOT, "backup", slug),
    stateFile: path.join(ROOT, `state-${slug}.json`),
    layout: "scoped"
  };
}

/** Payload bytes for one entry, or a message telling the user to build them. */
function payloadFor(entryPath) {
  const file = path.join(PAYLOAD_DIR, path.basename(entryPath));
  if (!fs.existsSync(file)) {
    throw new Error(`缺少载荷 ${file}；请先运行：node lib\\build-payload.cjs --write`);
  }
  return fs.readFileSync(file);
}

/** Payload hashes for every patched entry, for display. */
function payloadHashes() {
  return ENTRIES.map((entryPath) => {
    const file = path.join(PAYLOAD_DIR, path.basename(entryPath));
    const exists = fs.existsSync(file);
    const buf = exists ? fs.readFileSync(file) : null;
    return { entryPath, file, exists, size: buf === null ? null : buf.length, hash: buf === null ? null : asar.sha256(buf) };
  });
}

function openArchive(archivePath, flags) {
  try {
    return fs.openSync(archivePath, flags);
  } catch (error) {
    const hint = error.code === "ENOENT" ? "路径不存在" : error.code === "EBUSY" || error.code === "EPERM" ? "文件被占用，请先退出 DeepSeek Harness 再试" : error.message;
    throw new Error(`无法以 ${flags} 打开 ${archivePath}：${hint}`);
  }
}

function readState(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Reads one entry from a fresh header; the caller owns the descriptor. */
function snapshot(fd, entryPath) {
  const header = asar.readHeader(fd);
  const { entry, start, buf } = asar.readEntry(fd, header, entryPath);
  const integrity = entry.integrity ?? null;
  return {
    entryPath,
    size: entry.size,
    start,
    buf,
    hash: asar.sha256(buf),
    headerHash: integrity?.hash ?? null,
    blocks: integrity?.blocks ?? null
  };
}

function integrityOk(snap) {
  if (snap.headerHash === null) return { ok: true, detail: "头部无 integrity 元数据" };
  const blocks = Array.isArray(snap.blocks) && snap.blocks.length > 0 ? snap.blocks : [snap.headerHash];
  const bad = blocks.filter((hash) => hash !== snap.hash);
  if (bad.length > 0) return { ok: false, detail: `头部 integrity 与内容不一致（${bad.length}/${blocks.length} 块）` };
  return { ok: true, detail: `头部 integrity 与内容一致（${blocks.length} 块）` };
}

/**
 * `node --check` on a buffer, written to a throwaway file.
 *
 * Inside Electron process.execPath is the app binary, not node, so the child
 * gets ELECTRON_RUN_AS_NODE=1 to make it behave as the bundled node.
 */
function syntaxCheck(buffer, label) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-restart-")), label);
  try {
    fs.writeFileSync(file, buffer);
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "pipe", "pipe"], env, timeout: 20000 });
    return { ok: true, detail: "node --check 通过" };
  } catch (error) {
    const tail = String(error.stderr ?? error.message).trim().split("\n").slice(-3).join(" / ");
    return { ok: false, detail: `node --check 失败：${tail}` };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

/** Which kind of content an entry currently holds. */
function verdictFor(snap, payload, backupBuf) {
  if (payload !== null && asar.sha256(payload) === snap.hash) return "installed";
  if (backupBuf !== null && asar.sha256(backupBuf) === snap.hash) return "original";
  return "unknown";
}

const VERDICT_TEXT = { installed: "已安装（= 载荷）", original: "未安装（= 备份的原始内容）", unknown: "未知内容" };

function status(options = {}) {
  return withoutAsar(() => statusRaw(options));
}

function statusRaw({ archive = DEFAULT_ARCHIVE, backupDir, stateFile, log = none } = {}) {
  const paths = pathsFor(archive, { backupDir, stateFile });
  const fd = openArchive(paths.archive, "r");
  try {
    const state = readState(paths.stateFile);
    const entries = [];
    log(`asar      ${paths.archive}`);
    log(`载荷目录  ${PAYLOAD_DIR}`);
    log(`状态文件  ${paths.stateFile}${state ? "" : "（不存在，可能尚未安装）"}`);
    if (state?.installedAt) log(`安装时间  ${state.installedAt}`);
    log("");
    for (const entryPath of ENTRIES) {
      const snap = snapshot(fd, entryPath);
      const payloadFile = path.join(PAYLOAD_DIR, path.basename(entryPath));
      const payload = fs.existsSync(payloadFile) ? payloadFor(entryPath) : null;
      const backupFile = path.join(paths.backupDir, backupName(entryPath));
      const backupBuf = fs.existsSync(backupFile) ? fs.readFileSync(backupFile) : null;
      const verdict = verdictFor(snap, payload, backupBuf);
      const integrity = integrityOk(snap);
      entries.push({
        entryPath,
        size: snap.size,
        hash: snap.hash,
        headerHash: snap.headerHash,
        payloadSize: payload === null ? null : payload.length,
        lengthMismatch: payload !== null && payload.length !== snap.size,
        hasBackup: backupBuf !== null,
        verdict,
        integrity
      });
      log(`${entryPath}`);
      log(`  大小      ${snap.size} 字节${payload !== null && payload.length !== snap.size ? `  ← 载荷 ${payload.length} 字节，长度不符！` : ""}`);
      log(`  内容 sha256  ${snap.hash}`);
      log(`  判定      ${VERDICT_TEXT[verdict]}`);
      log(`  头部      ${short(snap.headerHash)}  ${integrity.ok ? "OK" : "不一致"}  ${integrity.detail}`);
      log("");
    }
    const installed = entries.filter((entry) => entry.verdict === "installed").length;
    const conclusion = installed === ENTRIES.length ? "installed" : installed === 0 ? "absent" : "partial";
    log(conclusion === "installed" ? "结论：重启按钮补丁已安装（重启 DeepSeek Harness 后生效）。" : conclusion === "absent" ? "结论：未安装补丁。" : "结论：只有部分条目是载荷内容，请运行 apply 修复。");
    return { archive: paths.archive, backupDir: paths.backupDir, stateFile: paths.stateFile, layout: paths.layout, installedAt: state?.installedAt ?? null, entries, installed, conclusion };
  } finally {
    fs.closeSync(fd);
  }
}

function verify(options = {}) {
  return withoutAsar(() => verifyRaw(options));
}

function verifyRaw({ archive = DEFAULT_ARCHIVE, backupDir, stateFile, log = none } = {}) {
  const paths = pathsFor(archive, { backupDir, stateFile });
  const fd = openArchive(paths.archive, "r");
  const entries = [];
  let failures = 0;
  try {
    log(`asar      ${paths.archive}`);
    log("");
    for (const entryPath of ENTRIES) {
      const snap = snapshot(fd, entryPath);
      const integrity = integrityOk(snap);
      const syntax = syntaxCheck(snap.buf, path.basename(entryPath));
      const payloadFile = path.join(PAYLOAD_DIR, path.basename(entryPath));
      const isPayload = fs.existsSync(payloadFile) && asar.sha256(payloadFor(entryPath)) === snap.hash;
      const ok = integrity.ok && syntax.ok && isPayload;
      if (!ok) failures += 1;
      entries.push({ entryPath, size: snap.size, hash: snap.hash, integrity, syntax, isPayload, ok });
      log(`${ok ? "[OK]  " : "[FAIL]"} ${entryPath}  ${snap.size} 字节  ${snap.hash.slice(0, 16)}…`);
      log(`       ${integrity.detail}；${syntax.detail}；${isPayload ? "内容等于载荷" : "内容不等于载荷（可能未安装或已被其他工具修改）"}`);
    }
    log("");
    log(failures === 0 ? "verify: 两个条目均为载荷内容，头部 integrity 与语法均通过。" : `verify: ${failures} 个条目未通过。`);
    return { archive: paths.archive, entries, failures, ok: failures === 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function apply(options = {}) {
  return withoutAsar(() => applyRaw(options));
}

function applyRaw({ archive = DEFAULT_ARCHIVE, backupDir, stateFile, log = none } = {}) {
  const paths = pathsFor(archive, { backupDir, stateFile });
  const payloads = new Map(ENTRIES.map((entryPath) => [entryPath, payloadFor(entryPath)]));
  fs.mkdirSync(paths.backupDir, { recursive: true });
  const manifestFile = path.join(paths.backupDir, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { entries: {} };
  manifest.entries ??= {};

  const fd = openArchive(paths.archive, "r+");
  const report = [];
  let changed = 0;
  try {
    for (const entryPath of ENTRIES) {
      const snap = snapshot(fd, entryPath);
      const payload = payloads.get(entryPath);
      const wanted = asar.sha256(payload);
      if (snap.hash === wanted) {
        report.push({ entryPath, action: "skip", hash: snap.hash, size: snap.size, note: "已经是载荷内容" });
        log(`跳过      ${entryPath} 已经是载荷内容`);
        continue;
      }
      if (snap.size !== payload.length) {
        throw new Error(`${entryPath} 现有 ${snap.size} 字节，载荷 ${payload.length} 字节；长度不同会平移后续偏移，已中止（未写入任何字节）`);
      }
      const backupFile = path.join(paths.backupDir, backupName(entryPath));
      if (!fs.existsSync(backupFile)) {
        fs.writeFileSync(backupFile, snap.buf);
        manifest.entries[entryPath] = {
          backupFile: path.relative(ROOT, backupFile),
          size: snap.size,
          sha256: snap.hash,
          headerHash: snap.headerHash,
          backedUpAt: new Date().toISOString()
        };
        fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
        log(`备份      ${entryPath} → ${path.relative(ROOT, backupFile)}（${snap.size} 字节，${short(snap.hash)}）`);
      } else {
        log(`备份      已存在，保留首份备份 ${path.relative(ROOT, backupFile)}`);
      }
      const written = asar.writeEntry(fd, asar.readHeader(fd), entryPath, payload);
      fs.fsyncSync(fd);
      changed += 1;
      report.push({ entryPath, action: "write", hash: wanted, previousHash: written.previousHash, hashHits: written.hashHits, size: payload.length });
      log(`写入      ${entryPath}  ${short(written.previousHash)} → ${short(wanted)}（头部哈希串更新 ${written.hashHits} 处）`);
    }
  } finally {
    fs.closeSync(fd);
  }

  const readback = verify({ archive: paths.archive, backupDir: paths.backupDir, stateFile: paths.stateFile, log: (line) => log(line === "" ? "" : `回读 ${line.trim()}`) });
  if (readback.failures > 0) {
    return { archive: paths.archive, backupDir: paths.backupDir, stateFile: paths.stateFile, ok: false, changed, entries: report, readback, error: `回读校验失败 ${readback.failures} 项，可执行 revert 恢复备份` };
  }

  const state = {
    toolVersion: TOOL_VERSION,
    installedAt: new Date().toISOString(),
    archive: paths.archive,
    entries: report,
    backupDir: paths.backupDir,
    layout: paths.layout
  };
  fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true });
  fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  log("");
  log(`apply: 完成。状态写入 ${paths.stateFile}`);
  log("重启 DeepSeek Harness 后，「应用」「编辑」右侧会出现「重启」菜单。");
  return { archive: paths.archive, backupDir: paths.backupDir, stateFile: paths.stateFile, ok: true, changed, entries: report, readback, state };
}

function revert(options = {}) {
  return withoutAsar(() => revertRaw(options));
}

function revertRaw({ archive = DEFAULT_ARCHIVE, backupDir, stateFile, log = none } = {}) {
  const paths = pathsFor(archive, { backupDir, stateFile });
  const payloads = new Map(ENTRIES.map((entryPath) => [entryPath, payloadFor(entryPath)]));
  const manifestFile = path.join(paths.backupDir, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { entries: {} };
  const fd = openArchive(paths.archive, "r+");
  let touched = 0;
  try {
    for (const entryPath of ENTRIES) {
      const backupFile = path.join(paths.backupDir, backupName(entryPath));
      if (!fs.existsSync(backupFile)) {
        log(`跳过      ${entryPath} 没有备份，无法还原`);
        continue;
      }
      const original = fs.readFileSync(backupFile);
      const snap = snapshot(fd, entryPath);
      if (snap.hash === asar.sha256(original)) {
        log(`跳过      ${entryPath} 已是备份内容`);
        continue;
      }
      if (snap.size !== original.length) {
        throw new Error(`${entryPath} 现有 ${snap.size} 字节，备份 ${original.length} 字节；长度不同会平移后续偏移，已中止`);
      }
      const written = asar.writeEntry(fd, asar.readHeader(fd), entryPath, original);
      fs.fsyncSync(fd);
      touched += 1;
      log(`还原      ${entryPath}  ${short(snap.hash)} → ${short(asar.sha256(original))}（头部哈希串更新 ${written.hashHits} 处）`);
    }
  } finally {
    fs.closeSync(fd);
  }

  const verifyFd = openArchive(paths.archive, "r");
  let failures = 0;
  try {
    for (const entryPath of ENTRIES) {
      const snap = snapshot(verifyFd, entryPath);
      const backupFile = path.join(paths.backupDir, backupName(entryPath));
      const expected = fs.existsSync(backupFile) ? asar.sha256(fs.readFileSync(backupFile)) : asar.sha256(payloads.get(entryPath));
      const integrity = integrityOk(snap);
      const ok = snap.hash === expected && integrity.ok;
      if (!ok) failures += 1;
      log(`${ok ? "[OK]  " : "[FAIL]"} 回读 ${entryPath}  ${snap.size} 字节  ${snap.hash.slice(0, 16)}…  ${integrity.detail}`);
    }
  } finally {
    fs.closeSync(verifyFd);
  }
  if (failures > 0) return { archive: paths.archive, ok: false, touched, error: `回读校验失败 ${failures} 项` };
  if (touched > 0 && fs.existsSync(paths.stateFile)) {
    fs.rmSync(paths.stateFile, { force: true });
    log("");
    log(`已删除 ${paths.stateFile}`);
  }
  manifest.revertedAt = new Date().toISOString();
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  log("");
  log(`revert: 完成（${touched} 个条目被还原）。重启 DeepSeek Harness 后退回原菜单。`);
  return { archive: paths.archive, ok: true, touched };
}

module.exports = {
  DEFAULT_ARCHIVE,
  DEFAULT_BACKUP_DIR,
  DEFAULT_STATE_FILE,
  ENTRIES,
  PAYLOAD_DIR,
  ROOT,
  TOOL_VERSION,
  apply,
  backupName,
  pathsFor,
  payloadHashes,
  revert,
  status,
  verify
};
