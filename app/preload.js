// Preload: expose a minimal, explicit surface to the recovery renderer.
// Every channel maps to a handler registered in backend/ipc.js.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("recovery", {
  // --- environment -------------------------------------------------------
  status: () => invoke("recovery:status"),
  targets: () => invoke("recovery:targets"),
  refresh: () => invoke("recovery:refresh"),
  setTarget: (id) => invoke("recovery:set-target", id),
  chooseHome: () => invoke("recovery:choose-home"),
  resetHome: () => invoke("recovery:reset-home"),
  resetData: () => invoke("recovery:reset-data"),

  // --- profiles ----------------------------------------------------------
  profiles: () => invoke("recovery:profiles"),
  selectProfile: (name) => invoke("recovery:select-profile", name),

  // --- plugin management -------------------------------------------------
  setBundleEnabled: (name, enabled) => invoke("recovery:set-bundle-enabled", name, enabled),
  enableAllBundles: () => invoke("recovery:enable-all-bundles"),
  uninstallBundle: (name) => invoke("recovery:uninstall-bundle", name),
  restoreRemoved: (entryName) => invoke("recovery:restore-removed", entryName),
  discardRemoved: (entryName) => invoke("recovery:discard-removed", entryName),

  // --- quick recovery ----------------------------------------------------
  sanitizeProfile: () => invoke("recovery:sanitize-profile"),
  openProfileDir: () => invoke("recovery:open-profile-dir"),
  openPath: (target) => invoke("recovery:open-path", target),
  showItem: (target) => invoke("recovery:show-item", target),

  // --- checkpoints -------------------------------------------------------
  checkpoints: () => invoke("recovery:checkpoints"),
  createCheckpoint: (note) => invoke("recovery:create-checkpoint", note),
  restoreCheckpoint: (id) => invoke("recovery:restore-checkpoint", id),
  deleteCheckpoint: (id) => invoke("recovery:delete-checkpoint", id),
  deleteAllCheckpoints: () => invoke("recovery:delete-all-checkpoints"),

  // --- diagnostics -------------------------------------------------------
  diagnostics: () => invoke("recovery:diagnostics"),
  exportDiagnostics: () => invoke("recovery:export-diagnostics"),

  // --- restart button patch ----------------------------------------------
  restartButtonApply: () => invoke("recovery:restart-button-apply"),
  restartButtonRevert: () => invoke("recovery:restart-button-revert"),
  restartButtonVerify: () => invoke("recovery:restart-button-verify"),

  // --- lifecycle ---------------------------------------------------------
  launchTarget: (options) => invoke("recovery:launch", options),
  stopTarget: () => invoke("recovery:stop"),
  restartTarget: (options) => invoke("recovery:restart", options),
  quit: () => invoke("recovery:quit"),

  // --- events ------------------------------------------------------------
  onStatus: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("recovery:status-changed", wrapped);
    return () => ipcRenderer.removeListener("recovery:status-changed", wrapped);
  },
});
