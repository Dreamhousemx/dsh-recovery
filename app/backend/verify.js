"use strict";
// `--verify`: end-to-end self test of the *mutating* actions (插件管理 / 回滚 /
// 启动·停止), run against a throwaway fixture inside `.runtime\verify-*`.
//
// It must never touch the real DSH home, the installed application, or the
// console's own config file: the fixture is a synthetic install plus a synthetic
// profile, and every check runs with the controller pointed at that fixture.
// The real config file is byte-compared before and after as an invariant.

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const launcher = require("./launcher");
const paths = require("./paths");
const { withoutAsar } = require("./asar");
const { ensureDir, isDirectory, isFile, readJson, removeEntry, writeJsonAtomic } = require("./util");

const FIXTURE_PROFILE = "demo";
const FIXTURE_BUNDLE = "fake-bundle";
const FIXTURE_DEP = "fake-dep";
const CORE_BUNDLE = "@deepseek-ai/dsh-base";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(120);
  }
  return predicate();
}

// sha256 of a raw file, read in chunks. Must run inside `withoutAsar` when the
// file is an archive: Electron's patched fs otherwise reports `app.asar` as a
// directory and reads archive members instead of the raw pickle (see asar.js).
function hashFileSync(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

// The official `resources\app.asar` this checkout ships, taken from the state
// resolved with the real config *before* the controller is pointed at the
// fixture. Returns the digest the archive must still have afterwards, or a
// `problem` describing why the invariant could not be established.
function realArchive(targets, stamp) {
  const harness = (targets ?? []).find(
    (entry) => entry.kind === "deepseek-harness" && typeof entry.resourcesDir === "string" && !String(entry.dir).includes(stamp),
  );
  const file = harness === undefined ? undefined : path.join(harness.resourcesDir, "app.asar");
  if (file === undefined) return { problem: `未找到 deepseek-harness 目标（共 ${targets?.length ?? 0} 个）` };
  return withoutAsar(() => {
    if (!isFile(file)) return { problem: `app.asar 不存在：${file}` };
    try {
      return { file, size: fs.statSync(file).size, sha256: hashFileSync(file) };
    } catch (error) {
      return { problem: `无法读取 app.asar：${file} ${error instanceof Error ? error.message : String(error)}` };
    }
  });
}

function report() {
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
    return ok;
  };
  return {
    checks,
    ok(name, condition, detail) {
      return add(name, condition === true, detail);
    },
    fail(name, detail) {
      return add(name, false, detail);
    },
    get passed() {
      return checks.filter((entry) => entry.ok).length;
    },
    get failed() {
      return checks.filter((entry) => entry.ok !== true).length;
    },
  };
}

function snapshotFile(file) {
  try {
    return { exists: true, bytes: fs.readFileSync(file) };
  } catch {
    return { exists: false };
  }
}

function unchanged(file, before) {
  const after = snapshotFile(file);
  if (before.exists !== after.exists) return false;
  return !before.exists || before.bytes.equals(after.bytes);
}

function errorText(response) {
  return typeof response?.error === "string" && response.error !== "" ? response.error : undefined;
}

/** Locate a stub executable that can run a short, observable command. */
function stubExecutable() {
  const candidates = [
    process.env.SystemRoot === undefined ? undefined : path.join(process.env.SystemRoot, "System32", "cmd.exe"),
    "C:\\Windows\\System32\\cmd.exe",
  ].filter((entry) => typeof entry === "string");
  return candidates.find((entry) => isFile(entry));
}

/**
 * Build the fixture: a synthetic install (so target detection finds it without
 * touching the real one) plus a synthetic Harness home with two packages.
 */
function buildFixture(root) {
  const installDir = path.join(root, "install");
  const home = path.join(root, "home");
  const profileDir = path.join(home, "profiles", FIXTURE_PROFILE);
  const work = path.join(root, "work");

  ensureDir(path.join(installDir, "resources", "app"));
  ensureDir(path.join(profileDir, "node_modules", FIXTURE_BUNDLE));
  ensureDir(path.join(profileDir, "node_modules", FIXTURE_DEP));
  ensureDir(work);
  fs.copyFileSync(stubExecutable(), path.join(installDir, "verify-stub.exe"));
  fs.writeFileSync(path.join(installDir, "version"), "44.0.0\n");
  writeJsonAtomic(path.join(installDir, "resources", "app", "package.json"), {
    name: "@deepseek-ai/dsh-desktop",
    version: "0.0.0-verify",
    description: "dsh-recovery --verify fixture; not a real installation",
  });
  writeJsonAtomic(path.join(profileDir, "package.json"), {
    name: `dsh-profile-${FIXTURE_PROFILE}`,
    private: true,
    dependencies: { [FIXTURE_BUNDLE]: "1.0.0", [FIXTURE_DEP]: "1.0.0" },
    dsh: { profile: { bundles: [FIXTURE_BUNDLE] } },
  });
  writeJsonAtomic(path.join(profileDir, "node_modules", FIXTURE_BUNDLE, "package.json"), {
    name: FIXTURE_BUNDLE,
    version: "1.0.0",
    dsh: { bundle: { patch: "./patch.yml" } },
  });
  writeJsonAtomic(path.join(profileDir, "node_modules", FIXTURE_DEP, "package.json"), {
    name: FIXTURE_DEP,
    version: "1.0.0",
  });
  fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), `- id: fake-row\n  name: ${FIXTURE_BUNDLE}\n`);

  return { installDir, home, profileDir, work };
}

async function verifyPluginManagement(controller, fixture, result) {
  const manifestPath = path.join(fixture.profileDir, "package.json");
  const bundlesOf = (state) => state.selectedProfileDetail?.bundles ?? [];

  const disabled = await controller.dispatch("recovery:set-bundle-enabled", [FIXTURE_BUNDLE, false]);
  result.ok(
    "插件管理: 禁用组合包",
    disabled.ok === true && !bundlesOf(disabled.state).includes(FIXTURE_BUNDLE),
    errorText(disabled),
  );
  const afterDisable = readJson(manifestPath);
  result.ok(
    "插件管理: 禁用写入 package.json",
    afterDisable.ok === true && !(afterDisable.value?.dsh?.profile?.bundles ?? []).includes(FIXTURE_BUNDLE),
    afterDisable.error,
  );

  const enabled = await controller.dispatch("recovery:set-bundle-enabled", [FIXTURE_BUNDLE, true]);
  result.ok(
    "插件管理: 重新启用组合包",
    enabled.ok === true && bundlesOf(enabled.state).includes(FIXTURE_BUNDLE),
    errorText(enabled),
  );

  const coreGuard = await controller.dispatch("recovery:set-bundle-enabled", [CORE_BUNDLE, false]);
  result.ok(
    "插件管理: 拒绝禁用核心组件",
    coreGuard.ok === false && /不能禁用/u.test(errorText(coreGuard) ?? ""),
    errorText(coreGuard),
  );

  const nonBundle = await controller.dispatch("recovery:set-bundle-enabled", [FIXTURE_DEP, true]);
  result.ok(
    "插件管理: 拒绝启用非组合包",
    nonBundle.ok === false && /不是插件组合包/u.test(errorText(nonBundle) ?? ""),
    errorText(nonBundle),
  );

  const uninstalled = await controller.dispatch("recovery:uninstall-bundle", [FIXTURE_BUNDLE]);
  const quarantineId = uninstalled.result?.uninstalled?.quarantineId;
  const quarantineDir = typeof quarantineId === "string"
    ? path.join(fixture.profileDir, paths.RECOVERY_STATE_DIR_NAME, "removed", quarantineId)
    : undefined;
  result.ok(
    "插件管理: 卸载移入隔离区",
    uninstalled.ok === true &&
      quarantineDir !== undefined &&
      isFile(path.join(quarantineDir, "meta.json")) &&
      !fs.existsSync(path.join(fixture.profileDir, "node_modules", FIXTURE_BUNDLE)) &&
      (uninstalled.state.selectedProfileDetail?.removed ?? []).some((entry) => entry.id === quarantineId),
    errorText(uninstalled) ?? quarantineId,
  );

  const restored = await controller.dispatch("recovery:restore-removed", [quarantineId]);
  result.ok(
    "插件管理: 从隔离区还原",
    restored.ok === true &&
      isFile(path.join(fixture.profileDir, "node_modules", FIXTURE_BUNDLE, "package.json")) &&
      (restored.state.selectedProfileDetail?.removed ?? []).length === 0,
    errorText(restored),
  );

  const discardedTarget = await controller.dispatch("recovery:uninstall-bundle", [FIXTURE_DEP]);
  const discardId = discardedTarget.result?.uninstalled?.quarantineId;
  const discarded = await controller.dispatch("recovery:discard-removed", [discardId]);
  result.ok(
    "插件管理: 永久删除隔离项",
    discarded.ok === true &&
      !fs.existsSync(path.join(fixture.profileDir, paths.RECOVERY_STATE_DIR_NAME, "removed", String(discardId))),
    errorText(discarded),
  );
}

async function verifyCheckpoints(controller, fixture, result) {
  const manifestPath = path.join(fixture.profileDir, "package.json");
  const patchPath = path.join(fixture.profileDir, "cordis.patch.yml");

  const created = await controller.dispatch("recovery:create-checkpoint", ["verify"]);
  const id = created.result?.checkpoint?.id;
  const listed = (created.state?.checkpoints ?? []).find((entry) => entry.id === id);
  result.ok(
    "回滚: 创建检查点",
    created.ok === true && typeof id === "string" && listed !== undefined && listed.metaValid === true && listed.files.length >= 2,
    errorText(created) ?? JSON.stringify(listed?.files),
  );

  const manifestBefore = snapshotFile(manifestPath);
  const patchBefore = snapshotFile(patchPath);
  fs.writeFileSync(patchPath, "- id: broken-by-verify\n  disabled: true\n");
  const mutated = readJson(manifestPath);
  if (mutated.ok) {
    mutated.value.dsh = { profile: { bundles: [] } };
    writeJsonAtomic(manifestPath, mutated.value);
  }
  result.ok(
    "回滚: 检查点确实早于损坏状态",
    !snapshotFile(patchPath).bytes.equals(patchBefore.bytes) && !snapshotFile(manifestPath).bytes.equals(manifestBefore.bytes),
  );

  const restored = await controller.dispatch("recovery:restore-checkpoint", [id]);
  result.ok("回滚: 恢复检查点", restored.ok === true, errorText(restored));
  result.ok("回滚: 补丁文件被还原", unchanged(patchPath, patchBefore));
  result.ok("回滚: 插件清单被还原", unchanged(manifestPath, manifestBefore));
  const preRestoreId = restored.result?.restore?.preRestoreId;
  result.ok(
    "回滚: 恢复前自动保存现场",
    typeof preRestoreId === "string" && (restored.state?.checkpoints ?? []).some((entry) => entry.id === preRestoreId && entry.trigger === "pre-restore"),
    preRestoreId,
  );

  const deleted = await controller.dispatch("recovery:delete-checkpoint", [id]);
  result.ok(
    "回滚: 删除检查点",
    deleted.ok === true && (deleted.state?.checkpoints ?? []).every((entry) => entry.id !== id),
    errorText(deleted),
  );
}

async function verifyLaunch(controller, fixture, result, archive) {
  const target = controller.state.selected;
  const marker = path.join(fixture.work, "env.txt");

  // Safe mode = "run the app against a throwaway home". Prove both halves: the
  // temporary home really is handed to the child process, and the child really
  // starts.
  //
  // The stub is cmd.exe, so the child reports what it can: `set DSH_` dumps the
  // environment it was started with into a file. The redirection target stays
  // relative on purpose - cmd.exe cannot be handed an absolute path into a
  // directory whose name contains a space through Node's spawn argument
  // quoting, and the fixture lives under a "DeepSeek Harness" directory.
  const safeHome = launcher.prepareSafeModeHome();
  result.ok("启动: 安全模式临时目录位于 .safemode", safeHome.startsWith(launcher.safeModeRoot()), safeHome);
  const spawned = launcher.launch(target, {
    args: ["/c", "set DSH_>env.txt"],
    env: { DSH_HOME: safeHome },
    cwd: fixture.work,
  });
  const wrote = await waitFor(() => isFile(marker), 5000);
  const markerValue = wrote ? fs.readFileSync(marker, "utf8").trim() : "";
  result.ok("启动: 进程真的被拉起", Number.isFinite(spawned.pid) && wrote, `pid=${spawned.pid} ${markerValue.replace(/\s+/gu, " ")}`);
  result.ok("启动: 安全模式数据目录传给子进程", markerValue.includes(`DSH_HOME=${safeHome}`), markerValue.replace(/\s+/gu, " "));

  const launchChannel = await controller.dispatch("recovery:launch", [{ mode: "safe" }]);
  result.ok(
    "启动: 安全模式通道返回临时目录",
    launchChannel.ok === true && typeof launchChannel.result?.launch?.safeHome === "string",
    errorText(launchChannel),
  );

  // Stop: the console must find this instance by exact executable path and
  // force-kill it when it does not close itself.
  const sleeper = launcher.launch(target, { args: ["/c", "ping -n 30 127.0.0.1 >nul"], cwd: fixture.work });
  await sleep(800);
  const stopped = await launcher.stop(target, { timeoutMs: 1500 });
  result.ok(
    "停止: 按可执行文件精确匹配并结束进程",
    stopped.wasRunning === true && stopped.stopped.includes(sleeper.pid) && stopped.alive.length === 0,
    JSON.stringify(stopped),
  );

  const stopChannel = await controller.dispatch("recovery:stop", []);
  result.ok(
    "停止: 未运行时安全返回",
    stopChannel.ok === true && stopChannel.result?.message === "应用当前未运行",
    errorText(stopChannel) ?? stopChannel.result?.message,
  );

  // The console itself must not have touched the real installation. This is the
  // hard constraint of the whole project: the official app.asar must be
  // byte-identical after every action this run exercised.
  if (archive.problem !== undefined) {
    result.fail("安装目录: 未找到官方 app.asar 用于不变性检查", `${archive.problem}；targets=${controller.state.targets.map((entry) => `${entry.kind}@${entry.dir}`).join(", ")}`);
  } else {
    const after = withoutAsar(() => ({ size: fs.statSync(archive.file).size, sha256: hashFileSync(archive.file) }));
    result.ok(
      "安装目录: 官方 app.asar 字节未被本次验证改动",
      after.size === archive.size && after.sha256 === archive.sha256,
      `${archive.file} size=${after.size} sha256=${after.sha256.slice(0, 16)}…`,
    );
  }
}

async function runVerify({ version, targets }) {
  const result = report();
  const startedAt = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  const root = path.join(paths.PROJECT_ROOT, ".runtime", `verify-${stamp}`);
  const configFile = paths.configPath();
  const configBefore = snapshotFile(configFile);
  const archive = await realArchive(targets, stamp);
  const fixture = buildFixture(root);
  let safeHome;
  let diagnosticsFile;

  const { RecoveryController } = require("./ipc");
  try {
    const controller = new RecoveryController({ version });
    // Point the controller at the fixture in memory only: nothing is persisted,
    // so the real config file keeps whatever the user selected.
    controller.config = {
      ...controller.config,
      dshHome: fixture.home,
      profileName: FIXTURE_PROFILE,
      targetId: "verify-fixture",
      maxCheckpoints: 20,
      targets: [{ id: "verify-fixture", label: "Verify Fixture", dir: fixture.installDir }],
    };
    await controller.refresh({ sizes: true });

    const state = controller.state;
    result.ok("目标: 解析到 fixture 安装目录", state.selected?.id === "verify-fixture", state.selected?.exe);
    result.ok("运行状态: fixture 未被判定为运行中", state.running.isRunning === false);
    result.ok("数据目录: 使用 fixture home", state.home.path === fixture.home, state.home.path);
    result.ok(
      "Profile: 清单与补丁均可解析",
      state.selectedProfileDetail?.manifestError === undefined &&
        state.selectedProfileDetail?.patchError === undefined &&
        state.selectedProfileDetail?.bundles.includes(FIXTURE_BUNDLE) === true,
      state.selectedProfileDetail?.manifestError ?? state.selectedProfileDetail?.patchError,
    );

    await verifyPluginManagement(controller, fixture, result);
    await verifyCheckpoints(controller, fixture, result);
    await verifyLaunch(controller, fixture, result, archive);

    const exported = await controller.dispatch("recovery:export-diagnostics", []);
    diagnosticsFile = exported.result?.diagnostics?.file;
    result.ok(
      "诊断: 生成诊断包",
      exported.ok === true &&
        isFile(exported.result?.diagnostics?.file ?? "") &&
        Number.isFinite(exported.result?.diagnostics?.entryCount),
      errorText(exported) ?? exported.result?.diagnostics?.name,
    );

    result.ok("不变性: 控制台配置未被改写", unchanged(configFile, configBefore), configFile);
    safeHome = controller.state.safeModeHomes[0]?.dir;
  } catch (error) {
    result.fail("verify: 未捕获异常", error instanceof Error ? `${error.message}` : String(error));
  } finally {
    try {
      removeEntry(root);
    } catch (error) {
      result.fail("verify: 无法清理 fixture", error instanceof Error ? error.message : String(error));
    }
    for (const entry of launcher.listSafeModeHomes()) {
      // Only remove the throwaway homes this run created.
      if (entry.id >= stamp.replace(/[:.]/gu, "-")) {
        try {
          removeEntry(entry.dir);
        } catch {}
      }
    }
    // The diagnostics package describes the fixture, so it is a throwaway too.
    if (diagnosticsFile !== undefined) {
      try {
        removeEntry(diagnosticsFile);
      } catch {}
    }
  }

  return {
    root: { cleaned: !isDirectory(root), safeHome },
    checks: result.checks,
    passed: result.passed,
    failed: result.failed,
  };
}

module.exports = { runVerify };
