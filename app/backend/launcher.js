"use strict";
// Start / stop / restart the target desktop application.
//
// The recovery console must be able to stop a wedged instance before it can
// repair or restart anything, so processes are matched by exact executable
// path (never by image name alone, which would catch other installs) and are
// stopped gracefully first: a normal window close lets the app flush profile
// state, and only a stuck instance is force-killed — together with its child
// process tree, which is where the DSH host and web server live.

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

const { ensureDir, isFile, pathExists } = require("./util");
const { PROJECT_ROOT } = require("./paths");

const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe";

const TASKKILL = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "taskkill.exe") : "taskkill.exe";

const GRACEFUL_TIMEOUT_MS = 12000;
const POLL_INTERVAL_MS = 400;

function quotePowerShell(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: options.timeoutMs ?? 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Running processes whose executable is exactly this target. */
async function listProcesses(target) {
  if (typeof target?.exe !== "string" || !isFile(target.exe)) return [];
  const name = path.basename(target.exe);
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$name = ${quotePowerShell(name)}`,
    `$exe = ${quotePowerShell(target.exe)}`,
    "$out = @()",
    "foreach ($p in (Get-CimInstance Win32_Process -Filter \"Name = '$name'\")) {",
    "  if ($p.ExecutablePath -and ($p.ExecutablePath -ieq $exe)) {",
    "    $out += [pscustomobject]@{ pid = $p.ProcessId; started = $p.CreationDate.ToString('o'); command = $p.CommandLine }",
    "  }",
    "}",
    "ConvertTo-Json -InputObject $out -Compress -Depth 3",
  ].join("\n");
  const result = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (!result.ok && result.stdout.trim() === "") return [];
  const text = result.stdout.trim();
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((entry) => entry !== null && typeof entry === "object" && Number.isFinite(Number(entry.pid)))
      .map((entry) => ({ pid: Number(entry.pid), started: entry.started, command: entry.command }));
  } catch {
    return [];
  }
}

async function isRunning(target) {
  return (await listProcesses(target)).length > 0;
}

async function closeMainWindow(pids) {
  if (pids.length === 0) return;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `foreach ($procId in @(${pids.join(",")})) {`,
    "  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue",
    "  if ($p) { [void]$p.CloseMainWindow() }",
    "}",
  ].join("\n");
  await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script]);
}

async function forceKill(pids) {
  for (const pid of pids) {
    await run(TASKKILL, ["/PID", String(pid), "/T", "/F"]);
  }
}

/**
 * Stop every instance of the target: graceful close, then force-kill the
 * remaining process trees. Resolves with what actually happened so the UI can
 * report "已优雅退出" versus "已强制结束".
 */
async function stop(target, { timeoutMs = GRACEFUL_TIMEOUT_MS } = {}) {
  const initial = await listProcesses(target);
  if (initial.length === 0) return { stopped: [], forced: [], wasRunning: false };
  const pids = initial.map((entry) => entry.pid);

  await closeMainWindow(pids);
  const deadline = Date.now() + timeoutMs;
  let remaining = pids;
  while (Date.now() < deadline && remaining.length > 0) {
    await sleep(POLL_INTERVAL_MS);
    const alive = new Set((await listProcesses(target)).map((entry) => entry.pid));
    remaining = pids.filter((pid) => alive.has(pid));
  }

  let forced = [];
  if (remaining.length > 0) {
    await forceKill(remaining);
    forced = remaining;
    await sleep(POLL_INTERVAL_MS * 2);
  }
  const stillAlive = (await listProcesses(target)).map((entry) => entry.pid);
  return {
    wasRunning: true,
    stopped: pids.filter((pid) => !stillAlive.includes(pid)),
    forced,
    alive: stillAlive,
    graceful: forced.length === 0,
  };
}

function safeModeRoot() {
  return path.join(PROJECT_ROOT, ".safemode");
}

function safeModeHome(timestamp) {
  return path.join(safeModeRoot(), timestamp);
}

/**
 * Launch the target. `env` overrides are merged over a sanitized copy of the
 * console's own environment, so a launch never inherits this Electron
 * process's Electron-specific variables.
 */
function launch(target, { env = {}, args = [], cwd } = {}) {
  if (typeof target?.exe !== "string" || !pathExists(target.exe)) {
    throw new Error(`找不到可执行文件: ${target?.exe ?? "(未设置)"}`);
  }
  const base = { ...process.env };
  delete base.ELECTRON_RUN_AS_NODE;
  delete base.ELECTRON_NO_ATTACH_CONSOLE;
  delete base.ELECTRON_ENABLE_LOGGING;
  const child = spawn(target.exe, args, {
    cwd: cwd ?? target.dir,
    env: { ...base, ...env },
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return { pid: child.pid, cwd: cwd ?? target.dir, env: { ...env } };
}

/** Restart: stop (if needed), then launch. */
async function restart(target, options = {}) {
  const stopped = await stop(target, options);
  await sleep(600);
  const launched = launch(target, options);
  return { stopped, launched };
}

/** Fresh throwaway Harness home for safe mode. */
function prepareSafeModeHome() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/gu, "-")
    .replace("T", "_")
    .slice(0, 19);
  const dir = safeModeHome(timestamp);
  ensureDir(dir);
  return dir;
}

/** Temp homes created by earlier safe-mode sessions (for the cleanup action). */
function listSafeModeHomes() {
  const root = safeModeRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, dir: path.join(root, entry.name) }))
    .sort((left, right) => right.id.localeCompare(left.id, "en"));
}

module.exports = {
  GRACEFUL_TIMEOUT_MS,
  isRunning,
  launch,
  listProcesses,
  listSafeModeHomes,
  prepareSafeModeHome,
  restart,
  safeModeHome,
  safeModeRoot,
  stop,
};
