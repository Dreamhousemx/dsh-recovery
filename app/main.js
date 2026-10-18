"use strict";
// DSH Recovery — Electron entry point.
//
// This console is deliberately self-contained: it does not load the DSH
// runtime, any profile bundle, or any third-party module. It only needs to
// read and repair a Harness home, so it keeps working when the profile it is
// repairing cannot boot.

const path = require("node:path");
const fs = require("node:fs");

const { app, BrowserWindow, ipcMain, shell } = require("electron");

const { RecoveryController } = require("./backend/ipc");
const { PROJECT_ROOT } = require("./backend/paths");
const { runVerify } = require("./backend/verify");

// Keep the console's Chromium profile inside the tool instead of polluting
// AppData, so removing the folder removes every trace of it.
app.setPath("userData", path.join(PROJECT_ROOT, ".runtime", "userdata"));

const CHANNELS = [
  "recovery:status",
  "recovery:refresh",
  "recovery:targets",
  "recovery:set-target",
  "recovery:choose-target",
  "recovery:adopt-target",
  "recovery:forget-target",
  "recovery:choose-home",
  "recovery:reset-home",
  "recovery:reset-data",
  "recovery:profiles",
  "recovery:select-profile",
  "recovery:set-bundle-enabled",
  "recovery:enable-all-bundles",
  "recovery:uninstall-bundle",
  "recovery:restore-removed",
  "recovery:discard-removed",
  "recovery:sanitize-profile",
  "recovery:open-profile-dir",
  "recovery:open-path",
  "recovery:show-item",
  "recovery:checkpoints",
  "recovery:create-checkpoint",
  "recovery:restore-checkpoint",
  "recovery:delete-checkpoint",
  "recovery:delete-all-checkpoints",
  "recovery:diagnostics",
  "recovery:export-diagnostics",
  "recovery:restart-button-apply",
  "recovery:restart-button-revert",
  "recovery:restart-button-verify",
  "recovery:launch",
  "recovery:stop",
  "recovery:restart",
  "recovery:quit",
];

let controller;
let mainWindow;

// `--self-check` runs the whole read pipeline (targets, home, profiles,
// checkpoints, diagnostics) without opening a window, prints a compact digest
// and exits non-zero when something looks unrecoverable. It is the smoke test
// CI or a user can run after updating the installed application.
const selfCheck = process.argv.includes("--self-check");

// `--verify` exercises the destructive actions (disable/uninstall bundles,
// create/restore/delete checkpoints, launch/stop) against a throwaway fixture
// under `.runtime\verify-*`, then proves `recovery:quit` really exits. It never
// reads or writes the real DSH home, the installed application or the config.
const verify = process.argv.includes("--verify");

// `--ui-check` opens the window like a normal run, drives the renderer (clicks
// the restart-button tab), saves a screenshot and exits. It is the end-to-end
// check that index.html really loads app.js and that the backend state reaches
// a panel: a missing <script> tag once shipped a blank window that no headless
// check can see.
const uiCheck = process.argv.includes("--ui-check");

// Both headless modes run without a window and must work while a console window is open.
const headless = selfCheck || verify;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the console window to exist and finish loading, or throws. */
async function waitForWindow(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (mainWindow === undefined) {
    if (Date.now() > deadline) throw new Error(`窗口未在 ${timeoutMs} 毫秒内创建`);
    await sleep(50);
  }
  while (mainWindow.webContents.isLoading()) {
    if (Date.now() > deadline) throw new Error(`页面未在 ${timeoutMs} 毫秒内加载完成`);
    await sleep(50);
  }
  return mainWindow;
}

/**
 * End-to-end UI check: renders the app, clicks through to the restart-button
 * panel and proves the panel, its buttons and the preload bridge are there.
 */
async function runUiCheck({ shot }) {
  const issues = [];
  const win = await waitForWindow(20000);
  // app.js waits for `api.status()` before its first render; give it a moment.
  await sleep(900);

  const before = await win.webContents.executeJavaScript(
    "({ tabs: [...document.querySelectorAll('#tabs [data-action=\"tab\"]')].map((node) => node.textContent), bridge: Object.keys(window.recovery ?? {}), panelCount: document.querySelectorAll('.panel').length, active: document.querySelector('.panel[data-active=\"true\"]')?.dataset.panel ?? null })",
  );
  if (before.tabs.length !== 7) issues.push(`页签数量为 ${before.tabs.length}，期望 7`);
  if (!before.tabs.some((label) => label.includes("重启按钮"))) issues.push("页签中没有「重启按钮」");
  if (before.panelCount !== 7) issues.push(`面板数量为 ${before.panelCount}，期望 7`);
  for (const method of ["restartButtonApply", "restartButtonRevert", "restartButtonVerify", "enableAllBundles", "deleteAllCheckpoints", "chooseTarget", "adoptTarget", "forgetTarget"]) {
    if (!before.bridge.includes(method)) issues.push(`preload 桥缺少 ${method}`);
  }

  // The two one-click actions must be reachable from their panels, not just
  // present in the bridge.
  const panelProbe =
    "((id) => { const node = document.querySelector(`.panel[data-panel=\"${id}\"]`); return node === null ? null : { text: node.innerText, actions: [...node.querySelectorAll('button[data-action]')].map((b) => ({ action: b.dataset.action, label: b.textContent, disabled: b.disabled })) }; })";
  const pluginsPanel = await win.webContents.executeJavaScript(`${panelProbe}("plugins")`);
  if (pluginsPanel === null) issues.push("找不到「插件管理」面板");
  else if (!pluginsPanel.actions.some((button) => button.action === "enable-all-bundles")) issues.push("插件管理面板缺少「一键启用全部插件」按钮");
  const checkpointsPanel = await win.webContents.executeJavaScript(`${panelProbe}("checkpoints")`);
  if (checkpointsPanel === null) issues.push("找不到「回滚」面板");
  else {
    const sweep = checkpointsPanel.actions.find((button) => button.action === "delete-all-checkpoints");
    if (sweep === undefined) issues.push("回滚面板缺少「一键删除全部」按钮");
    else if (checkpointsPanel.text.includes("还没有检查点") && sweep.disabled !== true) issues.push("没有检查点时「一键删除全部」按钮仍可点击");
  }

  // Pointing the console at an install that auto-detection missed must be
  // reachable from the diagnostics panel even when only one install is known.
  const diagnosticsPanel = await win.webContents.executeJavaScript(`${panelProbe}("diagnostics")`);
  if (diagnosticsPanel === null) issues.push("找不到「诊断」面板");
  else {
    for (const action of ["choose-target", "choose-target-exe"]) {
      if (!diagnosticsPanel.actions.some((button) => button.action === action)) issues.push(`诊断面板缺少按钮 ${action}`);
    }
  }

  await win.webContents.executeJavaScript("document.querySelector('[data-action=\"tab\"][data-arg=\"restart\"]').click()");
  await sleep(400);

  // Capture each panel that gained a one-click button (plus the overview
  // panel), so a ui-check run also leaves visual evidence for those screens.
  const extraShots = {};
  for (const [panelId, suffix] of [["quick", "quick"], ["plugins", "plugins"], ["checkpoints", "checkpoints"], ["diagnostics", "diagnostics"]]) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-action="tab"][data-arg="${panelId}"]').click()`);
    await sleep(400);
    const file = shot.replace(/\.png$/i, `-${suffix}.png`);
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, image.toPNG());
    extraShots[suffix] = { file, bytes: fs.statSync(file).size };
  }

  await win.webContents.executeJavaScript("document.querySelector('[data-action=\"tab\"][data-arg=\"restart\"]').click()");
  await sleep(400);

  const panel = await win.webContents.executeJavaScript(
    "(() => { const node = document.querySelector('.panel[data-active=\"true\"]'); return node === null ? null : { id: node.dataset.panel ?? null, text: node.innerText, buttons: [...node.querySelectorAll('button[data-action]')].map((button) => ({ action: button.dataset.action, label: button.textContent, disabled: button.disabled })) }; })()",
  );
  if (panel === null) issues.push("点击「重启按钮」页签后没有活动面板");
  else {
    if (panel.id !== "restart") issues.push(`活动面板为 ${panel.id}，期望 restart`);
    if (!panel.text.includes("重启按钮补丁")) issues.push("面板中没有「重启按钮补丁」卡片");
    if (!panel.text.includes("app.asar")) issues.push("面板中没有 app.asar 信息");
    if (!panel.text.includes("已安装")) issues.push("面板没有报告「已安装」（当前 app.asar 已是补丁内容）");
    const actions = panel.buttons.map((button) => button.action);
    for (const action of ["restart-button-apply", "restart-button-verify", "restart-button-revert"]) {
      if (!actions.includes(action)) issues.push(`面板缺少按钮 ${action}`);
    }
    const applyButton = panel.buttons.find((button) => button.action === "restart-button-apply");
    const revertButton = panel.buttons.find((button) => button.action === "restart-button-revert");
    if (applyButton?.disabled !== true) issues.push("已安装时「安装补丁」按钮仍可点击");
    if (revertButton?.disabled === true) issues.push("「还原补丁」按钮被禁用，但存在备份");
  }

  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, image.toPNG());

  return {
    issues,
    tabs: before.tabs,
    activePanelBefore: before.active,
    activePanel: panel?.id ?? null,
    buttons: panel?.buttons ?? [],
    panelText: panel?.text ?? "",
    oneClick: {
      plugins: pluginsPanel?.actions.filter((button) => button.action === "enable-all-bundles") ?? [],
      checkpoints: checkpointsPanel?.actions.filter((button) => button.action === "delete-all-checkpoints") ?? [],
    },
    extraShots,
    shot,
    shotBytes: fs.statSync(shot).size,
  };
}

function selfCheckDigest(state) {
  const issues = [];
  if (state.selected === undefined) issues.push("未识别到目标应用安装目录");
  if (state.home.exists !== true) issues.push(`DSH 数据目录不存在: ${state.home.path}`);
  const detail = state.selectedProfileDetail;
  if (detail !== undefined) {
    if (detail.exists !== true) issues.push(`Profile 目录不存在: ${detail.dir}`);
    if (detail.manifestError !== undefined) issues.push(`插件清单无法解析: ${detail.manifestError}`);
    if (detail.patchError !== undefined) issues.push(`插件补丁无法解析: ${detail.patchError}`);
  }
  for (const entry of state.checkpoints) {
    if (entry.metaValid !== true) issues.push(`检查点元数据无效: ${entry.id}`);
  }
  return {
    console: state.console,
    home: { path: state.home.path, exists: state.home.exists, source: state.home.source, profiles: state.home.profileNames },
    target: state.selected === undefined ? undefined : {
      kind: state.selected.kind,
      label: state.selected.label,
      appVersion: state.selected.appVersion,
      electronVersion: state.selected.electronVersion,
      exe: state.selected.exe,
    },
    targetCount: state.targets.length,
    targets: state.targets.map((entry) => ({ id: entry.id, kind: entry.kind, label: entry.label, appVersion: entry.appVersion, dir: entry.dir })),
    running: state.running,
    profiles: state.profiles.map((entry) => ({
      name: entry.name,
      exists: entry.exists,
      plugins: entry.plugins.length,
      bundles: entry.bundles.length,
      disabled: entry.patchDisabledCount,
      quarantined: entry.removed.length,
    })),
    selectedProfile: state.selectedProfile,
    checkpoints: state.checkpoints.map((entry) => ({ id: entry.id, createdAt: entry.createdAt, metaValid: entry.metaValid, files: entry.files.length })),
    diagnostics: { dir: state.diagnostics.dir, count: state.diagnostics.count, latest: state.diagnostics.latest?.name },
    safeModeHomes: state.safeModeHomes.length,
    issues,
  };
}

function broadcast(state) {
  if (mainWindow !== undefined && mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("recovery:status-changed", state);
  }
}

function argvValue(prefix) {
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match === undefined ? undefined : match.slice(prefix.length);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 880,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: "#f4f4f6",
    autoHideMenuBar: true,
    title: "DSH 恢复器",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      devTools: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  // The renderer never navigates away and never opens windows of its own.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/u.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });

  void mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  return mainWindow;
}

const ready = (async () => {
  controller = new RecoveryController({ version: app.getVersion(), onState: broadcast });
  const targetId = argvValue("--target=");
  const profileName = argvValue("--profile=");
  const dshHome = argvValue("--home=");
  if (targetId !== undefined || profileName !== undefined || dshHome !== undefined) {
    controller.persist({
      ...(targetId === undefined ? {} : { targetId }),
      ...(profileName === undefined ? {} : { profileName }),
      ...(dshHome === undefined ? {} : { dshHome }),
    });
  }
  await controller.refresh({ sizes: false });
  if (selfCheck) {
    const digest = selfCheckDigest(controller.state);
    process.stdout.write(`${JSON.stringify(digest, undefined, 2)}\n`);
    process.stdout.write(digest.issues.length === 0 ? "self-check: ok\n" : `self-check: ${digest.issues.length} problem(s)\n`);
    app.exit(digest.issues.length === 0 ? 0 : 1);
    return;
  }
  if (verify) {
    let outcome;
    try {
      outcome = await runVerify({ version: app.getVersion(), targets: controller.state.targets });
    } catch (error) {
      // Never leave a headless run hanging: report and exit instead.
      process.stderr.write(`verify: 未捕获异常 ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      app.exit(2);
      return;
    }
    process.stdout.write(`${JSON.stringify(outcome, undefined, 2)}\n`);
    process.stdout.write(
      outcome.failed === 0 ? `verify: ok (${outcome.passed} checks)\n` : `verify: ${outcome.failed} of ${outcome.passed + outcome.failed} checks failed\n`,
    );
    if (outcome.failed > 0) {
      app.exit(1);
      return;
    }
    // Final check: the 退出 button path must really terminate the process. If
    // it does not, this timer keeps the process alive and reports the failure.
    setTimeout(() => {
      process.stderr.write("verify: recovery:quit 未在 4 秒内退出\n");
      app.exit(3);
    }, 4000);
    try {
      await controller.dispatch("recovery:quit", []);
    } catch (error) {
      process.stderr.write(`verify: recovery:quit 失败 ${error instanceof Error ? error.message : String(error)}\n`);
      app.exit(4);
    }
    return;
  }
  if (uiCheck) {
    const shot = argvValue("--ui-shot=") ?? path.join(PROJECT_ROOT, ".runtime", "ui-restart-tab.png");
    try {
      const outcome = await runUiCheck({ shot });
      process.stdout.write(`${JSON.stringify(outcome, undefined, 2)}\n`);
      process.stdout.write(outcome.issues.length === 0 ? "ui-check: ok\n" : `ui-check: ${outcome.issues.length} problem(s)\n`);
      app.exit(outcome.issues.length === 0 ? 0 : 1);
    } catch (error) {
      process.stderr.write(`ui-check: 未捕获异常 ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      app.exit(2);
    }
    return;
  }
})();

function registerChannels() {
  for (const channel of CHANNELS) {
    ipcMain.handle(channel, async (_event, ...args) => {
      await ready;
      try {
        return await controller.dispatch(channel, args);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), state: controller.state };
      }
    });
  }
}

// A self-check or verify run must still work while a console window is open, so
// both skip the single-instance lock entirely.
if (!headless && !uiCheck && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === undefined) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  registerChannels();

  void app.whenReady().then(() => {
    if (headless) return;
    app.setAppUserModelId("dev.dsh.recovery");
    createWindow();
  });
}
