"use strict";
// Plugin update/repair engine shared by the recovery console and the
// `dsh-plugin-doctor` CLI.
//
// Why this exists: two defects in DSH Desktop 0.2.1-rc.2 make in-app plugin
// updates unreliable —
//
//   1. `@deepseek-ai/dsh-plugin-manager`'s `removeBundle()` runs pnpm (which
//      succeeds and deletes the package), then calls `configure()` →
//      `hmr.runExclusive()`. That queue is serialised with no timeout and no
//      cancellation, so one unsettled head blocks every later operation: the
//      `add` half of the same update, the next update, the market's own lock.
//      pnpm already finished, so the UI sticks on "Removing…" while the package
//      is gone — and after a restart the plugin is simply missing.
//
//   2. `dshmarket`'s `installOrReinstall()` refuses to update itself
//      (`market-self-update`): removing the market unloads the code that would
//      run the reinstall. The app's Plugins page has no update entry either,
//      so pnpm against the profile with DSH fully quit is the only path.
//
// Both are avoided the same way: mutate the profile with the app stopped.
//
// This module only uses Node built-ins, so it works while the target profile
// itself cannot boot. It never prints; every operation returns a result object
// so a CLI and a UI can both render it.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CORE_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
const SPEC_PATTERN = /^[A-Za-z0-9@:./_#+~^=-]+$/;

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

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

/** Write a file through a sibling temp file plus rename, so readers never see half a manifest. */
function writeJsonAtomic(file, value) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    throw error;
  }
}

function profileManifestPath(dir) {
  return path.join(dir, "package.json");
}

function installedManifest(dir, name) {
  try {
    return readJson(path.join(dir, "node_modules", ...name.split("/"), "package.json"));
  } catch {
    return undefined;
  }
}

function installedVersion(dir, name) {
  return installedManifest(dir, name)?.version;
}

function isBundle(manifest) {
  return manifest !== undefined && manifest.dsh !== undefined && manifest.dsh.bundle !== undefined;
}

function bundleList(manifest) {
  return manifest.dsh?.profile?.bundles ?? [];
}

function setBundleList(manifest, bundles) {
  manifest.dsh = manifest.dsh ?? {};
  manifest.dsh.profile = manifest.dsh.profile ?? {};
  manifest.dsh.profile.bundles = bundles;
}

/**
 * Whether the package declares a host entry at all.
 *
 * A patch-only bundle is legitimate: it ships `dsh.bundle.patch` and uses only
 * `exports` subpaths for assets, with no `main` and no "." export. Such a
 * package has no host half to load, so a missing entry file is not a defect.
 */
function declaresEntry(manifest) {
  if (typeof manifest.main === "string") return true;
  if (manifest.dsh?.client !== undefined) return true;
  const exportsField = manifest.exports;
  if (typeof exportsField === "string") return true;
  if (exportsField === null || typeof exportsField !== "object") return false;
  return [".", "./index", "./server", "./host"].some((key) => exportsField[key] !== undefined);
}

/** The entry file a package declares, if it exists on disk. */
function entryFile(dir, name, manifest) {
  const packageDir = path.join(dir, "node_modules", ...name.split("/"));
  const candidates = [];
  if (typeof manifest.main === "string") candidates.push(manifest.main);
  const exportsField = manifest.exports;
  if (typeof exportsField === "string") candidates.push(exportsField);
  else if (exportsField !== null && typeof exportsField === "object") {
    for (const key of [".", "./index", "./server", "./host"]) {
      const value = exportsField[key];
      if (typeof value === "string") candidates.push(value);
      else if (value !== null && typeof value === "object") {
        for (const condition of ["import", "require", "default"]) {
          if (typeof value[condition] === "string") candidates.push(value[condition]);
        }
      }
    }
  }
  for (const fallback of ["index.js", "lib/index.js", "dist/index.js", "index.mjs"]) candidates.push(fallback);
  for (const candidate of candidates) {
    const absolute = path.join(packageDir, candidate);
    if (pathExists(absolute) && fs.statSync(absolute).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Bundle patch files declared by `dsh.bundle`.
 *
 * The host's own reader (`bundlePatchFiles()` in dsh-app-boot) accepts exactly
 * `{ patch: string | string[] }` and throws on anything else, so this mirrors
 * that shape rather than inventing a wider one.
 */
function bundlePatchFiles(dir, name, manifest) {
  const bundle = manifest?.dsh?.bundle;
  if (bundle === undefined) return [];
  const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
  if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string")) {
    return [{ file: undefined, exists: false, invalid: "dsh.bundle.patch 必须是文件路径或其列表" }];
  }
  return declared.map((relative) => {
    const file = path.join(dir, "node_modules", ...name.split("/"), relative);
    return { file, exists: pathExists(file) };
  });
}

function missingBundlePatch(dir, name, manifest) {
  return bundlePatchFiles(dir, name, manifest).find((patch) => patch.exists === false) ?? null;
}

/** `dshmarket@1.66.45` → `dshmarket`; anything that is not a registry name stays unparsed. */
function registryNameOf(spec) {
  const at = spec.indexOf("@", 1);
  const name = at === -1 ? spec : spec.slice(0, at);
  return /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(name) ? name : spec;
}

// ---------------------------------------------------------------------------
// Install layout / pnpm discovery
// ---------------------------------------------------------------------------

/**
 * The DSH installation directory, from a recovery-console target.
 *
 * The console selects a target either by its install folder or by the app
 * executable; both name the same directory one level below.
 */
function installDirOf(target) {
  if (target === undefined || target === null) return undefined;
  if (typeof target.dir === "string" && target.dir !== "") return path.resolve(target.dir);
  if (typeof target.exe === "string" && target.exe !== "") return path.dirname(target.exe);
  return undefined;
}

function bundledRuntime(installDir) {
  if (installDir === undefined) return undefined;
  const root = path.join(installDir, "resources", "runtime", "primary-runtime", "dependencies");
  const pnpm = path.join(root, "pnpm", "bin", "pnpm.mjs");
  const node = path.join(root, "node", "bin", process.platform === "win32" ? "node.exe" : "node");
  if (!pathExists(pnpm)) return undefined;
  return { pnpm, node: pathExists(node) ? node : undefined };
}

/**
 * How to run pnpm: an executable plus leading arguments and extra env.
 *
 * Preference order is the installation's own runtime (exactly what DSH itself
 * uses, and present even when PATH is not), then an explicit override, then a
 * PATH pnpm. A host that is itself Electron runs pnpm through itself with
 * ELECTRON_RUN_AS_NODE, which needs no separate Node install.
 */
function resolvePnpm(installDir) {
  const runtime = bundledRuntime(installDir);
  if (runtime !== undefined) {
    return runtime.node === undefined
      ? { command: process.execPath, prefix: [runtime.pnpm], env: { ELECTRON_RUN_AS_NODE: "1" }, source: "DSH 自带运行时" }
      : { command: runtime.node, prefix: [runtime.pnpm], env: {}, source: "DSH 自带运行时" };
  }
  const override = process.env.DSH_PNPM_ENTRY;
  if (typeof override === "string" && override !== "" && pathExists(override)) {
    const isScript = /\.[cm]?js$/u.test(override);
    return {
      command: isScript ? process.execPath : override,
      prefix: isScript ? [override] : [],
      env: isScript ? { ELECTRON_RUN_AS_NODE: "1" } : {},
      source: "环境变量 DSH_PNPM_ENTRY",
    };
  }
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const probe = spawnSync(command, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
  });
  if (probe.status === 0) {
    return { command, prefix: [], env: {}, source: "PATH", shell: process.platform === "win32" };
  }
  return undefined;
}

function pnpmVersion(runner) {
  const result = spawnSync(runner.command, [...runner.prefix, "--version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: runner.shell === true,
    env: { ...process.env, ...runner.env },
  });
  return result.status === 0 ? String(result.stdout).trim() : undefined;
}

function runPnpm(dir, runner, args) {
  const result = spawnSync(runner.command, [...runner.prefix, ...args], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
    shell: runner.shell === true,
    env: { ...process.env, ...runner.env, CI: "true" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error !== undefined) throw new Error(`pnpm 无法启动: ${result.error.message}`);
  return { status: result.status, output };
}

/** Fresh releases are held back for a day by pnpm; an update the user asked for should not be. */
function pnpmFlags(options = {}) {
  const list = ["--config.minimum-release-age=0"];
  if (typeof options.registry === "string" && options.registry !== "") list.push(`--config.registry=${options.registry}`);
  return list;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/** Packages the DSH installation itself ships (they resolve from inside the app). */
function installationProvides(name, installDir) {
  if (installDir !== undefined) {
    const prefix = name.split("/");
    const roots = [
      path.join(installDir, "resources", "app.asar", "dsh", "node_modules", ...prefix),
      path.join(installDir, "resources", "app.asar.unpacked", "dsh", "node_modules", ...prefix),
      path.join(installDir, "resources", "runtime", "primary-runtime", "dependencies", ...prefix),
    ];
    for (const root of roots) if (pathExists(path.join(root, "package.json"))) return true;
  }
  return name.startsWith("@deepseek-ai/");
}

function staleArtifacts(dir) {
  const found = [];
  const lock = path.join(dir, "package.json.lock");
  if (pathExists(lock)) {
    const raw = fs.readFileSync(lock, "utf8").trim();
    const pid = Number.parseInt(raw.split("\n")[0], 10);
    found.push({ kind: "file-lock", path: lock, pid, alive: pidAlive(pid), label: "写入锁 package.json.lock" });
  }
  const runRecord = path.join(dir, ".plugin-manager", "run.json");
  if (pathExists(runRecord)) {
    let pid;
    try {
      pid = JSON.parse(fs.readFileSync(runRecord, "utf8"))?.pid;
    } catch {
      pid = undefined;
    }
    found.push({ kind: "run-record", path: runRecord, pid, alive: pidAlive(pid), label: "上次运行记录 run.json" });
  }
  return found;
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** One row per package the profile knows about, with every inconsistency spelled out. */
function inspectProfile(dir, options = {}) {
  const manifest = readJson(profileManifestPath(dir));
  const dependencies = manifest.dependencies ?? {};
  const bundles = bundleList(manifest);
  const installDir = options.installDir;
  const rows = [];

  for (const name of [...new Set([...Object.keys(dependencies), ...bundles])].sort()) {
    const declared = dependencies[name];
    const onDisk = installedManifest(dir, name);
    const version = onDisk?.version;
    rows.push({
      name,
      declared,
      version,
      bundle: isBundle(onDisk),
      inBundles: bundles.includes(name),
      core: CORE_BUNDLES.includes(name),
      entryDeclared: onDisk === undefined ? false : declaresEntry(onDisk),
      entry: onDisk === undefined ? undefined : entryFile(dir, name, onDisk),
      patchMissing: onDisk === undefined ? null : missingBundlePatch(dir, name, onDisk),
      installationProvided: false,
      stale: false,
      problems: [],
    });
  }

  for (const row of rows) {
    if (row.declared === undefined && row.version === undefined) {
      // A bundle row can name an installation-provided package (dsh-base,
      // dsh-web-app) or one that is simply gone. Only the second is a defect.
      row.installationProvided = row.inBundles && installationProvides(row.name, installDir);
      row.stale = row.inBundles && !row.installationProvided;
      if (row.stale) row.problems.push("列在插件层里，但既没有安装也没有在依赖中声明（会让 profile 组不起来）");
      else continue;
    }
    if (row.declared === undefined && row.version !== undefined) row.problems.push("磁盘上已安装，但没有写进 package.json");
    if (row.declared !== undefined && row.version === undefined) row.problems.push("package.json 里有声明，但 node_modules 里没有（重启后组不起来）");
    if (row.bundle && !row.inBundles) row.problems.push("已安装为插件，但不在 dsh.profile.bundles 里（不会加载）");
    if (!row.bundle && row.inBundles && row.version !== undefined) row.problems.push("列在 dsh.profile.bundles 里，但没有声明 dsh.bundle（会让组合失败）");
    if (row.entryDeclared && row.entry === undefined) row.problems.push("声明了入口文件，但文件不存在（构建不完整）");
    if (row.patchMissing !== null) row.problems.push(row.patchMissing?.invalid ?? `补丁文件不存在: ${row.patchMissing.file}`);
    if (typeof row.declared === "string" && /^\d+\.\d+\.\d+/u.test(row.declared) && row.version !== undefined && row.declared !== row.version) {
      row.problems.push(`package.json 记为 ${row.declared}，实际安装的是 ${row.version}`);
    }
  }

  return { dir, manifest, dependencies, bundles, rows, inconsistent: rows.filter((row) => row.problems.length > 0) };
}

/**
 * Explain the market's own log: an operation that started and never reported a
 * result is the HMR-hang signature, and its pnpm log tells whether the package
 * manager had already finished when the stall began.
 */
function diagnose(dir, options = {}) {
  const installDir = options.installDir;
  const findings = { stuck: [], stale: [], problems: [], notes: [] };
  const marketLog = path.join(dir, ".dsh-market", "log.ndjson");
  let events = [];
  if (pathExists(marketLog)) {
    events = fs
      .readFileSync(marketLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  if (events.length === 0) findings.notes.push("没有找到市场日志（.dsh-market/log.ndjson），无法判断上次操作停在哪。");

  // Match a start to its finish by PACKAGE NAME over the whole log: an
  // `update-start` names `pkg -> pkg@1.2.3`, while the same work is reported as
  // `install pkg@1.2.3 …`, so a prefix comparison would call every successful
  // update stuck.
  const started = new Map();
  const finishedAt = new Map();
  for (const event of events) {
    const key = registryNameOf(String(event.detail ?? "").split(" ")[0]);
    if (/^(install|update|uninstall)-start$/u.test(event.event)) {
      if (!started.has(key)) started.set(key, event);
    }
    if (/^(install|update|uninstall)$/u.test(event.event)) finishedAt.set(key, event);
  }

  const report = inspectProfile(dir, { installDir });
  const referenced = new Set(report.rows.filter((row) => row.declared !== undefined || row.version !== undefined).map((row) => row.name));

  for (const [name, event] of started) {
    const finish = finishedAt.get(name);
    if (finish !== undefined && Date.parse(finish.at) >= Date.parse(event.at)) continue;
    const entry = { name, at: event.at, event: event.event, pnpmFinished: false, removed: false, logDir: undefined, resolved: !referenced.has(name) };
    const logsRoot = path.join(dir, ".plugin-manager", "logs");
    if (isDirectory(logsRoot)) {
      const startedAt = Date.parse(event.at);
      const near = fs
        .readdirSync(logsRoot, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => ({ entry: item.name, at: fs.statSync(path.join(logsRoot, item.name)).mtimeMs }))
        .filter(({ at }) => !Number.isFinite(startedAt) || Math.abs(at - startedAt) <= 5 * 60 * 1000)
        .sort((a, b) => Math.abs(a.at - startedAt) - Math.abs(b.at - startedAt))
        .slice(0, 1);
      for (const candidate of near) {
        const log = path.join(logsRoot, candidate.entry, "pnpm.log");
        if (!pathExists(log)) continue;
        const text = fs.readFileSync(log, "utf8");
        entry.logDir = candidate.entry;
        entry.pnpmFinished = /\bDone in [\d.]+s/u.test(text);
        entry.removed = /^- /mu.test(text);
      }
    }
    if (entry.resolved) {
      findings.notes.push(`${name}: ${event.at} 的操作没有收尾，但 profile 已不再引用它（那次卡死已被重启清掉）。`);
    } else {
      findings.stuck.push(entry);
    }
  }

  findings.stale = staleArtifacts(dir);
  findings.problems = report.inconsistent.map((row) => ({ name: row.name, problems: row.problems }));
  findings.ok = findings.stuck.length === 0 && findings.stale.length === 0 && findings.problems.length === 0;
  return findings;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function requirePnpm(installDir) {
  const runner = resolvePnpm(installDir);
  if (runner === undefined) {
    throw new Error(
      "找不到可用的 pnpm：DSH 安装目录里没有自带运行时，环境变量 DSH_PNPM_ENTRY 也没有指向可执行文件，PATH 上也没有 pnpm。",
    );
  }
  return runner;
}

/**
 * Clear state that blocks the in-app plugin manager, and make
 * `dsh.profile.bundles` agree with what is actually installed.
 */
function repair(dir, options = {}) {
  const { installDir, dryRun } = options;
  const lines = [];
  let changes = 0;

  for (const item of staleArtifacts(dir)) {
    if (item.alive && item.kind === "file-lock") {
      lines.push({ level: "warn", text: `${item.label} 被仍在运行的进程 ${item.pid} 占用，保留不动` });
      continue;
    }
    if (item.alive && item.kind === "run-record") {
      lines.push({ level: "warn", text: `${item.label} 指向仍在运行的进程 ${item.pid}，保留不动` });
      continue;
    }
    if (dryRun === true) {
      lines.push({ level: "info", text: `将删除${item.label}: ${item.path}` });
      changes += 1;
      continue;
    }
    fs.rmSync(item.path, { force: true });
    lines.push({ level: "ok", text: `已删除${item.label}（进程 ${item.pid ?? "未知"} 已不在）` });
    changes += 1;
  }

  const manifest = readJson(profileManifestPath(dir));
  const bundles = bundleList(manifest);
  const dependencies = manifest.dependencies ?? {};
  const next = [];
  let bundlesChanged = false;

  for (const name of bundles) {
    if (installedManifest(dir, name) === undefined && dependencies[name] === undefined) {
      // Never drop a bundle the installation provides: it resolves from inside
      // the app, so "not in the profile" is its normal state, and removing
      // dsh-base or dsh-web-app leaves a profile that cannot boot.
      if (installationProvides(name, installDir)) {
        next.push(name);
        continue;
      }
      lines.push({ level: "bad", text: `${name}: 列在插件层里，但既没安装也没声明 —— 已从插件层移除` });
      bundlesChanged = true;
      continue;
    }
    next.push(name);
  }
  for (const name of Object.keys(dependencies)) {
    if (isBundle(installedManifest(dir, name)) && !next.includes(name)) {
      lines.push({ level: "ok", text: `${name}: 已安装为插件但不在插件层 —— 已补回 dsh.profile.bundles` });
      next.push(name);
      bundlesChanged = true;
    }
  }

  if (bundlesChanged) {
    if (dryRun === true) lines.push({ level: "info", text: "将重写 dsh.profile.bundles" });
    else {
      setBundleList(manifest, next);
      writeJsonAtomic(profileManifestPath(dir), manifest);
      lines.push({ level: "ok", text: `dsh.profile.bundles 现在有 ${next.length} 项` });
    }
    changes += 1;
  } else {
    lines.push({ level: "ok", text: "dsh.profile.bundles 与磁盘一致" });
  }

  const report = inspectProfile(dir, { installDir });
  const needReinstall = report.inconsistent.filter((row) =>
    row.problems.some((problem) => problem.includes("node_modules 里没有") || problem.includes("构建不完整")),
  );
  for (const row of needReinstall) {
    lines.push({ level: "bad", text: `${row.name}: 需要重新安装 —— 用「安装 / 升级」装回去` });
  }

  return {
    ok: needReinstall.length === 0,
    changes,
    needReinstall: needReinstall.map((row) => ({ name: row.name, version: row.version })),
    lines,
    message:
      needReinstall.length === 0
        ? changes === 0
          ? "没有需要修复的项目"
          : `已修复 ${changes} 处`
        : `已修复 ${changes} 处；${needReinstall.length} 个插件需要重新安装`,
  };
}

function install(dir, spec, options = {}) {
  const { installDir, dryRun, registry } = options;
  if (!SPEC_PATTERN.test(spec)) throw new Error(`拒绝把 ${JSON.stringify(spec)} 交给 pnpm`);
  const name = registryNameOf(spec);
  const lines = [];
  const before = readJson(profileManifestPath(dir));
  const previous = before.dependencies?.[name];

  if (dryRun === true) {
    lines.push({ level: "info", text: `将执行: pnpm add ${spec} ${pnpmFlags({ registry }).join(" ")}` });
    return { ok: true, dryRun: true, name, lines, message: "预览完成" };
  }

  const run = runPnpm(dir, requirePnpm(installDir), ["add", spec, ...pnpmFlags({ registry })]);
  if (run.status !== 0) throw new Error(`pnpm add ${spec} 失败（退出码 ${run.status}）\n${run.output.trim()}`);

  const manifest = readJson(profileManifestPath(dir));
  const onDisk = installedManifest(dir, name);
  if (onDisk === undefined) throw new Error(`pnpm 报告成功，但 ${name} 仍不在 node_modules 里`);
  if (previous === spec && previous === manifest.dependencies?.[name]) {
    lines.push({ level: "info", text: `package.json 原本就固定为 ${previous}，已按该版本重新安装` });
  }
  if (isBundle(onDisk) && !bundleList(manifest).includes(name)) {
    setBundleList(manifest, [...bundleList(manifest), name]);
    writeJsonAtomic(profileManifestPath(dir), manifest);
    lines.push({ level: "ok", text: `已把 ${name} 加入 dsh.profile.bundles` });
  }
  const verdict = check(dir, name, { installDir });
  return { ok: verdict.ok, name, version: onDisk.version, lines: [...lines, ...verdict.lines], message: verdict.message };
}

function update(dir, spec, options = {}) {
  const { installDir, dryRun, registry } = options;
  const name = registryNameOf(spec);
  const explicitVersion = spec === name ? undefined : spec.slice(name.length + 1);
  const lines = [];
  const current = installedVersion(dir, name);
  if (current === undefined) throw new Error(`${name} 没有安装在这个 profile 里；请改用安装`);
  lines.push({ level: "info", text: `${name} 当前版本 ${current}` });

  const target = explicitVersion === undefined ? `${name}@latest` : `${name}@${explicitVersion}`;
  if (dryRun === true) {
    lines.push({ level: "info", text: `将执行: pnpm add ${target} ${pnpmFlags({ registry }).join(" ")}` });
    return { ok: true, dryRun: true, name, from: current, lines, message: "预览完成" };
  }

  const wasBundle = isBundle(installedManifest(dir, name));
  const run = runPnpm(dir, requirePnpm(installDir), ["add", target, ...pnpmFlags({ registry })]);
  if (run.status !== 0) throw new Error(`pnpm add ${target} 失败（退出码 ${run.status}）\n${run.output.trim()}`);

  const after = readJson(profileManifestPath(dir));
  const installed = installedVersion(dir, name);
  if (installed === undefined) throw new Error(`${name} 从 node_modules 里消失了 —— 这个 profile 会起不来`);
  // The bundle row is the difference between "installed" and "loads": the host
  // drops it during a remove, so restore it whenever the package still declares
  // a bundle.
  if (wasBundle && !bundleList(after).includes(name)) {
    setBundleList(after, [...bundleList(after), name]);
    writeJsonAtomic(profileManifestPath(dir), after);
    lines.push({ level: "ok", text: `已补回 ${name} 的插件层条目（宿主在移除时会先删掉它）` });
  }
  if (installed === current) {
    lines.push({ level: "warn", text: `版本仍是 ${current}：registry 上可能没有更新的版本，或新版本被发布等待期挡住` });
  } else {
    lines.push({ level: "ok", text: `已更新 ${current} → ${installed}` });
  }
  const verdict = check(dir, name, { installDir });
  return { ok: verdict.ok, name, from: current, to: installed, lines: [...lines, ...verdict.lines], message: verdict.message };
}

function remove(dir, name, options = {}) {
  const { installDir, dryRun } = options;
  const lines = [];
  const manifest = readJson(profileManifestPath(dir));
  if (manifest.dependencies?.[name] === undefined) throw new Error(`${name} 没有在 package.json 里声明`);

  // Drop the bundle layer FIRST. Left behind, the next boot composes a layer
  // whose package is gone — on Desktop the window then never opens.
  const bundles = bundleList(manifest);
  if (bundles.includes(name)) {
    if (dryRun === true) lines.push({ level: "info", text: "将先移除插件层条目" });
    else {
      setBundleList(manifest, bundles.filter((entry) => entry !== name));
      writeJsonAtomic(profileManifestPath(dir), manifest);
      lines.push({ level: "ok", text: "已移除插件层条目" });
    }
  }
  if (dryRun === true) {
    lines.push({ level: "info", text: `将执行: pnpm remove ${name}` });
    return { ok: true, dryRun: true, name, lines, message: "预览完成" };
  }
  const run = runPnpm(dir, requirePnpm(installDir), ["remove", name, ...pnpmFlags({})]);
  if (run.status !== 0) throw new Error(`pnpm remove ${name} 失败（退出码 ${run.status}）\n${run.output.trim()}`);
  if (installedManifest(dir, name) !== undefined) {
    lines.push({ level: "warn", text: `${name} 仍在 node_modules 里（可能有进程占用着它的文件）` });
  }
  lines.push({ level: "ok", text: `已卸载 ${name}` });
  return { ok: true, name, lines, message: `已卸载 ${name}` };
}

function check(dir, name, options = {}) {
  const manifest = readJson(profileManifestPath(dir));
  const onDisk = installedManifest(dir, name);
  if (onDisk === undefined) {
    return { ok: false, name, lines: [{ level: "bad", text: `${name}: 没有安装` }], message: `${name} 没有安装` };
  }
  const problems = [];
  if (declaresEntry(onDisk) && entryFile(dir, name, onDisk) === undefined) problems.push("声明的入口文件不存在");
  if (isBundle(onDisk) && !bundleList(manifest).includes(name)) problems.push("不在 dsh.profile.bundles 里");
  const missingPatch = missingBundlePatch(dir, name, onDisk);
  if (missingPatch !== null) problems.push(missingPatch.invalid ?? `补丁文件不存在: ${missingPatch.file}`);
  if (manifest.dependencies?.[name] === undefined) problems.push("没有写进 package.json");

  const lines = problems.length === 0
    ? [{ level: "ok", text: `${name}@${onDisk.version} 一致，可正常加载` }]
    : problems.map((problem) => ({ level: "bad", text: `${name}@${onDisk.version}: ${problem}` }));
  return {
    ok: problems.length === 0,
    name,
    version: onDisk.version,
    problems,
    lines,
    message: problems.length === 0 ? `${name}@${onDisk.version} 校验通过` : `${name} 校验未通过: ${problems.join("；")}`,
  };
}

/** One call for the console: inspect + diagnose + the package manager it would use. */
function summarize(dir, options = {}) {
  const installDir = options.installDir;
  const report = inspectProfile(dir, { installDir });
  const runner = resolvePnpm(installDir);
  return {
    profileDir: dir,
    pnpm: runner === undefined ? undefined : { source: runner.source, version: pnpmVersion(runner) },
    dependencies: Object.keys(report.dependencies).length,
    bundles: report.bundles.length,
    rows: report.rows,
    inconsistent: report.inconsistent.map((row) => ({ name: row.name, problems: row.problems })),
    stale: staleArtifacts(dir),
    diagnose: diagnose(dir, { installDir }),
  };
}

function profileDirOf(home, name) {
  return path.join(home, "profiles", name);
}

module.exports = {
  CORE_BUNDLES,
  SPEC_PATTERN,
  bundleList,
  check,
  declaresEntry,
  diagnose,
  entryFile,
  inspectProfile,
  install,
  installDirOf,
  installedVersion,
  isBundle,
  pidAlive,
  profileDirOf,
  registryNameOf,
  remove,
  repair,
  resolvePnpm,
  staleArtifacts,
  summarize,
  update,
};
