"use strict";
// Profile checkpoints.
//
// A checkpoint is a plain directory holding byte copies of the profile files
// that decide what loads plus a meta.json describing them. Restoring is a
// copy-back, and every restore first snapshots the current state, so a restore
// can always be undone by restoring the pre-restore checkpoint.

const fs = require("node:fs");
const path = require("node:path");

const {
  copyFileIfPresent,
  directorySize,
  ensureDir,
  fileSizeOrZero,
  isDirectory,
  pathExists,
  readJson,
  removeEntry,
  timestampId,
  uniquePath,
  writeJsonAtomic,
} = require("./util");
const { checkpointRootDir, resolveProfileDir } = require("./paths");
const { enabledBundles, readManifest, readPatchEntries } = require("./profile");

/** Profile files a checkpoint captures. node_modules is intentionally excluded. */
const CHECKPOINT_FILES = ["package.json", "cordis.patch.yml", "cordis.yml", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

const TRIGGER_LABEL = {
  manual: "手动创建",
  auto: "操作前自动创建",
  "pre-restore": "恢复前自动创建",
  "pre-launch": "启动前自动创建",
  unknown: "未知来源",
};

function checkpointDir(home, id) {
  return path.join(checkpointRootDir(home), id);
}

function snapshotFiles(profileDir) {
  const captured = [];
  for (const name of CHECKPOINT_FILES) {
    const file = path.join(profileDir, name);
    if (pathExists(file)) captured.push({ name, bytes: fileSizeOrZero(file) });
  }
  return captured;
}

/**
 * Capture the current profile state.
 * Returns a summary object suitable for display; never throws for a missing
 * optional file (a fresh profile may have no patch and no lockfile).
 */
function createCheckpoint({ home, profileName, target, trigger = "manual", label }) {
  const profileDir = resolveProfileDir(profileName, home);
  const manifest = readManifest(profileDir);
  const patch = readPatchEntries(profileDir);
  const dir = uniquePath(checkpointDir(home, timestampId()));
  const id = path.basename(dir);
  ensureDir(dir);

  const files = snapshotFiles(profileDir);
  for (const name of CHECKPOINT_FILES) copyFileIfPresent(path.join(profileDir, name), path.join(dir, name));

  const meta = {
    id,
    createdAt: new Date().toISOString(),
    trigger,
    label: typeof label === "string" && label !== "" ? label : TRIGGER_LABEL[trigger] ?? trigger,
    profileName,
    profileDir,
    files,
    bundles: manifest.ok ? enabledBundles(manifest.value) : [],
    dependencyCount: manifest.ok && manifest.value.dependencies !== null && typeof manifest.value.dependencies === "object" ? Object.keys(manifest.value.dependencies).length : 0,
    patchDisabledCount: patch.disabledCount,
    hasPatch: patch.exists,
    target: target === undefined ? undefined : { id: target.id, label: target.label, appVersion: target.appVersion, exe: target.exe },
  };
  writeJsonAtomic(path.join(dir, "meta.json"), meta);
  return { ...meta, dir, bytes: directorySize(dir) };
}

function listCheckpoints(home) {
  const root = checkpointRootDir(home);
  if (!isDirectory(root)) return [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const parsed = readJson(path.join(dir, "meta.json"));
    const meta = parsed.ok && parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    result.push({
      id: entry.name,
      dir,
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : undefined,
      trigger: typeof meta.trigger === "string" ? meta.trigger : "unknown",
      label: typeof meta.label === "string" ? meta.label : TRIGGER_LABEL.unknown,
      profileName: typeof meta.profileName === "string" ? meta.profileName : undefined,
      bundles: Array.isArray(meta.bundles) ? meta.bundles : [],
      dependencyCount: Number.isFinite(meta.dependencyCount) ? meta.dependencyCount : undefined,
      patchDisabledCount: Number.isFinite(meta.patchDisabledCount) ? meta.patchDisabledCount : 0,
      hasPatch: meta.hasPatch === true,
      files: Array.isArray(meta.files) ? meta.files : [],
      target: meta.target,
      metaValid: parsed.ok,
      bytes: directorySize(dir),
    });
  }
  result.sort((left, right) => String(right.createdAt ?? right.id).localeCompare(String(left.createdAt ?? left.id), "en"));
  return result;
}

function readCheckpoint(home, id) {
  const dir = checkpointDir(home, path.basename(String(id)));
  if (!isDirectory(dir)) throw new Error(`检查点不存在: ${id}`);
  const parsed = readJson(path.join(dir, "meta.json"));
  if (!parsed.ok) throw new Error(`${dir} 缺少可读的 meta.json`);
  return { dir, id: path.basename(dir), meta: parsed.value };
}

/**
 * Restore a checkpoint into a profile. A pre-restore checkpoint is captured
 * first, so this operation is itself reversible.
 */
function restoreCheckpoint({ home, profileName, id, target }) {
  const { dir, meta } = readCheckpoint(home, id);
  const sourceProfile = typeof meta.profileName === "string" && meta.profileName !== "" ? meta.profileName : profileName;
  const profileDir = resolveProfileDir(sourceProfile, home);
  if (!isDirectory(profileDir)) throw new Error(`目标 Profile 目录不存在: ${profileDir}`);

  const preRestore = createCheckpoint({
    home,
    profileName: sourceProfile,
    target,
    trigger: "pre-restore",
    label: `恢复 ${id} 之前`,
  });

  const restored = [];
  const skipped = [];
  const presentNow = snapshotFiles(profileDir).map((entry) => entry.name);
  for (const name of CHECKPOINT_FILES) {
    const source = path.join(dir, name);
    if (!pathExists(source)) {
      skipped.push(name);
      continue;
    }
    fs.copyFileSync(source, path.join(profileDir, name));
    restored.push(name);
  }
  const orphans = presentNow.filter((name) => !restored.includes(name));

  return {
    id,
    profileName: sourceProfile,
    dir,
    preRestoreId: preRestore.id,
    restored,
    skipped,
    orphans,
    restoredAt: new Date().toISOString(),
  };
}

function deleteCheckpoint(home, id) {
  const dir = checkpointDir(home, path.basename(String(id)));
  if (!isDirectory(dir)) throw new Error(`检查点不存在: ${id}`);
  removeEntry(dir);
  return { id: String(id) };
}

/** Keep at most `maxCheckpoints` entries, dropping the oldest first. */
function pruneCheckpoints(home, maxCheckpoints) {
  if (!Number.isFinite(maxCheckpoints) || maxCheckpoints <= 0) return { removed: [] };
  const all = listCheckpoints(home);
  const removed = [];
  for (const entry of all.slice(maxCheckpoints)) {
    try {
      removeEntry(entry.dir);
      removed.push(entry.id);
    } catch {}
  }
  return { removed };
}

module.exports = {
  CHECKPOINT_FILES,
  TRIGGER_LABEL,
  checkpointDir,
  createCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  pruneCheckpoints,
  readCheckpoint,
  restoreCheckpoint,
  snapshotFiles,
};
