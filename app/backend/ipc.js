"use strict";
// The recovery console's controller: it gathers one state object for the
// renderer and executes every mutation behind an explicit IPC channel.
//
// Safety rules enforced here rather than in the UI:
//   * profile mutations are refused while the target application is running,
//     because that application rewrites the profile on shutdown;
//   * destructive steps create a checkpoint first (removals and checkpoints
//     are also individually reversible);
//   * the renderer can only ask the shell to open paths inside known roots.

const path = require("node:path");

const { app, dialog, shell } = require("electron");

const { formatBytes, formatLocalTime, isDirectory, pathExists } = require("./util");
const paths = require("./paths");
const profile = require("./profile");
const checkpoints = require("./checkpoints");
const launcher = require("./launcher");
const diagnostics = require("./diagnostics");
const restartButton = require("./restart-button");
const updater = require("./plugin-updater");

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

class RecoveryController {
  constructor({ version, onState }) {
    this.version = version;
    this.onState = onState;
    this.config = { ...paths.loadConfig().value };
    this.selectedProfile = typeof this.config.profileName === "string" && this.config.profileName !== "" ? this.config.profileName : "desktop";
    this.lastAction = undefined;
    this.lastRestartRun = undefined;
    this.state = undefined;
    this.busy = false;
  }

  // -- persistence ---------------------------------------------------------

  persist(patch) {
    this.config = { ...this.config, ...patch };
    try {
      paths.saveConfig(this.config);
    } catch (error) {
      this.lastAction = { at: new Date().toISOString(), ok: false, message: `保存配置失败: ${describeError(error)}` };
    }
  }

  // -- state ---------------------------------------------------------------

  async gather({ sizes = true } = {}) {
    const config = { ...paths.loadConfig().value, ...this.config };
    const { all, selected } = paths.resolveTargets(config);
    const homeInfo = paths.resolveDshHomeInfo(config.dshHome);
    const home = homeInfo.path;
    const homeExists = isDirectory(home);
    const profileNames = paths.listProfileNames(home);
    if (profileNames.length > 0 && !profileNames.includes(this.selectedProfile)) {
      this.selectedProfile = profileNames.includes("desktop") ? "desktop" : profileNames[0];
    }
    const selectedProfile = this.selectedProfile;

    const profiles = profileNames.map((name) => profile.summarizeProfile(name, home, { sizes }));
    if (!profiles.some((entry) => entry.name === selectedProfile)) {
      profiles.push(profile.summarizeProfile(selectedProfile, home, { sizes }));
    }

    let running = { count: 0, pids: [], mainPids: [], isRunning: false };
    if (typeof selected?.exe === "string") {
      const processes = await launcher.listProcesses(selected);
      running = {
        count: processes.length,
        pids: processes.map((entry) => entry.pid),
        // Electron spawns GPU/renderer/utility children; only the process
        // without `--type=` is the application itself.
        mainPids: processes.filter((entry) => !/--type=/u.test(entry.command ?? "")).map((entry) => entry.pid),
        started: processes[0]?.started,
        isRunning: processes.length > 0,
      };
    }

    const checkpointList = checkpoints.listCheckpoints(home);
    const diagnosticSummary = diagnostics.readDiagnosticsSummary();
    const restartButtonPatch = restartButton.summarize(selected);

    this.state = {
      console: {
        version: this.version,
        root: paths.PROJECT_ROOT,
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        platform: `${process.platform} ${process.arch}`,
      },
      home: {
        path: home,
        exists: homeExists,
        source: homeInfo.source,
        sourceLabel: { config: "由 dsh-recovery.config.json 指定", env: "来自环境变量 DSH_HOME", default: "默认用户目录" }[homeInfo.source] ?? homeInfo.source,
        envValue: homeInfo.envValue || undefined,
        defaultPath: homeInfo.defaultPath,
        profilesDir: paths.profilesDir(home),
        profileNames,
      },
      config: { file: paths.configPath(), ...paths.loadConfig(), value: undefined },
      targets: all.map((target) => ({
        id: target.id,
        kind: target.kind,
        label: target.label,
        appName: target.appName,
        appVersion: target.appVersion,
        electronVersion: target.electronVersion,
        exe: target.exe,
        dir: target.dir,
        resourcesDir: target.resourcesDir,
        hasAsarBackup: target.asarBackupPath !== undefined,
        runtimeVersions: target.runtimeVersions,
        // Manually configured locations can be forgotten again; detected ones
        // simply disappear once uninstalled.
        manual: (config.targets ?? []).some((entry) => entry.id === target.id),
      })),
      selectedTargetId: selected?.id,
      selected,
      running,
      profiles,
      selectedProfile,
      selectedProfileDetail: profiles.find((entry) => entry.name === selectedProfile),
      checkpointRoot: paths.checkpointRootDir(home),
      checkpoints: checkpointList.map((entry) => ({
        ...entry,
        bytesLabel: formatBytes(entry.bytes),
        timeLabel: entry.createdAt === undefined ? undefined : formatLocalTime(entry.createdAt),
      })),
      diagnostics: {
        dir: diagnosticSummary.dir,
        latest: diagnosticSummary.latest,
        count: diagnostics.listDiagnostics().length,
      },
      safeModeHomes: launcher.listSafeModeHomes(),
      restartButton: { ...restartButtonPatch, lastRun: this.lastRestartRun },
      // The in-app market cannot update some plugins (notably itself) and its
      // remove path can hang, so the console offers the same operations against
      // the stopped profile. It is read-only unless a channel below is called.
      pluginUpdater: this.summarizeUpdater(selected, home),
      lastAction: this.lastAction,
      busy: this.busy,
    };
    return this.state;
  }

  async refresh({ sizes = false } = {}) {
    const state = await this.gather({ sizes });
    if (typeof this.onState === "function") this.onState(state);
    return state;
  }

  // -- helpers -------------------------------------------------------------

  requireTarget() {
    const selected = this.state?.selected;
    if (selected === undefined || typeof selected.exe !== "string") throw new Error("尚未确定目标应用，请检查安装路径或 dsh-recovery.config.json");
    return selected;
  }

  requireProfileName() {
    if (typeof this.selectedProfile !== "string" || this.selectedProfile === "") throw new Error("尚未选择 Profile");
    return this.selectedProfile;
  }

  requireIdle() {
    if (this.state?.running?.isRunning === true) {
      throw new Error(`目标应用正在运行（PID ${this.state.running.pids.join(", ")}）。请先停止或重启应用，再修改 Profile —— 否则应用的退出流程会覆盖这些改动。`);
    }
  }

  profileDir() {
    return paths.resolveProfileDir(this.requireProfileName(), this.state.home.path);
  }

  /**
   * The plugin-updater view of the current profile.
   *
   * `gather()` must never fail because of this section: a profile whose
   * manifest cannot be parsed is exactly the profile the console exists for, so
   * every read error is reported as data instead of thrown.
   */
  summarizeUpdater(target, home) {
    const profileDir = path.join(home, "profiles", this.selectedProfile);
    const installDir = updater.installDirOf(target);
    try {
      if (!isDirectory(profileDir)) {
        return { available: false, reason: `Profile 目录不存在: ${profileDir}`, profileDir };
      }
      const summary = updater.summarize(profileDir, { installDir });
      return {
        available: true,
        ...summary,
        installDir,
        // What the panel needs to decide which buttons are live. `running` is
        // read by the renderer from its own state, so nothing here depends on
        // `this.state` being assigned already.
        needsRepair: summary.stale.length > 0 || summary.inconsistent.length > 0,
        updatable: summary.rows.filter((row) => row.version !== undefined && row.declared !== undefined),
      };
    } catch (error) {
      return { available: false, reason: describeError(error), profileDir, installDir };
    }
  }

  /** The profile dir the updater channels act on, refusing anything outside the DSH home. */
  requireUpdaterDir() {
    const dir = this.profileDir();
    if (!isDirectory(dir)) throw new Error(`Profile 目录不存在: ${dir}`);
    return dir;
  }

  requireUpdaterPnpm() {
    const installDir = updater.installDirOf(this.state?.selected);
    const runner = updater.resolvePnpm(installDir);
    if (runner === undefined) {
      throw new Error("找不到可用的 pnpm：DSH 安装目录里没有自带运行时，环境变量 DSH_PNPM_ENTRY 也没有指向可执行文件，PATH 上也没有 pnpm。");
    }
    return installDir;
  }

  /**
   * Run one updater action with the console's safety rules applied:
   * the app must be stopped, the precondition must hold, a checkpoint is taken
   * before anything is written, and the outcome is recorded like every other
   * mutation.
   *
   * `precheck` runs BEFORE the checkpoint and before pnpm is resolved: asking to
   * update a package that is not installed must fail on that fact, not on
   * "no pnpm found", and must not leave an empty checkpoint behind.
   */
  async runUpdater(action, label, mutator, options = {}) {
    return this.perform(label, async () => {
      this.requireIdle();
      const dir = this.requireUpdaterDir();
      if (typeof options.precheck === "function") options.precheck(dir);
      const installDir = updater.installDirOf(this.state?.selected);
      if (options.needsPnpm === true && updater.resolvePnpm(installDir) === undefined) {
        throw new Error(
          "找不到可用的 pnpm：DSH 安装目录里没有自带运行时，环境变量 DSH_PNPM_ENTRY 也没有指向可执行文件，PATH 上也没有 pnpm。",
        );
      }
      const checkpoint = await this.autoCheckpoint(`${label} 之前`);
      const outcome = mutator(dir, installDir);
      return { message: outcome.message ?? `${label} 完成`, updater: outcome, checkpoint: checkpoint.id };
    }, { sizes: true });
  }

  async autoCheckpoint(label) {
    try {
      const created = checkpoints.createCheckpoint({
        home: this.state.home.path,
        profileName: this.requireProfileName(),
        target: this.state.selected,
        trigger: "auto",
        label,
      });
      checkpoints.pruneCheckpoints(this.state.home.path, this.config.maxCheckpoints);
      return created;
    } catch (error) {
      throw new Error(`创建检查点失败，已中止操作: ${describeError(error)}`);
    }
  }

  record(ok, message, detail) {
    this.lastAction = { at: new Date().toISOString(), timeLabel: formatLocalTime(new Date()), ok, message, detail };
  }

  async perform(action, mutator, options = {}) {
    this.busy = true;
    try {
      const result = await mutator();
      this.record(true, result?.message ?? `${action} 完成`, result);
      await this.refresh({ sizes: options.sizes === true });
      return { ok: true, result, state: this.state };
    } catch (error) {
      this.record(false, `${action} 失败: ${describeError(error)}`);
      await this.refresh({ sizes: false });
      return { ok: false, error: describeError(error), state: this.state };
    } finally {
      this.busy = false;
    }
  }

  // -- channels ------------------------------------------------------------

  async dispatch(channel, args = []) {
    switch (channel) {
      case "recovery:status":
        return this.gather({ sizes: false });

      case "recovery:refresh":
        return this.gather({ sizes: true });

      case "recovery:targets":
        return { targets: this.state.targets, selectedTargetId: this.state.selectedTargetId };

      case "recovery:set-target":
        return this.setTarget(String(args[0] ?? ""));

      case "recovery:choose-target":
        return this.chooseTarget({ exe: args[0] === "exe" });

      case "recovery:adopt-target": {
        const outcome = this.adoptTarget(String(args[0] ?? ""));
        if (outcome.ok !== true) return outcome;
        return { ok: true, result: outcome.result, state: await this.refresh({ sizes: true }) };
      }
      case "recovery:forget-target":
        return this.forgetTarget(String(args[0] ?? ""));

      case "recovery:choose-home":
        return this.chooseHome();

      case "recovery:reset-home":
        return this.perform("恢复默认数据目录", async () => {
          this.persist({ dshHome: null });
          return { message: "已改回默认 DSH 数据目录" };
        });

      case "recovery:reset-data":
        return this.resetData();

      case "recovery:profiles":
        return { profiles: this.state.profiles, selectedProfile: this.state.selectedProfile };

      case "recovery:select-profile":
        return this.selectProfile(String(args[0] ?? ""));

      case "recovery:set-bundle-enabled":
        return this.setBundleEnabled(String(args[0] ?? ""), args[1] === true);

      case "recovery:enable-all-bundles":
        return this.enableAllBundles();

      case "recovery:uninstall-bundle":
        return this.uninstallBundle(String(args[0] ?? ""));

      case "recovery:restore-removed":
        return this.restoreRemoved(String(args[0] ?? ""));

      case "recovery:discard-removed":
        return this.discardRemoved(String(args[0] ?? ""));

      case "recovery:sanitize-profile":
        return this.sanitizeProfile();

      case "recovery:open-profile-dir":
        return this.openPath(this.profileDir());

      case "recovery:open-path":
        return this.openPath(String(args[0] ?? ""));

      case "recovery:show-item":
        return this.showItem(String(args[0] ?? ""));

      case "recovery:checkpoints":
        return { checkpoints: this.state.checkpoints };

      case "recovery:create-checkpoint":
        return this.createCheckpoint(typeof args[0] === "string" ? args[0] : undefined);

      case "recovery:restore-checkpoint":
        return this.restoreCheckpoint(String(args[0] ?? ""));

      case "recovery:delete-checkpoint":
        return this.deleteCheckpoint(String(args[0] ?? ""));

      case "recovery:delete-all-checkpoints":
        return this.deleteAllCheckpoints();

      case "recovery:diagnostics":
        return this.diagnosticsSummary();

      case "recovery:export-diagnostics":
        return this.exportDiagnostics();

      case "recovery:launch":
        return this.launchTarget(args[0] ?? {});

      case "recovery:stop":
        return this.stopTarget();

      case "recovery:restart":
        return this.restartTarget(args[0] ?? {});

      case "recovery:restart-button-apply":
        return this.restartButtonApply();

      case "recovery:restart-button-revert":
        return this.restartButtonRevert();

      case "recovery:restart-button-verify":
        return this.restartButtonVerify();

      case "recovery:plugin-updater":
        return this.summarizeUpdater(this.state?.selected, this.state?.home?.path ?? paths.resolveDshHomeInfo(this.config.dshHome).path);

      case "recovery:plugin-repair": {
        const dryRun = args[0] === true;
        if (dryRun) {
          // A preview writes nothing, so it must stay available while the app
          // runs — that is the one thing a dry run is for.
          const dir = this.requireUpdaterDir();
          const outcome = updater.repair(dir, { installDir: updater.installDirOf(this.state?.selected), dryRun: true });
          return { ok: true, result: { message: outcome.message, updater: outcome }, state: this.state };
        }
        return this.runUpdater("修复插件状态", "修复插件状态", (dir, installDir) =>
          updater.repair(dir, { installDir }), { needsPnpm: false });
      }

      case "recovery:plugin-install": {
        const spec = String(args[0] ?? "").trim();
        // The channels answer with { ok: false } instead of throwing: dispatch()
        // is also called directly by --verify, where a throw would abort the run.
        if (spec === "") return { ok: false, error: "缺少要安装的插件名", state: this.state };
        if (args[1] === true) {
          const dir = this.requireUpdaterDir();
          const outcome = updater.install(dir, spec, { installDir: updater.installDirOf(this.state?.selected), dryRun: true });
          return { ok: true, result: { message: outcome.message, updater: outcome }, state: this.state };
        }
        return this.runUpdater(`安装 ${spec}`, `安装 ${spec}`, (dir, installDir) =>
          updater.install(dir, spec, { installDir }), {
          needsPnpm: true,
          precheck: () => {
            if (!updater.SPEC_PATTERN.test(spec)) throw new Error(`拒绝把 ${JSON.stringify(spec)} 交给 pnpm`);
          },
        });
      }

      case "recovery:plugin-update": {
        const spec = String(args[0] ?? "").trim();
        if (spec === "") return { ok: false, error: "缺少要升级的插件名", state: this.state };
        if (args[1] === true) {
          const dir = this.requireUpdaterDir();
          const outcome = updater.update(dir, spec, { installDir: updater.installDirOf(this.state?.selected), dryRun: true });
          return { ok: true, result: { message: outcome.message, updater: outcome }, state: this.state };
        }
        return this.runUpdater(`升级 ${spec}`, `升级 ${spec}`, (dir, installDir) =>
          updater.update(dir, spec, { installDir }), {
          needsPnpm: true,
          // "Not installed" is a fact about the profile, not about pnpm: say it
          // before resolving a package manager or creating a checkpoint.
          precheck: (dir) => {
            const name = updater.registryNameOf(spec);
            if (updater.installedVersion(dir, name) === undefined) {
              throw new Error(`${name} 没有安装在这个 profile 里；请改用安装`);
            }
          },
        });
      }

      case "recovery:plugin-remove": {
        const name = String(args[0] ?? "").trim();
        if (name === "") return { ok: false, error: "缺少要卸载的插件名", state: this.state };
        return this.runUpdater(`卸载 ${name}`, `卸载 ${name}`, (dir, installDir) =>
          updater.remove(dir, name, { installDir }), { needsPnpm: true });
      }

      case "recovery:plugin-check": {
        const name = String(args[0] ?? "").trim();
        const outcome = updater.check(this.requireUpdaterDir(), name, {
          installDir: updater.installDirOf(this.state?.selected),
        });
        this.record(outcome.ok, outcome.message, outcome);
        return { ok: outcome.ok, result: { message: outcome.message, updater: outcome }, state: this.state };
      }

      case "recovery:quit":
        setImmediate(() => app.quit());
        return { ok: true };

      default:
        throw new Error(`未知通道: ${channel}`);
    }
  }

  // -- actions -------------------------------------------------------------

  async setTarget(id) {
    const state = await this.gather({ sizes: false });
    const found = state.targets.find((target) => target.id === id);
    if (found === undefined) return { ok: false, error: `找不到应用: ${id}`, state: this.state };
    this.persist({ targetId: id });
    this.record(true, `已切换目标应用: ${found.label ?? id}`);
    return { ok: true, state: await this.refresh({ sizes: false }) };
  }

  /**
   * Adopt a manually chosen install location. Accepts the install directory,
   * the executable inside it, or the `resources` subdirectory — people point at
   * whichever of those they happened to be looking at. No dialog here, so the
   * `--verify` run can exercise it headlessly.
   */
  adoptTarget(chosen, { persist = true } = {}) {
    const raw = typeof chosen === "string" ? chosen.trim() : "";
    if (raw === "") return { ok: false, error: "没有选择安装位置", state: this.state };
    const absolute = path.resolve(raw);
    const candidates = [];
    const push = (value) => {
      if (typeof value === "string" && value !== "" && !candidates.includes(value)) candidates.push(value);
    };
    push(absolute);
    push(path.dirname(absolute));
    if (path.basename(absolute).toLowerCase() === "resources") push(path.dirname(absolute));

    let inspected;
    let inspectedAt;
    for (const candidate of candidates) {
      if (!isDirectory(candidate)) continue;
      inspected = paths.inspectInstall(candidate);
      if (inspected !== undefined) {
        inspectedAt = candidate;
        break;
      }
    }
    if (inspected === undefined) {
      return {
        ok: false,
        error: `这不是有效的安装位置：${absolute}。需要包含 resources\\app.asar（或 resources\\app\\package.json）以及应用主程序的目录。`,
        state: this.state,
      };
    }

    // Keep the id stable and unique so the target survives in the config file.
    const existing = Array.isArray(this.config.targets) ? this.config.targets : [];
    const clash = existing.find((entry) => entry.id === inspected.id && path.resolve(entry.dir) !== inspected.dir);
    const id = clash === undefined ? inspected.id : `${inspected.id}-2`;
    const entry = {
      id,
      label: `${inspected.label}（${path.basename(inspected.dir)}）`,
      dir: inspected.dir,
    };
    const targets = [...existing.filter((candidate) => path.resolve(candidate.dir) !== inspected.dir), entry];
    // `persist: false` keeps the change in memory only; `--verify` uses it so the
    // real config file stays byte-identical.
    if (persist) this.persist({ targets, targetId: id });
    else this.config = { ...this.config, targets, targetId: id };
    const message = `已指定目标应用：${inspected.exe}`;
    if (persist) this.record(true, message);
    return { ok: true, result: { message, target: { ...inspected, id, label: entry.label }, inspectedAt }, state: this.state };
  }

  /** Pick an install directory or executable through the system file dialog. */
  async chooseTarget({ exe = false } = {}) {
    const current = this.state?.selected;
    const result = await dialog.showOpenDialog({
      title: exe ? "选择 DeepSeek Harness 主程序（.exe）" : "选择 DeepSeek Harness 安装目录",
      defaultPath: exe ? current?.exe ?? current?.dir : current?.dir,
      properties: exe ? ["openFile"] : ["openDirectory"],
      filters: exe ? [{ name: "可执行文件", extensions: ["exe"] }] : undefined,
      buttonLabel: "使用此位置",
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true, state: this.state };
    const outcome = this.adoptTarget(result.filePaths[0]);
    if (outcome.ok !== true) return outcome;
    return { ok: true, result: outcome.result, state: await this.refresh({ sizes: true }) };
  }

  /** Drop a manually configured install location again. */
  async forgetTarget(id, { persist = true } = {}) {
    if (id === "") return { ok: false, error: "缺少应用标识", state: this.state };
    const existing = Array.isArray(this.config.targets) ? this.config.targets : [];
    const kept = existing.filter((entry) => entry.id !== id);
    if (kept.length === existing.length) return { ok: false, error: `没有手动指定的应用: ${id}`, state: this.state };
    if (persist) {
      this.persist({ targets: kept, ...(this.config.targetId === id ? { targetId: null } : {}) });
      this.record(true, `已移除手动指定的安装位置: ${id}`);
    } else {
      this.config = { ...this.config, targets: kept, ...(this.config.targetId === id ? { targetId: null } : {}) };
    }
    const message = `已移除手动指定的安装位置: ${id}`;
    return { ok: true, result: { message }, state: await this.refresh({ sizes: false }) };
  }

  async chooseHome() {
    const result = await dialog.showOpenDialog({
      title: "选择 DSH 数据目录",
      defaultPath: this.state.home.path,
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "使用此目录",
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true, state: this.state };
    const chosen = result.filePaths[0];
    this.persist({ dshHome: chosen });
    this.record(true, `数据目录已切换为 ${chosen}`);
    return { ok: true, state: await this.refresh() };
  }

  async selectProfile(name) {
    if (name === "") return { ok: false, error: "Profile 名称不能为空", state: this.state };
    this.selectedProfile = name;
    this.persist({ profileName: name });
    this.record(true, `已选择 Profile: ${name}`);
    return { ok: true, state: await this.refresh({ sizes: false }) };
  }

  async setBundleEnabled(name, enabled) {
    if (name === "") return { ok: false, error: "缺少插件名", state: this.state };
    return this.perform(enabled ? `启用 ${name}` : `禁用 ${name}`, async () => {
      this.requireIdle();
      const checkpoint = await this.autoCheckpoint(`${enabled ? "启用" : "禁用"} ${name} 之前`);
      const outcome = profile.setBundleEnabled(this.profileDir(), name, enabled);
      return {
        message: `${enabled ? "已启用" : "已禁用"} ${name}`,
        bundleChange: { name, enabled, before: outcome.before, after: outcome.after },
        checkpoint: checkpoint.id,
      };
    });
  }

  // Enables every plugin layer this Profile is allowed to load. Skips are
  // reported, never silent: the message says exactly how many were turned on
  // and why the rest stayed off.
  async enableAllBundles() {
    return this.perform("启用全部插件", async () => {
      this.requireIdle();
      const checkpoint = await this.autoCheckpoint("启用全部插件之前");
      const outcome = profile.enableAllBundles(this.profileDir());
      const patchText = outcome.patchReenabled.length === 0 ? "" : `，并把 cordis.patch.yml 里 ${outcome.patchReenabled.length} 条 disabled: true 改为 false（${outcome.patchReenabled.join("、")}）`;
      if (!outcome.changed) {
        return {
          message: outcome.before.length === 0 ? "该 Profile 没有可启用的插件" : `没有需要启用的插件，当前已启用 ${outcome.before.length} 个`,
          bundles: outcome,
          checkpoint: checkpoint.id,
        };
      }
      const skippedText = outcome.skipped.length === 0 ? "" : `，跳过 ${outcome.skipped.length} 个（${outcome.skipped.map((item) => `${item.name}: ${item.reason}`).join("；")}）`;
      return {
        message: `已启用 ${outcome.enabled.length} 个插件${patchText}${skippedText}，重启应用后生效`,
        bundles: outcome,
        checkpoint: checkpoint.id,
      };
    });
  }

  async uninstallBundle(name) {
    if (name === "") return { ok: false, error: "缺少插件名", state: this.state };
    return this.perform(`卸载 ${name}`, async () => {
      this.requireIdle();
      const checkpoint = await this.autoCheckpoint(`卸载 ${name} 之前`);
      const outcome = profile.uninstallBundle(this.profileDir(), name);
      return {
        message: `已卸载 ${name}${outcome.quarantineId === undefined ? "" : `，文件已移入隔离区（${outcome.quarantineId}）`}`,
        uninstalled: outcome,
        checkpoint: checkpoint.id,
      };
    }, { sizes: true });
  }

  async restoreRemoved(quarantineId) {
    return this.perform(`还原 ${quarantineId}`, async () => {
      this.requireIdle();
      const outcome = profile.restoreRemoved(this.profileDir(), quarantineId);
      return { message: `已还原 ${outcome.name}`, restored: outcome };
    }, { sizes: true });
  }

  async discardRemoved(quarantineId) {
    return this.perform(`删除隔离项 ${quarantineId}`, async () => {
      const outcome = profile.discardRemoved(this.profileDir(), quarantineId);
      return { message: `已永久删除隔离项 ${quarantineId}`, discarded: outcome };
    }, { sizes: true });
  }

  // Moves the whole DSH data directory to the recycle bin, so the next launch
  // initializes a fresh default Profile. The recycle bin keeps this reversible.
  async resetData() {
    return this.perform("重置数据目录", async () => {
      this.requireIdle();
      const home = typeof this.config.dshHome === "string" && this.config.dshHome.trim() !== "" ? this.config.dshHome.trim() : this.state.home.path;
      if (!pathExists(home)) {
        this.persist({ dshHome: null });
        return { message: `数据目录不存在，已改回默认目录: ${home}`, home };
      }
      await shell.trashItem(home);
      this.persist({ dshHome: null });
      return {
        message: `已把 ${home} 移入回收站。重新启动应用会创建新的默认 Profile。`,
        home,
      };
    });
  }

  async sanitizeProfile() {
    return this.perform("重置插件集", async () => {
      this.requireIdle();
      const checkpoint = await this.autoCheckpoint("重置插件集之前");
      const outcome = profile.sanitizeProfile(this.profileDir(), profile.defaultBundles());
      return {
        message: `插件集已重置为 ${outcome.bundlesAfter.join(" + ")}${outcome.movedPatch === undefined ? "" : "，用户补丁已另存为 .bak"}`,
        sanitize: outcome,
        checkpoint: checkpoint.id,
      };
    });
  }

  async createCheckpoint(note) {
    return this.perform("创建检查点", async () => {
      const created = checkpoints.createCheckpoint({
        home: this.state.home.path,
        profileName: this.requireProfileName(),
        target: this.state.selected,
        trigger: "manual",
        label: typeof note === "string" && note !== "" ? note : undefined,
      });
      checkpoints.pruneCheckpoints(this.state.home.path, this.config.maxCheckpoints);
      return { message: `已创建检查点 ${created.id}`, checkpoint: { ...created, bytesLabel: formatBytes(created.bytes) } };
    }, { sizes: true });
  }

  async restoreCheckpoint(id) {
    if (id === "") return { ok: false, error: "缺少检查点 ID", state: this.state };
    return this.perform(`恢复检查点 ${id}`, async () => {
      this.requireIdle();
      const outcome = checkpoints.restoreCheckpoint({
        home: this.state.home.path,
        profileName: this.requireProfileName(),
        id,
        target: this.state.selected,
      });
      return {
        message: `已从 ${id} 恢复 ${outcome.restored.length} 个文件；恢复前状态保存为 ${outcome.preRestoreId}`,
        restore: outcome,
      };
    });
  }

  async deleteCheckpoint(id) {
    return this.perform(`删除检查点 ${id}`, async () => {
      const outcome = checkpoints.deleteCheckpoint(this.state.home.path, id);
      return { message: `已删除检查点 ${id}`, deleted: outcome };
    });
  }

  // Clears every checkpoint slot in one pass. Locked slots are reported instead
  // of failing the whole sweep, so the UI can tell the user what survived.
  async deleteAllCheckpoints() {
    return this.perform("删除全部检查点", async () => {
      this.requireIdle();
      const outcome = checkpoints.deleteAllCheckpoints(this.state.home.path);
      if (outcome.removed.length === 0 && outcome.failed.length === 0) {
        return { message: "没有可删除的检查点", deleted: outcome };
      }
      const sizeText = outcome.removed.length === 0 ? "" : `，释放 ${formatBytes(outcome.bytes)}`;
      const failText = outcome.failed.length === 0 ? "" : `，${outcome.failed.length} 个删除失败（${outcome.failed.map((item) => `${item.id}: ${item.error}`).join("；")}）`;
      return {
        message: `已删除 ${outcome.removed.length} 个检查点${sizeText}${failText}`,
        deleted: outcome,
      };
    }, { sizes: true });
  }

  diagnosticsSummary() {
    const list = diagnostics.listDiagnostics();
    return {
      dir: diagnostics.diagnosticsDir(),
      latest: list[0],
      count: list.length,
      recent: list.slice(0, 10).map((entry) => ({ ...entry, bytesLabel: formatBytes(entry.bytes), timeLabel: formatLocalTime(entry.modifiedAt) })),
    };
  }

  async exportDiagnostics() {
    return this.perform("生成诊断包", async () => {
      const state = this.state;
      const exported = diagnostics.exportDiagnostics({
        homeInfo: { ...paths.resolveDshHomeInfo(this.config.dshHome) },
        home: state.home.path,
        profiles: state.profiles,
        checkpoints: state.checkpoints,
        targets: state.targets,
        selected: state.selected,
        running: state.running,
        safeModeHomes: state.safeModeHomes,
        consoleVersion: this.version,
      });
      return {
        message: `诊断包已生成: ${path.basename(exported.file)}（${formatBytes(exported.bytes)}，${exported.entryCount} 个文件）`,
        diagnostics: { ...exported, bytesLabel: formatBytes(exported.bytes), name: path.basename(exported.file) },
        warnings: exported.warnings,
      };
    });
  }

  async launchTarget(options) {
    const mode = options?.mode === "safe" ? "safe" : "normal";
    return this.perform(mode === "safe" ? "以安全模式启动" : "启动应用", async () => {
      const target = this.requireTarget();
      if (this.state.running.isRunning) {
        return { message: `应用已在运行（PID ${this.state.running.pids.join(", ")}），未重复启动` };
      }
      const env = {};
      let safeHome;
      if (mode === "safe") {
        safeHome = launcher.prepareSafeModeHome();
        env.DSH_HOME = safeHome;
      }
      const launched = launcher.launch(target, { env });
      return {
        message: mode === "safe" ? `已使用临时数据目录启动: ${safeHome}` : `已启动 ${target.exe}`,
        launch: { ...launched, mode, safeHome },
      };
    });
  }

  async stopTarget() {
    return this.perform("停止应用", async () => {
      const outcome = await launcher.stop(this.requireTarget(), {});
      if (!outcome.wasRunning) return { message: "应用当前未运行" };
      return {
        message: outcome.graceful ? `已正常退出（PID ${outcome.stopped.join(", ")}）` : `已强制结束（PID ${outcome.forced.join(", ")}）`,
        stop: outcome,
      };
    });
  }

  async restartTarget(options) {
    const mode = options?.mode === "safe" ? "safe" : "normal";
    return this.perform(mode === "safe" ? "以安全模式重启" : "重启应用", async () => {
      const target = this.requireTarget();
      const stopOutcome = await launcher.stop(target, {});
      const env = {};
      let safeHome;
      if (mode === "safe") {
        safeHome = launcher.prepareSafeModeHome();
        env.DSH_HOME = safeHome;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 600);
      });
      const launched = launcher.launch(target, { env });
      return {
        message: `${stopOutcome.wasRunning ? (stopOutcome.graceful ? "已正常退出并" : "已强制结束并") : ""}重新启动`,
        restart: { stop: stopOutcome, launch: { ...launched, mode, safeHome } },
      };
    });
  }

  // -- restart button patch ------------------------------------------------

  /**
   * Remembers the log of the last patch command so the panel can show what
   * happened, then hands the outcome back to the caller.
   */
  rememberRestartRun(outcome) {
    this.lastRestartRun = {
      at: new Date().toISOString(),
      timeLabel: formatLocalTime(new Date()),
      action: outcome.action,
      ok: outcome.ok === true,
      message: outcome.message,
      archive: outcome.archive,
      lines: Array.isArray(outcome.lines) ? outcome.lines : [],
    };
    return outcome;
  }

  /**
   * Both patch entries keep their original byte length, so an install may run
   * while the target application is open: the offsets it already read stay
   * valid and the new menu appears after the next restart. Profile style
   * `requireIdle` guards therefore do not apply here.
   */
  async restartButtonApply() {
    return this.perform("安装重启按钮补丁", async () => {
      const outcome = this.rememberRestartRun(restartButton.apply(this.requireTarget()));
      if (!outcome.ok) throw new Error(outcome.message);
      return { message: outcome.message, restartButton: { changed: outcome.changed, archive: outcome.archive } };
    });
  }

  async restartButtonRevert() {
    return this.perform("还原重启按钮补丁", async () => {
      const outcome = this.rememberRestartRun(restartButton.revert(this.requireTarget()));
      if (!outcome.ok) throw new Error(outcome.message);
      return { message: outcome.message, restartButton: { touched: outcome.touched, archive: outcome.archive } };
    });
  }

  async restartButtonVerify() {
    return this.perform("校验重启按钮补丁", async () => {
      const outcome = this.rememberRestartRun(restartButton.verify(this.requireTarget()));
      if (!outcome.ok) throw new Error(outcome.message);
      return { message: outcome.message, restartButton: { entries: outcome.entries, archive: outcome.archive } };
    });
  }

  // -- shell ---------------------------------------------------------------

  allowedOpenRoots() {
    const roots = [paths.PROJECT_ROOT];
    if (this.state !== undefined) {
      roots.push(this.state.home.path, this.state.home.profilesDir);
      if (typeof this.state.selected?.dir === "string") roots.push(this.state.selected.dir);
      roots.push(paths.checkpointRootDir(this.state.home.path), paths.removedRootDir(this.state.home.path));
    }
    roots.push(launcher.safeModeRoot(), diagnostics.diagnosticsDir());
    return roots.filter((root) => typeof root === "string" && path.isAbsolute(root));
  }

  assertOpenable(target) {
    if (target === "") throw new Error("缺少路径");
    const resolved = path.resolve(target);
    if (!pathExists(resolved)) throw new Error(`路径不存在: ${resolved}`);
    if (!this.allowedOpenRoots().some((root) => isWithin(root, resolved))) {
      throw new Error(`为安全起见，恢复器只打开已知目录内的路径: ${resolved}`);
    }
    return resolved;
  }

  async openPath(target) {
    const resolved = this.assertOpenable(target);
    if (isDirectory(resolved)) {
      const error = await shell.openPath(resolved);
      if (error !== "") return { ok: false, error, state: this.state };
      return { ok: true, state: this.state, result: { opened: resolved } };
    }
    const error = await shell.openPath(resolved);
    if (error !== "") return { ok: false, error, state: this.state };
    return { ok: true, state: this.state, result: { opened: resolved } };
  }

  showItem(target) {
    const resolved = this.assertOpenable(target);
    shell.showItemInFolder(resolved);
    return { ok: true, state: this.state, result: { revealed: resolved } };
  }
}

module.exports = { RecoveryController };
