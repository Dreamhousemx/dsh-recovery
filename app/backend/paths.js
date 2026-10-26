"use strict";
// Path resolution, install detection, and recovery-console configuration.
//
// The DSH home resolution here mirrors @deepseek-ai/dsh-home-paths:
// explicit configuration wins, then $DSH_HOME, then ~/.dsh — and a blank
// value counts as unset.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ensureDir, isDirectory, isFile, pathExists, readJson, writeJsonAtomic } = require("./util");
const { readAsarJson, withoutAsar } = require("./asar");

const DSH_HOME_ENV = "DSH_HOME";
const DSH_HOME_DIR_NAME = ".dsh";
const PROFILES_DIR_NAME = "profiles";
const PROFILE_MANIFEST_FILENAME = "package.json";
const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
const PROFILE_LOCK_FILENAME = "lock";
const RECOVERY_STATE_DIR_NAME = ".dsh-recovery";
const RECOVERY_CHECKPOINT_DIR_NAME = "checkpoints";
const RECOVERY_REMOVED_DIR_NAME = "removed";
const CONFIG_FILENAME = "dsh-recovery.config.json";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// Top-level executables that are never the application entry point.
const NON_APP_EXECUTABLE = /^(unins|uninstall|elevate|squirrel|update|setup)/iu;

function expandTilde(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function defaultDshHome() {
  return path.join(os.homedir(), DSH_HOME_DIR_NAME);
}

/**
 * Resolve the Harness home plus why it resolved that way, so the console can
 * show the same precedence the runtime uses.
 */
function resolveDshHomeInfo(configuredHome) {
  const defaultPath = defaultDshHome();
  const explicit = typeof configuredHome === "string" ? configuredHome.trim() : "";
  if (explicit !== "") {
    return { path: path.resolve(expandTilde(explicit)), source: "config", envValue: envHomeValue(), defaultPath };
  }
  const envValue = envHomeValue();
  if (envValue !== "") {
    return { path: path.resolve(expandTilde(envValue)), source: "env", envValue, defaultPath };
  }
  return { path: defaultPath, source: "default", envValue: "", defaultPath };
}

function envHomeValue() {
  const raw = process.env[DSH_HOME_ENV];
  return typeof raw === "string" ? raw.trim() : "";
}

function resolveDshHome(configuredHome) {
  return resolveDshHomeInfo(configuredHome).path;
}

function profilesDir(home) {
  return path.join(home, PROFILES_DIR_NAME);
}

function recoveryStateDir(home) {
  return path.join(profilesDir(home), RECOVERY_STATE_DIR_NAME);
}

function checkpointRootDir(home) {
  return path.join(recoveryStateDir(home), RECOVERY_CHECKPOINT_DIR_NAME);
}

function removedRootDir(home) {
  return path.join(recoveryStateDir(home), RECOVERY_REMOVED_DIR_NAME);
}

/** Mirror dsh-app-boot's profile-name rejection rules. */
function assertValidProfileName(name) {
  const value = String(name ?? "");
  if (value === "" || value === "." || value === ".." || value === "node_modules" || /[/\\]/u.test(value)) {
    throw new Error(`非法的 Profile 名称: ${JSON.stringify(name)}`);
  }
  return value;
}

function resolveProfileDir(name, home) {
  return path.join(profilesDir(home), assertValidProfileName(name));
}

function profilePaths(profileDir) {
  return {
    dir: profileDir,
    manifest: path.join(profileDir, PROFILE_MANIFEST_FILENAME),
    patch: path.join(profileDir, PROFILE_PATCH_FILENAME),
    lock: path.join(profileDir, PROFILE_LOCK_FILENAME),
    nodeModules: path.join(profileDir, "node_modules"),
    removedRoot: path.join(profileDir, RECOVERY_STATE_DIR_NAME, RECOVERY_REMOVED_DIR_NAME),
  };
}

/** Names of profile directories present in a Harness home. */
function listProfileNames(home) {
  const dir = profilesDir(home);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== RECOVERY_STATE_DIR_NAME && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
}

// ---------------------------------------------------------------------------
// Application detection
// ---------------------------------------------------------------------------

function detectionRoots() {
  const roots = [];
  const seen = new Set();
  const push = (value) => {
    if (typeof value !== "string" || value === "") return;
    const resolved = path.resolve(value);
    const key = resolved.toLowerCase();
    if (seen.has(key) || !isDirectory(resolved)) return;
    seen.add(key);
    roots.push(resolved);
  };
  const localAppData = process.env.LOCALAPPDATA;
  push(localAppData);
  if (typeof localAppData === "string" && localAppData !== "") push(path.join(localAppData, "Programs"));
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  push(programFiles);
  push(`${programFiles} (x86)`);
  push("D:\\Dev Tools");
  push("D:\\Program Files");
  return roots;
}

function pickExecutable(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".exe")) continue;
    if (NON_APP_EXECUTABLE.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {}
    candidates.push({ file, name: entry.name, size });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) => right.size - left.size);
  return candidates[0];
}

function readElectronVersion(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "version"), "utf8").trim();
    return raw === "" ? undefined : raw;
  } catch {
    return undefined;
  }
}

function readAppIdentity(resourcesDir, hasAsar, asarPath) {
  const unpacked = path.join(resourcesDir, "app", "package.json");
  if (isFile(unpacked)) {
    const parsed = readJson(unpacked);
    if (parsed.ok && parsed.value !== null && typeof parsed.value === "object") {
      return { from: "resources/app/package.json", manifest: parsed.value };
    }
  }
  if (hasAsar) {
    for (const entry of ["app-package.json", "package.json"]) {
      const manifest = readAsarJson(asarPath, entry);
      if (manifest !== null && typeof manifest === "object") {
        return { from: `resources/app.asar!/${entry}`, manifest };
      }
    }
  }
  return undefined;
}

function classify(manifest) {
  const name = typeof manifest?.name === "string" ? manifest.name : "";
  if (name === "dsh-plugin-desktop") return "dsh-desktop";
  if (name === "@deepseek-ai/dsh-desktop") return "deepseek-harness";
  if (name === "@deepseek-ai/dsh") return "deepseek-harness";
  return "unknown";
}

const KIND_LABEL = {
  "deepseek-harness": "DeepSeek Harness",
  "dsh-desktop": "DSH Desktop",
  unknown: "未知应用",
};

function inspectInstall(dir) {
  const resourcesDir = path.join(dir, "resources");
  if (!isDirectory(resourcesDir)) return undefined;
  const asarPath = path.join(resourcesDir, "app.asar");
  // Electron's patched fs reports `app.asar` itself as a virtual directory.
  const hasAsar = withoutAsar(() => isFile(asarPath));
  const hasUnpackedApp = isFile(path.join(resourcesDir, "app", "package.json"));
  if (!hasAsar && !hasUnpackedApp) return undefined;
  const executable = pickExecutable(dir);
  if (executable === undefined) return undefined;

  const identity = readAppIdentity(resourcesDir, hasAsar, asarPath);
  const kind = classify(identity?.manifest);
  const backupPath = path.join(resourcesDir, "app.asar.dsh-restart-backup");
  const runtimeVersions = readJson(path.join(resourcesDir, "runtime", "versions.json"));

  return {
    id: path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, ""),
    kind,
    label: KIND_LABEL[kind] ?? path.basename(dir),
    appName: typeof identity?.manifest?.name === "string" ? identity.manifest.name : undefined,
    appVersion: typeof identity?.manifest?.version === "string" ? identity.manifest.version : undefined,
    appDescription: typeof identity?.manifest?.description === "string" ? identity.manifest.description : undefined,
    identitySource: identity?.from,
    dir,
    exe: executable.file,
    exeName: executable.name,
    exeSize: executable.size,
    resourcesDir,
    asarPath: hasAsar ? asarPath : undefined,
    unpackedAppDir: hasUnpackedApp ? path.join(resourcesDir, "app") : undefined,
    asarBackupPath: withoutAsar(() => isFile(backupPath)) ? backupPath : undefined,
    electronVersion: readElectronVersion(dir),
    runtimeVersions: runtimeVersions.ok ? runtimeVersions.value : undefined,
  };
}

/** Scan the usual install roots (depth 1) for DeepSeek Harness / DSH Desktop. */
function detectTargets() {
  const found = [];
  const seen = new Set();
  const visit = (dir) => {
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const target = inspectInstall(dir);
    if (target !== undefined) found.push(target);
  };
  for (const root of detectionRoots()) {
    visit(root);
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) visit(path.join(root, entry.name));
    }
  }
  const rank = { "deepseek-harness": 0, "dsh-desktop": 1, unknown: 2 };
  found.sort((left, right) => (rank[left.kind] ?? 9) - (rank[right.kind] ?? 9) || left.dir.localeCompare(right.dir, "en"));
  return found;
}

/** Dirs the target application keeps its Electron user data in. */
function userDataDirs() {
  const appData = process.env.APPDATA;
  const dirs = [];
  if (typeof appData === "string" && appData !== "") {
    dirs.push(path.join(appData, "@deepseek-ai", "dsh-desktop"));
    dirs.push(path.join(appData, "DSH Desktop"));
  }
  dirs.push(path.join(os.homedir(), "AppData", "Roaming", "@deepseek-ai", "dsh-desktop"));
  return dirs.filter((dir, index) => dirs.indexOf(dir) === index);
}

// ---------------------------------------------------------------------------
// Console configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  dshHome: null,
  targetId: null,
  profileName: null,
  targets: [],
  maxCheckpoints: 20,
  // 收录插件 (awesome-dsh-plugin submissions): the last used repository and,
  // optionally, a clone of the list itself so duplicate checks and the entry
  // file write can run locally.
  awesomeRepoDir: null,
  awesomeListDir: null,
};

function configPath() {
  return path.join(PROJECT_ROOT, CONFIG_FILENAME);
}

/** Trimmed string or null — every path-like config field follows this rule. */
function textOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizeConfig(raw) {
  const value = raw !== null && typeof raw === "object" ? raw : {};
  const maxCheckpoints = Number(value.maxCheckpoints);
  return {
    dshHome: typeof value.dshHome === "string" && value.dshHome.trim() !== "" ? value.dshHome.trim() : null,
    targetId: typeof value.targetId === "string" && value.targetId !== "" ? value.targetId : null,
    profileName: typeof value.profileName === "string" && value.profileName.trim() !== "" ? value.profileName.trim() : null,
    targets: Array.isArray(value.targets)
      ? value.targets
          .filter((entry) => entry !== null && typeof entry === "object" && typeof entry.dir === "string")
          .map((entry) => ({
            id: typeof entry.id === "string" && entry.id !== "" ? entry.id : path.basename(entry.dir),
            label: typeof entry.label === "string" && entry.label !== "" ? entry.label : path.basename(entry.dir),
            dir: entry.dir,
          }))
      : [],
    maxCheckpoints: Number.isFinite(maxCheckpoints) && maxCheckpoints > 0 ? Math.floor(maxCheckpoints) : 20,
    awesomeRepoDir: textOrNull(value.awesomeRepoDir),
    awesomeListDir: textOrNull(value.awesomeListDir),
  };
}

function loadConfig() {
  const file = configPath();
  if (!pathExists(file)) return { file, exists: false, value: { ...DEFAULT_CONFIG } };
  const parsed = readJson(file);
  if (!parsed.ok) return { file, exists: true, value: { ...DEFAULT_CONFIG }, error: parsed.error };
  return { file, exists: true, value: normalizeConfig(parsed.value) };
}

function saveConfig(config) {
  const file = configPath();
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, normalizeConfig(config));
  return file;
}

/**
 * All launchable targets: auto-detected installs, plus any explicitly
 * configured ones, then narrowed to the selection in the config.
 */
function resolveTargets(config) {
  const detected = detectTargets();
  const byId = new Map(detected.map((target) => [target.id, target]));
  for (const explicit of config.targets) {
    const inspected = inspectInstall(explicit.dir);
    const merged =
      inspected === undefined
        ? {
            id: explicit.id,
            kind: "unknown",
            label: explicit.label,
            dir: explicit.dir,
            exe: undefined,
            resourcesDir: path.join(explicit.dir, "resources"),
          }
        : { ...inspected, id: explicit.id, label: explicit.label };
    byId.set(explicit.id, merged);
  }
  const all = [...byId.values()];
  const selected = pickTarget(all, config.targetId);
  return { all, selected };
}

/**
 * Resolve the configured selection. The stored value is usually a slug id
 * ("deepseek-harness"), but a full path is accepted too, so `--target=<dir>`
 * works whether the console was started from a script or by hand.
 */
function pickTarget(all, wanted) {
  if (typeof wanted !== "string" || wanted === "") return all[0];
  const byId = all.find((target) => target.id === wanted);
  if (byId !== undefined) return byId;
  const lower = wanted.toLowerCase().replace(/[\\/]+$/u, "");
  return (
    all.find((target) => target.dir.toLowerCase() === lower) ??
    all.find((target) => path.basename(target.dir).toLowerCase() === lower) ??
    all.find((target) => target.id === slug(wanted)) ??
    all[0]
  );
}

function slug(text) {
  return path.basename(text).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

module.exports = {
  CONFIG_FILENAME,
  DSH_HOME_ENV,
  KIND_LABEL,
  NON_APP_EXECUTABLE,
  PROFILES_DIR_NAME,
  PROFILE_LOCK_FILENAME,
  PROFILE_MANIFEST_FILENAME,
  PROFILE_PATCH_FILENAME,
  PROJECT_ROOT,
  RECOVERY_STATE_DIR_NAME,
  assertValidProfileName,
  checkpointRootDir,
  configPath,
  defaultDshHome,
  detectTargets,
  detectionRoots,
  inspectInstall,
  listProfileNames,
  loadConfig,
  profilePaths,
  profilesDir,
  recoveryStateDir,
  removedRootDir,
  resolveDshHome,
  resolveDshHomeInfo,
  resolveProfileDir,
  resolveTargets,
  saveConfig,
  userDataDirs,
};
