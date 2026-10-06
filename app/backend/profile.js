"use strict";
// Profile-level plugin semantics, mirroring @deepseek-ai/dsh-app-boot and
// @deepseek-ai/dsh-plugin-manager:
//
//   * a profile manifest is <profile>/package.json, and the ordered list of
//     enabled bundles lives at manifest.dsh.profile.bundles;
//   * enabling or disabling a bundle only edits that list and keeps the
//     installed dependencies in place;
//   * the profile patch layer is <profile>/cordis.patch.yml and is never
//     parsed by the recovery path — it is byte-preserved, moved aside, or
//     edited by the user in their own editor.
//
// Every mutation is confined to those files plus node_modules, and every
// destructive step is reversible: removals are renamed into a quarantine
// directory inside the profile instead of being deleted.

const fs = require("node:fs");
const path = require("node:path");

const {
  directorySize,
  ensureDir,
  fileSizeOrZero,
  isDirectory,
  isFile,
  lstatOrUndefined,
  pathExists,
  readJson,
  removeEntry,
  timestampId,
  uniquePath,
  writeJsonAtomic,
} = require("./util");
const { profilePaths, RECOVERY_STATE_DIR_NAME, resolveProfileDir } = require("./paths");

/** Packages that must always stay enabled for the application to boot. */
const CORE_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

const BUNDLE_METADATA = {
  "@deepseek-ai/dsh-base": { label: "DSH 基础组件", category: "builtin" },
  "@deepseek-ai/dsh-web-app": { label: "DSH Web 应用", category: "builtin" },
  "@deepseek-ai/dsh-experimental-agent-team-profile": { label: "Agent 团队", category: "optional" },
  "@deepseek-ai/dsh-experimental-voice-input-bundle": { label: "语音输入", category: "optional" },
  "@deepseek-ai/dsh-experimental-auto-review": { label: "自动审查", category: "optional" },
  "@deepseek-ai/dsh-experimental-schedule-bundle": { label: "定时任务", category: "optional" },
};

const CATEGORY_LABEL = { builtin: "内置组件", optional: "可选组件", installed: "直接安装的插件" };

function defaultBundles() {
  return ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
}

function isCoreBundle(name) {
  return CORE_BUNDLES.includes(name);
}

function describeBundle(name) {
  const meta = BUNDLE_METADATA[name];
  const category = meta?.category ?? "installed";
  return {
    name,
    label: meta?.label ?? name,
    category,
    categoryLabel: CATEGORY_LABEL[category] ?? CATEGORY_LABEL.installed,
    core: isCoreBundle(name),
  };
}

/** Filesystem-safe form of an npm package name (used for quarantine entries). */
function sanitizePackageName(name) {
  return String(name).replace(/^@/u, "").replace(/[/\\]+/gu, "+");
}

function readManifest(profileDir) {
  const manifestPath = path.join(profileDir, "package.json");
  if (!isFile(manifestPath)) {
    return { path: manifestPath, exists: false, ok: false, error: `未找到 ${manifestPath}` };
  }
  const parsed = readJson(manifestPath);
  if (!parsed.ok) return { path: manifestPath, exists: true, ok: false, error: parsed.error };
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { path: manifestPath, exists: true, ok: false, error: `${manifestPath} 的顶层必须是 JSON 对象` };
  }
  return { path: manifestPath, exists: true, ok: true, value: parsed.value };
}

function enabledBundles(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles;
  return Array.isArray(bundles) ? bundles.filter((entry) => typeof entry === "string") : [];
}

/** True when the installed package declares bundle metadata (dsh.bundle.patch). */
function declaresBundle(profileDir, name) {
  const packageJson = readJson(path.join(profileDir, "node_modules", ...String(name).split("/"), "package.json"));
  return packageJson.ok && packageJson.value?.dsh?.bundle?.patch !== undefined;
}

/** A layer the runtime is willing to load from manifest.dsh.profile.bundles. */
function isBundleLayer(profileDir, name) {
  return isCoreBundle(name) || BUNDLE_METADATA[name] !== undefined || declaresBundle(profileDir, name);
}

/** Package-level description of every declared dependency, plus enabled bundles. */
function listPlugins(profileDir, manifest) {
  const dependencies = manifest?.dependencies;
  const bundles = enabledBundles(manifest);
  const names = new Set(Object.keys(dependencies !== null && typeof dependencies === "object" ? dependencies : {}));
  for (const name of bundles) names.add(name);

  const rows = [];
  for (const name of [...names].sort((left, right) => left.localeCompare(right, "en"))) {
    const installedDir = path.join(profileDir, "node_modules", ...name.split("/"));
    const packageJson = readJson(path.join(installedDir, "package.json"));
    const declared = dependencies !== null && typeof dependencies === "object" ? dependencies[name] : undefined;
    const info = describeBundle(name);
    rows.push({
      ...info,
      version: typeof packageJson.value?.version === "string" ? packageJson.value.version : typeof declared === "string" ? declared : undefined,
      enabled: bundles.includes(name),
      // Only bundle layers belong in manifest.dsh.profile.bundles.
      bundle: isBundleLayer(profileDir, name),
      builtin: info.category === "builtin",
      installedLocal: pathExists(installedDir),
      quarantinable: pathExists(installedDir),
      declared: declared !== undefined,
    });
  }
  return rows;
}

/** Minimal, read-only view of the user's patch layer. The file is never rewritten here. */
function readPatchEntries(profileDir) {
  const patchPath = path.join(profileDir, "cordis.patch.yml");
  if (!isFile(patchPath)) return { path: patchPath, exists: false, entries: [] };
  let text;
  try {
    text = fs.readFileSync(patchPath, "utf8");
  } catch (error) {
    return { path: patchPath, exists: true, error: String(error), entries: [] };
  }
  const entries = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*-\s+id:\s*(\S+)\s*$/u.exec(lines[index]);
    if (match === null) continue;
    let disabled;
    let name;
    for (let look = index + 1; look < lines.length; look += 1) {
      if (/^\s*-\s/u.test(lines[look])) break;
      const disabledMatch = /^\s+disabled:\s*(.+?)\s*$/u.exec(lines[look]);
      if (disabledMatch !== null && disabled === undefined) {
        const raw = disabledMatch[1].replace(/^["']|["']$/gu, "");
        disabled = raw === "true" ? true : raw === "false" ? false : raw;
      }
      const nameMatch = /^\s+name:\s*(.+?)\s*$/u.exec(lines[look]);
      if (nameMatch !== null && name === undefined) name = nameMatch[1].replace(/^["']|["']$/gu, "");
    }
    entries.push({ id: match[1], name, disabled, line: index + 1 });
  }
  return {
    path: patchPath,
    exists: true,
    bytes: fileSizeOrZero(patchPath),
    entries,
    disabledCount: entries.filter((entry) => entry.disabled === true).length,
  };
}

function listRemoved(profileDir, { sizes = true } = {}) {
  const removedRoot = path.join(profileDir, RECOVERY_STATE_DIR_NAME, "removed");
  if (!isDirectory(removedRoot)) return [];
  let entries;
  try {
    entries = fs.readdirSync(removedRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(removedRoot, entry.name);
    const meta = readJson(path.join(dir, "meta.json"));
    result.push({
      id: entry.name,
      dir,
      name: meta.ok ? meta.value?.name : undefined,
      version: meta.ok ? meta.value?.version : undefined,
      removedAt: meta.ok ? meta.value?.removedAt : undefined,
      bundle: meta.ok ? meta.value?.bundle === true : undefined,
      bytes: sizes ? directorySize(dir) : undefined,
    });
  }
  result.sort((left, right) => String(right.removedAt ?? right.id).localeCompare(String(left.removedAt ?? left.id), "en"));
  return result;
}

function summarizeProfile(name, home, { sizes = true } = {}) {
  const dir = resolveProfileDir(name, home);
  const paths = profilePaths(dir);
  const manifest = readManifest(dir);
  const patch = readPatchEntries(dir);
  const plugins = manifest.ok ? listPlugins(dir, manifest.value) : [];
  return {
    name,
    dir,
    exists: isDirectory(dir),
    manifestPath: paths.manifest,
    manifestExists: manifest.exists,
    manifestValid: manifest.ok,
    manifestError: manifest.ok ? undefined : manifest.error,
    patchPath: paths.patch,
    patchExists: patch.exists,
    patchBytes: patch.bytes,
    patchError: patch.error,
    patchEntries: patch.entries,
    patchDisabledCount: patch.disabledCount,
    hasLock: isFile(paths.lock),
    hasNodeModules: isDirectory(paths.nodeModules),
    nodeModulesBytes: sizes && isDirectory(paths.nodeModules) ? directorySize(paths.nodeModules) : undefined,
    bundles: manifest.ok ? enabledBundles(manifest.value) : [],
    plugins,
    removed: listRemoved(dir, { sizes }),
  };
}

function loadMutableManifest(profileDir) {
  const manifest = readManifest(profileDir);
  if (!manifest.exists) throw new Error(`Profile 缺少 package.json: ${manifest.path}`);
  if (!manifest.ok) throw new Error(manifest.error);
  return manifest.value;
}

function setBundles(profileDir, manifest, bundles) {
  const next = manifest.dsh !== null && typeof manifest.dsh === "object" ? manifest.dsh : {};
  const profile = next.profile !== null && typeof next.profile === "object" ? next.profile : {};
  manifest.dsh = { ...next, profile: { ...profile, bundles } };
  writeJsonAtomic(path.join(profileDir, "package.json"), manifest);
}

/**
 * Enable or disable one bundle layer by editing manifest.dsh.profile.bundles,
 * exactly like dsh-plugin-manager's setBundleEnabled: installed dependencies
 * are retained so re-enabling is instant and offline.
 */
function setBundleEnabled(profileDir, name, enabled) {
  const manifest = loadMutableManifest(profileDir);
  const before = enabledBundles(manifest);
  if (!enabled && isCoreBundle(name)) throw new Error(`${name} 是启动必需的组件，不能禁用`);
  if (enabled && !isBundleLayer(profileDir, name)) {
    throw new Error(`${name} 不是插件组合包（未声明 dsh.bundle.patch），无法作为插件层启用`);
  }
  if (enabled && !isCoreBundle(name) && manifest.dependencies?.[name] === undefined) {
    throw new Error(`${name} 不在该 Profile 的依赖中，无法启用`);
  }
  const after = enabled ? (before.includes(name) ? before : [...before, name]) : before.filter((entry) => entry !== name);
  setBundles(profileDir, manifest, after);
  return { before, after, changed: before.join("\u0000") !== after.join("\u0000") };
}

/**
 * Uninstall a bundle: drop it from the enabled list and from dependencies, then
 * move its node_modules entry into the profile's quarantine directory.
 * The move is a same-volume rename, so it is instant and fully reversible.
 */
function uninstallBundle(profileDir, name) {
  const manifest = loadMutableManifest(profileDir);
  if (isCoreBundle(name)) throw new Error(`${name} 是启动必需的组件，不能卸载`);
  const before = enabledBundles(manifest);
  const installedDir = path.join(profileDir, "node_modules", ...String(name).split("/"));
  const installed = pathExists(installedDir);

  const dependencies = manifest.dependencies !== null && typeof manifest.dependencies === "object" ? { ...manifest.dependencies } : {};
  if (dependencies[name] === undefined && !before.includes(name) && !installed) {
    throw new Error(`${name} 既未启用也未安装`);
  }
  const version = dependencies[name];
  delete dependencies[name];
  manifest.dependencies = dependencies;
  setBundles(profileDir, manifest, before.filter((entry) => entry !== name));

  let quarantineDir;
  if (installed) {
    const removedRoot = path.join(profileDir, RECOVERY_STATE_DIR_NAME, "removed");
    ensureDir(removedRoot);
    quarantineDir = uniquePath(path.join(removedRoot, `${timestampId()}-${sanitizePackageName(name)}`));
    try {
      fs.renameSync(installedDir, quarantineDir);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      fs.cpSync(installedDir, quarantineDir, { recursive: true, preserveTimestamps: true });
      removeEntry(installedDir);
    }
    writeJsonAtomic(path.join(quarantineDir, "meta.json"), {
      name,
      version: typeof version === "string" ? version : undefined,
      bundle: before.includes(name),
      removedAt: new Date().toISOString(),
      originalPath: installedDir,
      profileDir,
    });
  }

  return {
    name,
    version: typeof version === "string" ? version : undefined,
    quarantineDir,
    quarantineId: quarantineDir === undefined ? undefined : path.basename(quarantineDir),
    bundlesBefore: before,
    bundlesAfter: before.filter((entry) => entry !== name),
    manifestPath: path.join(profileDir, "package.json"),
  };
}

/** Put a quarantined package back, re-declaring it and restoring its bundle flag. */
function restoreRemoved(profileDir, quarantineId) {
  const quarantineDir = path.join(profileDir, RECOVERY_STATE_DIR_NAME, "removed", path.basename(String(quarantineId)));
  if (!isDirectory(quarantineDir)) throw new Error(`隔离区中不存在 ${quarantineId}`);
  const meta = readJson(path.join(quarantineDir, "meta.json"));
  const name = meta.ok && typeof meta.value?.name === "string" ? meta.value.name : undefined;
  if (name === undefined) throw new Error(`${quarantineId} 缺少 meta.json，无法确定原始包名`);
  const target = path.join(profileDir, "node_modules", ...name.split("/"));
  if (pathExists(target)) throw new Error(`目标已存在，未覆盖: ${target}`);
  ensureDir(path.dirname(target));
  fs.renameSync(quarantineDir, target);

  const manifest = loadMutableManifest(profileDir);
  const dependencies = manifest.dependencies !== null && typeof manifest.dependencies === "object" ? { ...manifest.dependencies } : {};
  if (dependencies[name] === undefined) {
    dependencies[name] = typeof meta.value?.version === "string" ? meta.value.version : "*";
    manifest.dependencies = dependencies;
  }
  if (meta.value?.bundle === true) {
    const bundles = enabledBundles(manifest);
    if (!bundles.includes(name)) setBundles(profileDir, manifest, [...bundles, name]);
  } else {
    writeJsonAtomic(path.join(profileDir, "package.json"), manifest);
  }
  return { name, restoredTo: target };
}

/** Move the whole quarantine entry out of the profile (irreversible). */
function discardRemoved(profileDir, quarantineId) {
  const quarantineDir = path.join(profileDir, RECOVERY_STATE_DIR_NAME, "removed", path.basename(String(quarantineId)));
  if (!isDirectory(quarantineDir)) throw new Error(`隔离区中不存在 ${quarantineId}`);
  removeEntry(quarantineDir);
  return { id: quarantineId };
}

/**
 * Reset the plugin set to the bundled defaults, mirroring dsh-app-boot's
 * sanitizeProfile: move the user patch layer aside (never parse it), then
 * rewrite the bundle list. Installed packages stay on disk.
 */
function sanitizeProfile(profileDir, bundles = defaultBundles()) {
  const patchPath = path.join(profileDir, "cordis.patch.yml");
  let movedPatch;
  if (isFile(patchPath)) {
    movedPatch = uniquePath(`${patchPath}.bak-${Date.now()}`);
    fs.renameSync(patchPath, movedPatch);
  }
  const manifestExisted = isFile(path.join(profileDir, "package.json"));
  if (manifestExisted) {
    const manifest = loadMutableManifest(profileDir);
    const before = enabledBundles(manifest);
    setBundles(profileDir, manifest, [...bundles]);
    return { movedPatch, bundlesBefore: before, bundlesAfter: [...bundles], manifestExisted };
  }
  return { movedPatch, bundlesBefore: [], bundlesAfter: [...bundles], manifestExisted };
}

module.exports = {
  BUNDLE_METADATA,
  CATEGORY_LABEL,
  CORE_BUNDLES,
  defaultBundles,
  declaresBundle,
  describeBundle,
  enabledBundles,
  isBundleLayer,
  listPlugins,
  listRemoved,
  readManifest,
  readPatchEntries,
  restoreRemoved,
  discardRemoved,
  sanitizeProfile,
  sanitizePackageName,
  setBundleEnabled,
  setBundles,
  summarizeProfile,
  uninstallBundle,
};
