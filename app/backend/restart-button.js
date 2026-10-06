"use strict";
// Restart-button patch bridge for the recovery console.
//
// The console tab and the command line wrappers (restart-button\*.cmd) drive the
// same library, restart-button\lib\patch.cjs, so both ways to install or remove
// the patch behave identically. This module only adapts that library to the
// console: it resolves the archive from the console's own target list and turns
// the library's Chinese log lines into structured data for the renderer.

const fs = require("node:fs");
const path = require("node:path");

const TOOL_DIR = path.resolve(__dirname, "..", "..", "restart-button");
const patch = require(path.join(TOOL_DIR, "lib", "patch.cjs"));

const VERDICT_LABEL = { installed: "已安装（= 载荷）", original: "未安装（= 备份的原始内容）", unknown: "未知内容" };
const VERDICT_TONE = { installed: "ok", original: "muted", unknown: "warn" };

const short = (hash) => (typeof hash === "string" ? `${hash.slice(0, 16)}…` : undefined);

/** The asar of the selected target, or undefined when it cannot be located. */
function archiveFor(target) {
  const resourcesDir = target?.resourcesDir;
  if (typeof resourcesDir !== "string" || resourcesDir === "") return undefined;
  return path.join(resourcesDir, "app.asar");
}

function collect(fn) {
  const lines = [];
  const result = fn((line) => lines.push(line));
  return { result, lines };
}

function failure(error, archive) {
  return {
    available: false,
    archive,
    installed: false,
    installedCount: 0,
    entryTotal: patch.ENTRIES.length,
    entries: [],
    payloads: [],
    reason: String(error?.message ?? error),
    toolDir: TOOL_DIR,
  };
}

/**
 * Read-only summary of the patch for one target. Never throws: an unreachable
 * archive becomes `available: false` with a reason, so the panel can explain it.
 */
function summarize(target) {
  const archive = archiveFor(target);
  if (archive === undefined) return failure(new Error("目标应用没有 resources 目录，无法定位 app.asar"), undefined);
  if (!fs.existsSync(archive)) return failure(new Error(`找不到 ${archive}`), archive);
  try {
    const { result, lines } = collect((log) => patch.status({ archive, log }));
    const entries = result.entries.map((entry) => ({
      entryPath: entry.entryPath,
      size: entry.size,
      payloadSize: entry.payloadSize,
      hash: entry.hash,
      hashLabel: short(entry.hash),
      headerHashLabel: short(entry.headerHash),
      hasBackup: entry.hasBackup,
      lengthMismatch: entry.lengthMismatch,
      verdict: entry.verdict,
      verdictLabel: VERDICT_LABEL[entry.verdict] ?? entry.verdict,
      verdictTone: VERDICT_TONE[entry.verdict] ?? "muted",
      integrityOk: entry.integrity.ok,
      integrityDetail: entry.integrity.detail,
    }));
    return {
      available: true,
      archive: result.archive,
      toolDir: TOOL_DIR,
      toolVersion: patch.TOOL_VERSION,
      layout: result.layout,
      stateFile: result.stateFile,
      stateExists: typeof result.stateFile === "string" && fs.existsSync(result.stateFile),
      backupDir: result.backupDir,
      backupExists: typeof result.backupDir === "string" && fs.existsSync(result.backupDir),
      installedAt: result.installedAt ?? undefined,
      installed: result.installed === patch.ENTRIES.length,
      installedCount: result.installed,
      entryTotal: patch.ENTRIES.length,
      conclusion: result.conclusion,
      entries,
      payloads: patch.payloadHashes().map((payload) => ({
        entryPath: payload.entryPath,
        file: payload.file,
        exists: payload.exists,
        size: payload.size,
        hashLabel: short(payload.hash),
      })),
      lines,
    };
  } catch (error) {
    return failure(error, archive);
  }
}

/** Runs one write/verify command and returns console friendly data. */
function command(kind, target) {
  const archive = archiveFor(target);
  if (archive === undefined) return { ok: false, action: kind, message: "目标应用没有 resources 目录，无法定位 app.asar" };
  try {
    if (kind === "apply") {
      const { result, lines } = collect((log) => patch.apply({ archive, log }));
      return {
        ok: result.ok === true,
        action: kind,
        archive,
        changed: result.changed,
        lines,
        message: result.ok
          ? `已安装重启按钮补丁（重启 DeepSeek Harness 后生效）${result.changed === 0 ? "；内容原本就是载荷，未改写" : ""}`
          : (result.error ?? "安装失败"),
      };
    }
    if (kind === "revert") {
      const { result, lines } = collect((log) => patch.revert({ archive, log }));
      return {
        ok: result.ok === true,
        action: kind,
        archive,
        touched: result.touched,
        lines,
        message: result.ok
          ? result.touched === 0
            ? "没有需要还原的条目（当前内容不在备份覆盖范围内）"
            : `已还原 ${result.touched} 个条目；重启 DeepSeek Harness 后退回原菜单`
          : (result.error ?? "还原失败"),
      };
    }
    const { result, lines } = collect((log) => patch.verify({ archive, log }));
    return {
      ok: result.ok === true,
      action: "verify",
      archive,
      failures: result.failures,
      lines,
      message: result.ok ? "校验通过：两个条目都是载荷内容，头部 integrity 与语法均正常" : `校验未通过：${result.failures} 个条目有问题`,
      entries: result.entries.map((entry) => ({
        entryPath: entry.entryPath,
        ok: entry.ok,
        integrityOk: entry.integrity.ok,
        integrityDetail: entry.integrity.detail,
        syntaxOk: entry.syntax.ok,
        syntaxDetail: entry.syntax.detail,
        isPayload: entry.isPayload,
      })),
    };
  } catch (error) {
    return { ok: false, action: kind, archive, message: String(error?.message ?? error) };
  }
}

module.exports = {
  TOOL_DIR,
  apply: (target) => command("apply", target),
  archiveFor,
  revert: (target) => command("revert", target),
  summarize,
  verify: (target) => command("verify", target)
};
