"use strict";
// Submission engine for the awesome-dsh-plugin list (收录插件).
//
// The list accepts one YAML file per plugin — `data/plugins/<owner>__<repo>.yml`
// — and generates both READMEs from it. Everything a submission must satisfy is
// stated in the list's contributing.md; this module turns those rules into
// checks that run against a local checkout of the plugin repository, plus the
// exact file (and PR text) the submission needs.
//
// Why it lives here rather than in a DSH plugin: the checks are filesystem and
// git work on a repository, they must run before the plugin is ever installed,
// and this console already owns "inspect a directory the app cannot load".
//
// Only Node built-ins are used. `git` and the network are optional: a missing
// git or an offline machine degrades to "unknown" findings, never a crash.

const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// ---------------------------------------------------------------------------
// Constants from contributing.md
// ---------------------------------------------------------------------------

/** The category slugs the list accepts. Not frozen upstream, but this is the set today. */
const CATEGORIES = [
  "agi",
  "ui",
  "usage",
  "theme",
  "model",
  "identity",
  "session",
  "memory",
  "tools",
  "wsl",
  "browser",
  "vision",
  "voice",
  "docs",
  "skill",
  "workflow",
  "git",
  "notify",
  "dev",
  "security",
  "remote",
  "market",
  "fun",
];

const CATEGORY_HINTS = {
  agi: ["agent", "agi", "autonomous", "reasoning", "plan", "think"],
  ui: ["ui", "panel", "settings", "layout", "width", "sidebar", "interface", "button", "menu"],
  usage: ["usage", "token", "cost", "billing", "quota", "statistics", "stats"],
  theme: ["theme", "skin", "appearance", "color", "colour", "dark", "font", "palette"],
  model: ["model", "llm", "provider", "openai", "anthropic", "deepseek", "inference"],
  identity: ["identity", "profile", "persona", "name", "avatar", "login"],
  session: ["session", "handoff", "history", "context", "conversation", "transcript", "archive"],
  memory: ["memory", "remember", "recall", "rag", "vector", "embedding", "knowledge"],
  tools: ["tool", "tools", "function", "mcp", "exec", "shell", "utility"],
  wsl: ["wsl", "windows-subsystem", "linux"],
  browser: ["browser", "chrome", "playwright", "puppeteer", "web", "page", "crawl"],
  vision: ["vision", "image", "screenshot", "ocr", "pixel", "diff", "multimodal"],
  voice: ["voice", "tts", "stt", "speech", "audio", "microphone", "wake"],
  docs: ["docs", "document", "markdown", "pdf", "docx", "readme", "export"],
  skill: ["skill", "skills", "prompt", "instruction"],
  workflow: ["workflow", "pipeline", "automation", "orchestrate", "schedule", "batch"],
  git: ["git", "commit", "branch", "merge", "repository", "diff"],
  notify: ["notify", "notification", "alert", "toast", "sound", "reminder"],
  dev: ["dev", "debug", "build", "test", "lint", "compile", "diagnose", "log"],
  security: ["security", "auth", "permission", "sandbox", "secret", "token-guard", "guard"],
  remote: ["remote", "ssh", "tunnel", "server", "sync", "cloud"],
  market: ["market", "store", "registry", "index", "installer"],
  fun: ["fun", "game", "joke", "pet", "easter", "play"],
};

const LIST_SLUG = "awesome-dsh-plugin/awesome-dsh-plugin";
const LIST_URL = `https://github.com/${LIST_SLUG}`;
const CONTRIBUTING_URL = `${LIST_URL}/blob/main/contributing.md`;
const NEW_FILE_URL = `${LIST_URL}/new/main/data/plugins`;

/** Repository names that are bundles of other plugins, not plugins themselves. */
const MAX_ENTRIES_PER_PR = 3;

const RULES = {
  singleFile: "R1 一个文件就是全部投稿",
  bundle: "R2 声明 dsh.bundle manifest",
  patch: "R3 cordis.patch.yml 存在且可插入",
  code: "R4 真实的可用代码",
  age: "R5 仓库创建满 1 天",
  topic: "R6 仓库带 dsh-plugin topic",
  description: "R7 描述属实且无营销词",
  category: "R8 分类贴合插件实际做的事",
  naming: "R9 文件名与 name 符合规则",
  icon: "R10 图标是 GitHub 托管的位图",
  screenshots: "R11 截图声明合规",
  count: "R12 一个 PR 最多 3 条",
  duplicate: "R13 不与已有条目重复",
  meta: "R14 不是纯聚合包",
  upstream: "R15 依赖指向原作者",
  peer: "R16 官方包用 peerDependencies 且范围含预发布分支",
  readme: "R17 不手工编辑生成的 README",
  maintained: "R18 项目处于活跃维护状态",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function readJsonOrUndefined(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return undefined;
  }
}

/**
 * Run one git command in a repository.
 *
 * `safe.directory` is passed explicitly for this invocation: the console often
 * runs under a different OS account than the one that created the checkout, and
 * git refuses to read such a repository ("dubious ownership"). That refusal used
 * to make every git fact read as "absent", which then surfaced as a bogus
 * "仓库没有 GitHub 远端" failure. Passing it per call avoids permanently editing
 * the user's global git config.
 */
function runGit(dir, args) {
  const safe = path.resolve(dir).replace(/\\/gu, "/");
  try {
    const outcome = spawnSync("git", ["-C", dir, "-c", `safe.directory=${safe}`, ...args], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    return outcome.status === 0 ? String(outcome.stdout ?? "").trim() : undefined;
  } catch {
    return undefined;
  }
}

function firstNonEmptyLine(text) {
  return String(text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "");
}

// ---------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------

/**
 * Parse every shape of repository reference a human or an AI might paste:
 * a GitHub URL (optionally with `/tree/<ref>/<subpath>`), a bare `owner/repo`,
 * an `owner/repo#sub` shorthand, or a local path.
 */
function parseRepoRef(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (raw === "") return { kind: "empty" };

  // A path that exists on disk wins: "owner/repo" is a common directory layout
  // too, and treating a real directory as a remote would be wrong.
  if (isDirectory(raw) || isFile(raw)) return { kind: "local", dir: path.resolve(raw) };

  const bare = raw.replace(/^git\+/u, "").replace(/\.git$/u, "").replace(/\/+$/u, "");

  // Every URL dialect `git remote` and `package.json` use, including the forms
  // that broke identity detection: `git+ssh://`, `ssh://`, and scp-style
  // `git@github.com:owner/repo`. They all must yield owner/repo, not a path.
  const gitUrl = bare.match(
    /^(?:(?:https?|ssh|git|git\+ssh|git\+https):\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com[/:]([^/\s:]+)\/([^/\s:]+)(?:\/tree\/([^/\s]+)(?:\/(.+?))?)?$/u,
  );
  if (gitUrl !== null) {
    return {
      kind: "remote",
      owner: gitUrl[1],
      repo: gitUrl[2].replace(/\.git$/u, ""),
      ref: gitUrl[3],
      subpath: gitUrl[4] === undefined ? undefined : gitUrl[4].replace(/\/+$/u, ""),
    };
  }

  const hash = bare.match(/^(?:github\.com[/:])?([^/#\s:]+)\/([^/#\s:]+)#([^/\s]+)$/u);
  if (hash !== null) return { kind: "remote", owner: hash[1], repo: hash[2], subpath: hash[3], ref: undefined };

  const short = bare.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u);
  if (short !== null) return { kind: "remote", owner: short[1], repo: short[2] };

  return { kind: "local", dir: path.resolve(raw) };
}

/** `owner/repo` from a git remote, in any of the URL dialects git accepts. */
function parseGitRemote(url) {
  const text = String(url ?? "").trim().replace(/\.git$/u, "");
  if (text === "") return undefined;
  const ssh = text.match(/^(?:ssh:\/\/)?git@[^:]+:(.+)$/u);
  const rest = ssh === null ? text : ssh[1];
  const parts = rest.replace(/^https?:\/\/[^/]+\//u, "").split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  return { owner: parts[0], repo: parts[parts.length - 1] };
}

/** Local git facts: remote, default branch, first/last commit dates. */
function gitFacts(dir) {
  if (!isDirectory(path.join(dir, ".git"))) return { available: false };
  const remote = runGit(dir, ["remote", "get-url", "origin"]);
  const branch = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const first = runGit(dir, ["log", "--reverse", "--format=%aI", "-1"]);
  const last = runGit(dir, ["log", "-1", "--format=%aI"]);
  const origin = parseGitRemote(remote);
  return {
    available: true,
    remote,
    owner: origin?.owner,
    repo: origin?.repo,
    branch: branch === "" || branch === "HEAD" ? undefined : branch,
    firstCommit: first === "" ? undefined : first,
    lastCommit: last === "" ? undefined : last,
  };
}

// ---------------------------------------------------------------------------
// GitHub metadata (optional; a failure is "unknown", never a failed check)
// ---------------------------------------------------------------------------

function fetchJson(url, { timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    let request;
    try {
      request = https.get(
        url,
        {
          headers: {
            "user-agent": "dsh-recovery",
            accept: "application/vnd.github+json",
          },
          timeout,
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            resolve({ ok: false, status: response.statusCode });
            return;
          }
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
            if (body.length > 512 * 1024) request.destroy();
          });
          response.on("end", () => {
            try {
              resolve({ ok: true, value: JSON.parse(body) });
            } catch {
              resolve({ ok: false, status: "invalid-json" });
            }
          });
        },
      );
      request.on("timeout", () => request.destroy());
      request.on("error", () => resolve({ ok: false, status: "network" }));
    } catch {
      resolve({ ok: false, status: "network" });
    }
  });
}

/** Public repository facts from the GitHub API: created_at, archived, topics, license. */
async function fetchRepoMeta(owner, repo) {
  if (typeof owner !== "string" || typeof repo !== "string") return { ok: false, status: "unknown-repo" };
  const response = await fetchJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  if (response.ok !== true) return { ok: false, status: response.status };
  const value = response.value ?? {};
  return {
    ok: true,
    createdAt: value.created_at,
    updatedAt: value.pushed_at ?? value.updated_at,
    archived: value.archived === true,
    disabled: value.disabled === true,
    topics: Array.isArray(value.topics) ? value.topics : [],
    defaultBranch: value.default_branch,
    stars: value.stargazers_count,
    license: value.license?.spdx_id,
  };
}

// ---------------------------------------------------------------------------
// Repository inspection
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/iu;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo"]);

/** Walk a repository (bounded) counting real code files and bytes, skipping build output. */
function scanCode(dir, { maxFiles = 4000 } = {}) {
  const files = [];
  const stack = [dir];
  while (stack.length > 0 && files.length < maxFiles) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(child);
        continue;
      }
      if (!entry.isFile() || !CODE_EXTENSIONS.test(entry.name)) continue;
      let bytes = 0;
      try {
        bytes = fs.statSync(child).size;
      } catch {}
      files.push({ file: path.relative(dir, child).replace(/\\/gu, "/"), bytes });
    }
  }
  return {
    files,
    count: files.length,
    bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    substantial: files.filter((entry) => entry.bytes >= 200),
  };
}

/**
 * Lines that actually do something: blank lines, `//` comments and block
 * comments are dropped. A repository whose whole "implementation" is comments is
 * a placeholder, however many bytes it occupies.
 */
function countRealCodeLines(dir, files, { maxBytes = 512 * 1024 } = {}) {
  let lines = 0;
  let read = 0;
  let inBlock = false;
  for (const entry of files) {
    if (read >= maxBytes) break;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, entry.file), "utf8");
    } catch {
      continue;
    }
    read += text.length;
    for (const raw of text.split(/\r?\n/u)) {
      const line = raw.trim();
      if (line === "") continue;
      if (inBlock) {
        if (line.includes("*/")) inBlock = false;
        continue;
      }
      if (line.startsWith("/*") || line.startsWith("/**")) {
        if (!line.includes("*/")) inBlock = true;
        continue;
      }
      if (line.startsWith("//") || line.startsWith("#") || line.startsWith("*")) continue;
      lines += 1;
    }
  }
  return lines;
}

/** Root manifest plus `packages/*`, `plugins/*`, `apps/*` manifests that declare dsh.bundle. */
function manifestCandidates(dir) {
  const found = [];
  const rootFile = path.join(dir, "package.json");
  if (isFile(rootFile)) found.push({ file: rootFile, dir, subpath: undefined, manifest: readJsonOrUndefined(rootFile) });
  for (const group of ["packages", "plugins", "apps"]) {
    const groupDir = path.join(dir, group);
    if (!isDirectory(groupDir)) continue;
    let names;
    try {
      names = fs.readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(groupDir, entry.name);
      const file = path.join(subDir, "package.json");
      if (!isFile(file)) continue;
      const manifest = readJsonOrUndefined(file);
      if (manifest?.dsh?.bundle === undefined) continue;
      found.push({ file, dir: subDir, subpath: `${group}/${entry.name}`, manifest });
    }
  }
  return found.filter((entry) => entry.manifest !== undefined);
}

function isBundleManifest(manifest) {
  return manifest !== undefined && manifest.dsh !== undefined && manifest.dsh.bundle !== undefined;
}

/** A patch-only bundle has no host entry; that is legitimate. */
function declaresEntry(manifest) {
  if (typeof manifest?.main === "string") return true;
  if (manifest?.dsh?.client !== undefined) return true;
  const exportsField = manifest?.exports;
  if (typeof exportsField === "string") return true;
  if (exportsField === null || typeof exportsField !== "object") return false;
  return [".", "./index", "./server", "./host"].some((key) => exportsField[key] !== undefined);
}

/** Inline object form `dsh.bundle: { patch: "./cordis.patch.yml" }`; index form is not supported upstream. */
function declaredPatchFile(manifest) {
  const bundle = manifest?.dsh?.bundle;
  const value = typeof bundle === "string" ? bundle : bundle?.patch;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Minimal structural read of a cordis.patch.yml: does it actually insert anything? */
function inspectPatch(file) {
  if (!isFile(file)) return { exists: false };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { exists: true, readable: false };
  }
  const inserts = (text.match(/^\s*-\s*insert:\s*$/gmu) ?? []).length + (text.match(/^\s*insert:\s*$/gmu) ?? []).length;
  const names = [...text.matchAll(/^\s*name:\s*(\S+)\s*$/gmu)].map((match) => match[1]);
  return {
    exists: true,
    readable: true,
    bytes: Buffer.byteLength(text, "utf8"),
    inserts,
    names,
    // A patch that only ever disables things is not a plugin.
    hasInsert: inserts > 0,
  };
}

// ---------------------------------------------------------------------------
// Description / field validation
// ---------------------------------------------------------------------------

const MARKETING = [
  "best",
  "amazing",
  "awesome",
  "revolutionary",
  "world-class",
  "cutting-edge",
  "game-changing",
  "leading",
  "ultimate",
  "powerful",
  "seamless",
  "最强大",
  "最好",
  "第一",
  "领先",
  "颠覆",
  "革命性",
  "完美",
  "极致",
  "神器",
];

/**
 * Turn a manifest description into something closer to a list line: collapse
 * whitespace (a one-liner must stay one line) and make sure it ends with a
 * period. It stays a *draft* — the caller still has to vouch that it describes
 * the plugin.
 */
function normalizeDescription(text) {
  const single = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (single === "") return "";
  return /[.!?。！？]$/u.test(single) ? single : `${single}.`;
}

function validateDescription(text, locale) {
  const problems = [];
  const value = typeof text === "string" ? text.trim() : "";
  if (value === "") {
    if (locale === "zh") return { ok: true, problems }; // zh is optional
    problems.push("缺少描述：只有 description.en 是必填的");
    return { ok: false, problems };
  }
  if (/[\r\n]/u.test(value)) problems.push("描述必须是单行");
  const end = locale === "zh" ? /[。！？.!?]$/u : /[.!?]$/u;
  if (!end.test(value)) problems.push(locale === "zh" ? "描述需以句号结尾（中文可用「。」）" : "Description must end with a period");
  if (value.length > 200) problems.push(`描述过长（${value.length} 字符），列表行读起来会断`);
  const lower = value.toLowerCase();
  const hits = MARKETING.filter((word) => lower.includes(word.toLowerCase()));
  if (hits.length > 0) problems.push(`含营销词：${hits.join("、")}；描述只说功能`);
  return { ok: problems.length === 0, problems };
}

/** Claims in a description that must be verified against the code by hand. */function descriptionClaims(text) {
  const value = String(text ?? "");
  return {
    numbers: [...value.matchAll(/\b(\d{1,4})\s*(?:个|tools?|domains?|commands?|种|条|项)/giu)].map((match) => match[0]),
    identifiers: [...value.matchAll(/`([^`]{2,40})`/gu)].map((match) => match[1]),
    capitalizedApis: [...value.matchAll(/\b([A-Z][A-Za-z]+(?:[A-Z][A-Za-z]+)+)\b/gu)].map((match) => match[1]),
  };
}

function validateCategory(value) {
  if (value === undefined || value === "") return { ok: true, problems: [] };
  if (CATEGORIES.includes(value)) return { ok: true, problems: [] };
  return { ok: false, problems: [`${value} 不在可用取值中: ${CATEGORIES.join(" ")}`] };
}

/** Suggest a category from the manifest, package name and README, without pretending to be certain. */
function suggestCategory({ manifest, name, readme }) {
  const haystack = [
    name,
    manifest?.description,
    ...(Array.isArray(manifest?.keywords) ? manifest.keywords : []),
    String(readme ?? "").slice(0, 6000),
  ]
    .filter((part) => typeof part === "string")
    .join(" ")
    .toLowerCase();
  const scores = new Map();
  for (const [category, words] of Object.entries(CATEGORY_HINTS)) {
    let score = 0;
    for (const word of words) {
      if (word.length < 3) continue;
      const hits = haystack.split(word).length - 1;
      if (hits > 0) score += Math.min(hits, 4);
    }
    if (score > 0) scores.set(category, score);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const category = ranked[0]?.[0];
  return { category, alternatives: ranked.slice(1, 4).map(([name]) => name).filter((name) => name !== category) };
}

function validateIcon(value) {
  if (value === undefined || value === "") return { ok: true, problems: [] };
  const problems = [];
  if (!/^https:\/\//u.test(value)) problems.push("图标必须是 https 链接");
  if (!/^https:\/\/(?:raw\.githubusercontent\.com|github\.com|user-images\.githubusercontent\.com|camo\.githubusercontent\.com)\//u.test(value)) {
    problems.push("图标必须托管在 GitHub（raw.githubusercontent.com / github.com 等），第三方图床会被拒绝");
  }
  if (/\.svg(?:$|\?)/iu.test(value)) problems.push("SVG 会被拒绝，请用 png/jpg/jpeg/webp");
  else if (!/\.(?:png|jpe?g|webp)(?:$|\?)/iu.test(value)) problems.push("图标必须是 png/jpg/jpeg/webp");
  return { ok: problems.length === 0, problems };
}

function validateTarball(value) {
  if (value === undefined || value === "") return { ok: true, problems: [], warning: undefined };
  const problems = [];
  if (!/^https:\/\//u.test(value)) problems.push("tarball 必须是 https");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\//u.test(value)) problems.push("tarball 必须托管在 GitHub Release 上");
  if (!/\.tgz(?:$|\?)/iu.test(value)) problems.push("tarball 必须是 .tgz");
  let warning;
  if (/\/releases\/latest\/download\//u.test(value) && /-\d+\.\d+\.\d+\.tgz(?:$|\?)/u.test(value)) {
    warning = "资产名带版本号时 latest/download/ 会在下次发版后 404；改成不带版本号的文件名，或钉住 release tag";
  }
  return { ok: problems.length === 0, problems, warning };
}

/** `screenshots.json` in the plugin repository (1-8 images, GitHub-hosted or repo-relative). */
function inspectScreenshots(dir) {
  const file = path.join(dir, "screenshots.json");
  if (!isFile(file)) return { ok: true, present: false, problems: [], images: [] };
  const parsed = readJsonOrUndefined(file);
  if (parsed === undefined) return { ok: false, present: true, problems: ["screenshots.json 不是合法 JSON"], images: [] };
  const images = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.screenshots) ? parsed.screenshots : undefined;
  if (images === undefined) return { ok: false, present: true, problems: ["screenshots.json 必须是数组或 { screenshots: [...] }"], images: [] };
  const problems = [];
  if (images.length < 1 || images.length > 8) problems.push(`截图数量为 ${images.length}，需要 1-8 张`);
  for (const image of images) {
    if (typeof image !== "string" || image.trim() === "") {
      problems.push("截图路径必须是非空字符串");
      continue;
    }
    if (/^https?:\/\//u.test(image)) {
      if (!/^https:\/\/(?:raw\.githubusercontent\.com|user-images\.githubusercontent\.com|camo\.githubusercontent\.com|github\.com)\//u.test(image)) {
        problems.push(`绝对 URL 必须是 GitHub 托管的 https 链接: ${image}`);
      }
      continue;
    }
    if (image.startsWith("/") || image.split(/[\\/]/u).includes("..")) {
      problems.push(`相对路径不能跳出插件目录: ${image}`);
      continue;
    }
    if (!isFile(path.join(dir, image))) problems.push(`文件不存在: ${image}`);
  }
  return { ok: problems.length === 0, present: true, problems, images };
}

// ---------------------------------------------------------------------------
// YAML emission
// ---------------------------------------------------------------------------

/** Single-quote a YAML scalar when a plain one would be misread or trimmed. */
function yamlScalar(value) {
  const text = String(value);
  const needsQuote =
    text === "" ||
    /^[\s>|*&!%@`[\]{},#-]/u.test(text) ||
    /:\s/u.test(text) ||
    /\s#/u.test(text) ||
    /^\s|\s$/u.test(text) ||
    /^(?:true|false|null|yes|no|on|off|~)$/iu.test(text) ||
    /^-?\d+(?:\.\d+)?$/u.test(text);
  if (!needsQuote) return text;
  return `'${text.replace(/'/gu, "''")}'`;
}

/** The exact entry file the list expects, in the field order contributing.md documents. */
function renderEntry(entry) {
  const lines = [
    `url: ${yamlScalar(entry.url)}`,
    `name: ${yamlScalar(entry.name)}`,
    `category: ${yamlScalar(entry.category)}`,
    "description:",
    `  en: ${yamlScalar(entry.description.en)}`,
  ];
  if (entry.description.zh !== undefined && entry.description.zh !== "") {
    lines.push(`  zh: ${yamlScalar(entry.description.zh)}`);
  }
  if (entry.icon !== undefined && entry.icon !== "") lines.push(`icon: ${yamlScalar(entry.icon)}`);
  if (entry.tarball !== undefined && entry.tarball !== "") lines.push(`tarball: ${yamlScalar(entry.tarball)}`);
  return `${lines.join("\n")}\n`;
}

/** `owner__repo.yml`, or `owner__repo--packages-my-plugin.yml` for a monorepo subpackage. */
function entryFileName({ owner, repo, subpath }) {
  const base = `${slug(owner)}__${slug(repo)}`;
  if (typeof subpath !== "string" || subpath === "") return `${base}.yml`;
  return `${base}--${subpath.split("/").filter(Boolean).map(slug).join("-")}.yml`;
}

function slug(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-");
}

/** Read every entry in a clone of the list, for duplicate detection and the 3-per-PR count. */
function listEntries(listDir) {
  const pluginsDir = path.join(listDir, "data", "plugins");
  if (!isDirectory(pluginsDir)) return { available: false, entries: [] };
  let names;
  try {
    names = fs.readdirSync(pluginsDir).filter((name) => /\.ya?ml$/iu.test(name));
  } catch {
    return { available: false, entries: [] };
  }
  const entries = names.map((name) => {
    let text = "";
    try {
      text = fs.readFileSync(path.join(pluginsDir, name), "utf8");
    } catch {}
    return {
      file: name,
      url: firstNonEmptyLine(text.match(/^url:\s*(.*)$/mu)?.[1]?.replace(/^['"]|['"]$/gu, "")),
      name: firstNonEmptyLine(text.match(/^name:\s*(.*)$/mu)?.[1]?.replace(/^['"]|['"]$/gu, "")),
      category: firstNonEmptyLine(text.match(/^category:\s*(.*)$/mu)?.[1]?.replace(/^['"]|['"]$/gu, "")),
    };
  });
  return { available: true, entries };
}

function normalizeRepoUrl(url) {
  return String(url ?? "")
    .trim()
    .replace(/^git\+/u, "")
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "")
    .replace(/^http:\/\//u, "https://")
    .replace(/^https?:\/\/(?:www\.)?github\.com\//u, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function finding(id, level, detail, fix) {
  return { rule: id, title: RULES[id], level, detail, fix };
}

/**
 * Run every contributing.md rule that can be decided from a repository checkout.
 *
 * `input`:
 *   dir         local plugin repository (or its monorepo subpackage)
 *   url         listing URL override (defaults to the git remote)
 *   owner/repo  optional identity override when the checkout has no remote
 *   category, descriptionEn, descriptionZh, icon, tarball   entry fields
 *   listDir     a clone of awesome-dsh-plugin, enables duplicate + count checks
 *   online      allow the GitHub API lookups (repo age, topics, archived)
 *   countInPr   how many entries this PR adds (default 1)
 */
async function check(input = {}) {
  const findings = [];
  const dir = typeof input.dir === "string" && input.dir !== "" ? path.resolve(input.dir) : undefined;

  if (dir === undefined || !isDirectory(dir)) {
    findings.push(finding("bundle", "fail", "没有给出存在的插件仓库目录", "选择一个插件仓库的根目录（或 monorepo 的子包目录）"));
    return { ok: false, dir, findings, entry: undefined, yaml: undefined, fileName: undefined };
  }

  const git = gitFacts(dir);
  const candidates = manifestCandidates(dir);
  const root = candidates.find((entry) => entry.dir === dir);
  const bundleCandidate = candidates.find((entry) => isBundleManifest(entry.manifest));
  // Identity may come from the manifest, so it is resolved after the manifests
  // are read. `manifest` below is the same object used by the rest of the check.
  const identity = resolveIdentity(input, git, (bundleCandidate ?? root)?.manifest);

  // ---- R2 manifest -------------------------------------------------------
  if (bundleCandidate === undefined) {
    const clientOnly = candidates.filter((entry) => entry.manifest?.dsh?.client !== undefined);
    if (clientOnly.length > 0) {
      findings.push(
        finding(
          "bundle",
          "fail",
          "只声明了 dsh.client —— 那样无法用 dsh plugin add 安装，是投稿被拒最常见的原因",
          '在 package.json 里加 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }，并在仓库根放一个 cordis.patch.yml',
        ),
      );
    } else if (root !== undefined && root.manifest === undefined) {
      findings.push(finding("bundle", "fail", `${path.join(dir, "package.json")} 不是合法 JSON`, "修好 package.json 后重新检查"));
    } else {
      findings.push(
        finding("bundle", "fail", "仓库里没有任何 package.json 声明 dsh.bundle（根包与 packages/·plugins/·apps/ 子包都查过了）", '声明 "dsh.bundle" 后再提交'),
      );
    }
  } else {
    findings.push(finding("bundle", "ok", `已声明 dsh.bundle${bundleCandidate.subpath === undefined ? "" : `（子包 ${bundleCandidate.subpath}）`}`));
  }

  const manifest = bundleCandidate?.manifest ?? root?.manifest;
  const repoRoot = bundleCandidate?.dir ?? dir;

  // ---- R14 meta-package --------------------------------------------------
  const dependencies = Object.keys(manifest?.dependencies ?? {});
  const looksLikePlugin = dependencies.filter((name) => /^dsh[-@]|^@[^/]+\/dsh-/u.test(name) && !name.startsWith("@deepseek-ai/"));
  const code = scanCode(repoRoot);
  const patch = inspectPatch(path.join(repoRoot, declaredPatchFile(manifest) ?? ""));
  const hasOwnBehaviour =
    (declaresEntry(manifest) && code.count > 0) ||
    (patch.exists && patch.hasInsert === true) ||
    (typeof manifest?.main === "string" && isFile(path.join(repoRoot, manifest.main)));
  if (looksLikePlugin.length > 0 && !hasOwnBehaviour) {
    findings.push(
      finding(
        "meta",
        "fail",
        `内容只有一份依赖清单（${looksLikePlugin.slice(0, 6).join("、")}${looksLikePlugin.length > 6 ? "…" : ""}），自己是聚合包`,
        "列表收插件、不收聚合包：请分别收录依赖里的单个插件（聚合包本身可以继续发布）",
      ),
    );
  } else {
    findings.push(finding("meta", "ok", "不是纯聚合包（有自己的代码或补丁行为）"));
  }

  // ---- R3 patch ----------------------------------------------------------
  const patchRef = declaredPatchFile(manifest);
  if (patchRef !== undefined) {
    if (!patch.exists) {
      findings.push(finding("patch", "fail", `dsh.bundle.patch 指向的 ${patchRef} 不存在`, "在仓库里补上 cordis.patch.yml，或修正路径"));
    } else if (patch.hasInsert !== true) {
      findings.push(finding("patch", "warn", `${patchRef} 里没有发现 insert 条目`, "确认补丁真的插入了插件（只 disable 的补丁等于没有行为）"));
    } else {
      findings.push(finding("patch", "ok", `${patchRef} 存在，包含 insert（${patch.names.slice(0, 4).join(", ")}）`));
    }
  } else if (bundleCandidate !== undefined) {
    findings.push(finding("patch", "warn", "dsh.bundle 没有声明 patch 文件", "若插件只提供运行时入口可忽略；带补丁的插件应声明 dsh.bundle.patch"));
  }

  // ---- R4 real code ------------------------------------------------------
  const realLines = countRealCodeLines(repoRoot, code.files);
  if (code.count === 0) {
    findings.push(finding("code", "fail", "仓库里没有找到任何 .js/.ts 源码（占位仓库、纯 README 仓库不收）", "提交真实可用的实现"));
  } else if (realLines < 10) {
    findings.push(
      finding("code", "fail", `源码里只有 ${realLines} 行有效代码（其余是空行或注释），看起来是占位`, "提交真实可用的实现；占位仓库不收"),
    );
  } else {
    findings.push(finding("code", "ok", `${code.count} 个源码文件、${realLines} 行有效代码`));
  }

  // ---- R5 repo age -------------------------------------------------------
  const age = await resolveAge({ git, identity, online: input.online === true });
  if (age.days === undefined) {
    findings.push(finding("age", "warn", age.reason, "联网后会自动核对；也可用 GitHub API 的 created_at 手动确认"));
  } else if (age.days < 1) {
    findings.push(finding("age", "fail", `仓库只有 ${age.days.toFixed(2)} 天（${age.source}），未满 1 天`, "把功能做完再提交，重新提交不会受影响"));
  } else {
    findings.push(finding("age", "ok", `仓库已存在约 ${Math.floor(age.days)} 天（${age.source}）`));
  }

  // ---- R6 topic ----------------------------------------------------------
  const topics = age.meta?.topics;
  if (Array.isArray(topics)) {
    if (topics.includes("dsh-plugin")) findings.push(finding("topic", "ok", "仓库带有 dsh-plugin topic"));
    else findings.push(finding("topic", "fail", `仓库 topic 中没有 dsh-plugin（当前：${topics.join(", ") || "无"}）`, "在 GitHub 仓库页面添加 dsh-plugin topic"));
  } else {
    findings.push(finding("topic", "warn", "无法读取仓库 topic（未联网或仓库不在 GitHub）", "在 GitHub 仓库页面确认已添加 dsh-plugin topic"));
  }

  // ---- R18 maintained ----------------------------------------------------
  const lastStamp = age.meta?.updatedAt ?? git.lastCommit;
  if (typeof lastStamp === "string" && lastStamp !== "") {
    const days = (Date.now() - new Date(lastStamp).getTime()) / 86400000;
    if (Number.isFinite(days) && days > 365) {
      findings.push(finding("maintained", "warn", `最近一次提交在 ${Math.floor(days)} 天前`, "定期扫描会标记长期停更的条目；确认项目仍在维护"));
    } else {
      findings.push(finding("maintained", "ok", `最近一次提交在 ${Math.max(0, Math.floor(days))} 天前`));
    }
  } else {
    findings.push(finding("maintained", "warn", "无法判断最近一次提交时间（没有 git 历史，也没有联网）", "确认项目仍在维护"));
  }

  // ---- R16 peer dependencies --------------------------------------------
  peerIssues(findings, manifest);

  // ---- R15 upstream dependencies ----------------------------------------
  upstreamIssues(findings, manifest, identity);

  // ---- R7 description ----------------------------------------------------
  // Only an explicit field is checked for format. When the panel field is
  // empty the manifest description is offered as a starting point instead of
  // failing: an untyped field is not a wrong description, and failing here
  // would report a requirement the user has not been asked for yet.
  const typedEn = typeof input.descriptionEn === "string" ? input.descriptionEn.trim() : "";
  const manifestDescription = typeof manifest?.description === "string" ? manifest.description.trim() : "";
  const en = typedEn;
  const zh = typeof input.descriptionZh === "string" ? input.descriptionZh.trim() : "";
  const enCheck = validateDescription(en, "en");
  if (en === "") {
    if (manifestDescription === "") {
      findings.push(finding("description", "fail", "缺少描述：只有 description.en 是必填的", "写一句说明插件做什么的话，以句号结尾，不带营销词"));
    } else {
      const draft = normalizeDescription(manifestDescription);
      const draftCheck = validateDescription(draft, "en");
      findings.push(
        finding(
          "description",
          "warn",
          `还没有填写 description.en；package.json 里现成的一句是：${draft}`,
          draftCheck.ok
            ? "可以直接用这一句（点「用 package.json 的描述」填入），但必须确认它真的描述了功能"
            : `这一句还不能直接用（${draftCheck.problems.join("；")}），需要改写`,
        ),
      );
    }
  } else if (!enCheck.ok) {
    findings.push(finding("description", "fail", enCheck.problems.join("；"), "写一句说明插件做什么的话，以句号结尾，不带营销词"));
  } else {
    findings.push(finding("description", "ok", "描述格式符合要求"));
  }
  const zhCheck = validateDescription(zh, "zh");
  if (!zhCheck.ok) findings.push(finding("description", "warn", `中文描述：${zhCheck.problems.join("；")}`, "可留空由维护者补，但写了就要合规"));
  const claims = descriptionClaims(en);
  const claimCount = claims.numbers.length + claims.identifiers.length;
  if (claimCount > 0) {
    findings.push(
      finding(
        "description",
        "warn",
        `描述里有需要对着代码核实的声明：${[...claims.numbers, ...claims.identifiers].slice(0, 6).join("、")}`,
        "描述会被当作对插件的声明并与代码核对；数字、命令、API 名称必须真实存在，夸大是打回的主因",
      ),
    );
  }

  // ---- R8 category -------------------------------------------------------
  const suggestion = suggestCategory({ manifest, name: manifest?.name, readme: readReadme(dir) });
  const category = typeof input.category === "string" && input.category !== "" ? input.category.trim() : suggestion.category;
  const categoryCheck = validateCategory(category);
  if (!categoryCheck.ok) {
    findings.push(finding("category", "fail", categoryCheck.problems.join("；"), `从这些里挑一个：${CATEGORIES.join(" ")}`));
  } else if (category === undefined) {
    findings.push(finding("category", "warn", "无法从仓库内容推断分类", `手动挑一个最接近的：${CATEGORIES.join(" ")}`));
  } else {
    findings.push(
      finding(
        "category",
        "ok",
        `分类 ${category}${suggestion.category === category ? "（由仓库内容推断）" : ""}${suggestion.alternatives.length > 0 ? `；备选 ${suggestion.alternatives.join("/")}` : ""}`,
      ),
    );
  }

  // ---- R9 naming ---------------------------------------------------------
  const naming = resolveNaming({ identity, input, git, subpath: bundleCandidate?.subpath ?? subpathFromDir(dir, identity) });
  if (naming.fileName === undefined) {
    findings.push(finding("naming", "fail", naming.problem, "用 owner/repo 或 GitHub 仓库链接，或在配置里补上仓库地址"));
  } else {
    findings.push(finding("naming", "ok", `条目文件 ${naming.fileName}，name 为 ${naming.name}`));
  }

  // ---- R10 icon / R11 screenshots ---------------------------------------
  const iconCheck = validateIcon(input.icon);
  if (!iconCheck.ok) findings.push(finding("icon", "fail", iconCheck.problems.join("；"), "换成 GitHub 托管的 png/jpg/webp，或不写（回退作者头像）"));
  else if (input.icon !== undefined && input.icon !== "") findings.push(finding("icon", "ok", "图标链接符合要求"));

  const shots = inspectScreenshots(repoRoot);
  if (!shots.ok) findings.push(finding("screenshots", "fail", shots.problems.join("；"), "修好插件仓库里的 screenshots.json（1-8 张，GitHub 托管或仓库内相对路径）"));
  else findings.push(finding("screenshots", "ok", shots.present ? `screenshots.json 声明了 ${shots.images.length} 张截图` : "没有 screenshots.json（市场会从 README 抽取）"));

  const tarballCheck = validateTarball(input.tarball);
  if (!tarballCheck.ok) findings.push(finding("naming", "fail", tarballCheck.problems.join("；"), "tarball 必须是 GitHub Release 上的 https .tgz"));
  if (tarballCheck.warning !== undefined) findings.push(finding("naming", "warn", tarballCheck.warning, "改成不带版本号的文件名，或钉住 release tag"));

  // ---- R13 duplicate + R12 count ----------------------------------------
  const list = typeof input.listDir === "string" && input.listDir !== "" ? listEntries(path.resolve(input.listDir)) : { available: false, entries: [] };
  if (list.available) {
    const target = normalizeRepoUrl(naming.url ?? "");
    const clash = list.entries.find((entry) => normalizeRepoUrl(entry.url) === target && target !== "");
    if (clash === undefined) {
      findings.push(finding("duplicate", "ok", `列表里还没有这个仓库（已检查 ${list.entries.length} 条）`));
    } else if (clash.file === naming.fileName) {
      findings.push(finding("duplicate", "warn", `这个仓库已在列表里（${clash.file}），本次是更新自己的条目`, "更新时只改自己那一条，不要动别人的"));
    } else {
      findings.push(finding("duplicate", "warn", `已存在指向同一仓库的条目：${clash.file}`, "两个插件做同一件事时先到者保留位置，但更好的一方可以取代；确认是分叉或确实做了新东西"));
    }
  } else {
    findings.push(finding("duplicate", "warn", "没有指定 awesome-dsh-plugin 的本地克隆，跳过了重复检查", "在「列表仓库」里选一下克隆目录，可启用重复检查与写入"));
  }

  // R12 is a fact about the pull request, so it is checked with or without a clone.
  const countInPr = Number.isFinite(input.countInPr) ? input.countInPr : 1;
  if (countInPr > MAX_ENTRIES_PER_PR) {
    findings.push(finding("count", "fail", `一个 PR 最多 ${MAX_ENTRIES_PER_PR} 条，本次填了 ${countInPr}`, "拆成多个 PR；多个都是自己的，还要挑最值得留的几个"));
  } else {
    findings.push(
      finding("count", "ok", `本次 PR 收录 ${countInPr} 条（上限 ${MAX_ENTRIES_PER_PR}${list.available ? "" : "，未与列表核对"}）`),
    );
  }

  // ---- R1 / R17 process notes (always informational) ---------------------
  findings.push(finding("singleFile", "ok", "投稿只需新增 data/plugins/<owner>__<repo>.yml 一个文件；README 由脚本生成，不要手改"));
  findings.push(finding("readme", "ok", "生成 README 只在本地预览：npm ci && node scripts/generate-readme.mjs（提交结果必须与数据源一致）"));

  // ---- assemble ----------------------------------------------------------
  // `description.en` is the one required field, so an entry (and therefore the
  // YAML) only exists once it is present. Generating `en: undefined` would hand
  // the caller a file that parses but says nothing.
  const entry =
    naming.fileName === undefined || category === undefined || en === ""
      ? undefined
      : {
          url: naming.url,
          name: naming.name,
          category,
          description: { en, zh: zh === "" ? undefined : zh },
          icon: input.icon === undefined || input.icon === "" ? undefined : input.icon,
          tarball: input.tarball === undefined || input.tarball === "" ? undefined : input.tarball,
        };
  const yaml = entry === undefined ? undefined : renderEntry(entry);

  const fails = findings.filter((item) => item.level === "fail");
  const warns = findings.filter((item) => item.level === "warn");
  return {
    ok: fails.length === 0,
    verdict: fails.length === 0 ? (warns.length === 0 ? "pass" : "pass-with-warnings") : "blocked",
    dir,
    repoRoot,
    identity,
    git: { remote: git.remote, branch: git.branch, firstCommit: git.firstCommit, lastCommit: git.lastCommit },
    manifest: manifest === undefined ? undefined : { name: manifest.name, version: manifest.version, description: manifest.description },
    entry,
    yaml,
    fileName: naming.fileName,
    naming,
    category,
    suggestedCategory: suggestion.category,
    alternatives: suggestion.alternatives,
    screenshots: shots,
    code: { count: code.count, bytes: code.bytes, files: code.files.slice(0, 8).map((entryFile) => entryFile.file) },
    findings,
    counts: { ok: findings.filter((item) => item.level === "ok").length, warn: warns.length, fail: fails.length },
    manualChecklist: manualChecklist({ claims, category, duplicate: list.available }),
    // Pre-built copy payloads: the panel must be able to hand the blocking
    // items to a person or an AI without re-deriving them from `findings`.
    fixesText: { prompt: fixesText({ findings, dir, identity, fileName: naming.fileName }, "prompt"), list: fixesText({ findings }, "list") },
    prBody: entry === undefined ? undefined : renderPrBody(entry, naming, findings),
  };
}

function readReadme(dir) {
  for (const name of ["README.md", "readme.md", "README.zh.md", "README_ZH.md"]) {
    const file = path.join(dir, name);
    if (isFile(file)) {
      try {
        return fs.readFileSync(file, "utf8").slice(0, 8000);
      } catch {}
    }
  }
  return "";
}

/** Owner/repo from the input, the git remote, or (for local-only repos) the folder name. */
function resolveIdentity(input, git, manifest) {
  const ref = parseRepoRef(input.repo ?? input.url ?? "");
  if (ref.kind === "remote") return { owner: ref.owner, repo: ref.repo, subpath: ref.subpath, ref: ref.ref, source: "输入" };
  if (git.available && typeof git.owner === "string" && typeof git.repo === "string") {
    return { owner: git.owner, repo: git.repo, subpath: undefined, ref: git.branch, source: "git remote" };
  }
  // Fall back to the manifest's own `repository`/`homepage`: a checkout without
  // a readable git layer still says where it lives, and that is what the listing
  // URL has to match anyway.
  const declared = typeof manifest?.repository === "string" ? manifest.repository : manifest?.repository?.url;
  const fromRepo = parseRepoRef(declared ?? "");
  if (fromRepo.kind === "remote") {
    return { owner: fromRepo.owner, repo: fromRepo.repo, subpath: fromRepo.subpath, ref: fromRepo.ref, source: "package.json repository" };
  }
  const fromHomepage = parseRepoRef(typeof manifest?.homepage === "string" ? manifest.homepage : "");
  if (fromHomepage.kind === "remote") {
    return { owner: fromHomepage.owner, repo: fromHomepage.repo, subpath: fromHomepage.subpath, ref: fromHomepage.ref, source: "package.json homepage" };
  }
  return { owner: undefined, repo: undefined, subpath: undefined, ref: undefined, source: "无" };
}

function subpathFromDir(dir, identity) {
  if (identity.subpath !== undefined) return identity.subpath;
  const name = path.basename(dir);
  const parent = path.basename(path.dirname(dir));
  if (["packages", "plugins", "apps"].includes(parent)) return `${parent}/${name}`;
  return undefined;
}

function resolveNaming({ identity, input, git, subpath }) {
  const owner = identity.owner;
  const repo = identity.repo;
  if (owner === undefined || repo === undefined) {
    return { problem: "无法确定 owner/repo：仓库没有 GitHub 远端，也没有手动指定仓库地址" };
  }
  const ref = typeof input.ref === "string" && input.ref !== "" ? input.ref : identity.ref ?? git.branch ?? "main";
  const name = subpath === undefined ? `${owner}/${repo}` : `${owner}/${repo}#${subpath.split("/").filter(Boolean).pop()}`;
  const url =
    subpath === undefined
      ? `https://github.com/${owner}/${repo}`
      : `https://github.com/${owner}/${repo}/tree/${ref}/${subpath}`;
  return { owner, repo, ref, subpath, name, url, fileName: entryFileName({ owner, repo, subpath }) };
}

async function resolveAge({ git, identity, online }) {
  if (online) {
    const meta = await fetchRepoMeta(identity.owner, identity.repo);
    if (meta.ok === true) {
      const createdAt = new Date(meta.createdAt);
      if (!Number.isNaN(createdAt.getTime())) {
        return { days: (Date.now() - createdAt.getTime()) / 86400000, source: "GitHub API created_at", meta };
      }
    }
  }
  if (typeof git.firstCommit === "string" && git.firstCommit !== "") {
    const first = new Date(git.firstCommit);
    if (!Number.isNaN(first.getTime())) {
      return { days: (Date.now() - first.getTime()) / 86400000, source: "首次提交（近似仓库年龄）", meta: undefined };
    }
  }
  return { days: undefined, reason: "无法判断仓库年龄：未联网且本地没有 git 历史", meta: undefined };
}

/** Official packages belong in peerDependencies, with an explicit prerelease branch in the range. */
function peerIssues(findings, manifest) {
  if (manifest === undefined) return;
  const merged = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) };
  const misplaced = Object.keys(merged).filter((name) => name.startsWith("@deepseek-ai/"));
  if (misplaced.length > 0) {
    findings.push(
      finding("peer", "warn", `官方包写进了 dependencies：${misplaced.join("、")}`, "官方 @deepseek-ai/* 包应声明为 peerDependencies"),
    );
  }
  const peers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => name.startsWith("@deepseek-ai/"));
  const risky = peers.filter(([, range]) => {
    const text = String(range);
    if (text.includes("||")) {
      // Each branch must carry its own prerelease comparator.
      return text.split("||").some((branch) => !/-[A-Za-z]/u.test(branch.trim()));
    }
    // No explicit branch: only a comparator that itself carries a prerelease tag
    // keeps prerelease builds of the harness installable.
    return !/-[A-Za-z]+\.\d/u.test(text);
  });
  if (risky.length > 0) {
    findings.push(
      finding(
        "peer",
        "warn",
        `这些 peer 范围会静默排除 harness 的预发布构建：${risky.map(([name, range]) => `${name}@${range}`).join("；")}`,
        '改用显式 || 分支，例如 ">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0"',
      ),
    );
  } else if (peers.length > 0) {
    findings.push(finding("peer", "ok", "官方包用 peerDependencies，且范围含预发布分支"));
  }
}

/** A dependency that resolves to someone else's repository must not be a re-uploaded snapshot. */
function upstreamIssues(findings, manifest, identity) {
  if (manifest === undefined) return;
  const suspicious = [];
  for (const [name, spec] of Object.entries({ ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) })) {
    const text = String(spec);
    const gh = text.match(/(?:github:|github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s#.]+)/u);
    if (gh !== null && identity.owner !== undefined && gh[1].toLowerCase() !== String(identity.owner).toLowerCase()) {
      suspicious.push(`${name} → ${gh[1]}/${gh[2]}`);
    }
  }
  if (suspicious.length > 0) {
    findings.push(
      finding(
        "upstream",
        "warn",
        `依赖指向他人账号下的仓库：${suspicious.join("；")}`,
        "依赖必须解析到原作者的仓库或其发布的 npm 包；把别人插件重新上传成副本会被拒",
      ),
    );
  }
}

/**
 * The text for the「必须修正」copy buttons.
 *
 * `prompt` is a self-contained instruction block for an AI: where the repo is,
 * every failing rule with its description and suggested fix, and what output is
 * expected. `list` is just the problems, for a person or a GitHub issue.
 *
 * Neither embeds the plugin's source — the fixer reads the repository itself,
 * which keeps the text short and avoids pasting code into the wrong context.
 */
function fixesText(check, mode = "prompt") {
  const fails = (check?.findings ?? []).filter((item) => item.level === "fail");
  const repo = check?.identity?.owner === undefined ? undefined : `${check.identity.owner}/${check.identity.repo}`;
  const describe = (item) => `- ${item.rule}（${item.title}）\n  问题：${item.detail}${item.fix === undefined ? "" : `\n  修法：${item.fix}`}`;

  if (mode === "list") return ["必须修正：", ...fails.map(describe)].join("\n");

  return [
    "请修改这个 DeepSeek Harness 插件仓库，使它满足 awesome-dsh-plugin 的收录要求。",
    "",
    `仓库目录：${check?.dir ?? "（未知）"}`,
    repo === undefined ? undefined : `仓库：https://github.com/${repo}`,
    check?.fileName === undefined ? undefined : `列表条目文件：data/plugins/${check.fileName}`,
    "",
    "以下项目前不通过（逐条修完再重新检查）：",
    "",
    ...fails.map(describe),
    "",
    "要求：",
    "1. 直接读仓库里的文件确认现状，不要假设上面的描述已经完整；",
    "2. 只改与这些问题相关的文件，不要顺手重写无关代码；",
    "3. 描述类问题（R7）必须让描述与代码一致，如实描述功能，不要夸大；",
    "4. 改完逐条说明「改了什么、为什么这样改」；",
    "5. 不要手工编辑 awesome-dsh-plugin 的两个 README。",
    "",
    `规则来源：${CONTRIBUTING_URL}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function manualChecklist({ claims, category, duplicate }) {
  return [
    { id: "claims", text: "逐条核对描述里的声明与代码一致（数字、命令、API 名称都要真实存在）", detail: [...claims.numbers, ...claims.identifiers].slice(0, 6) },
    { id: "category", text: `确认分类 ${category ?? "（待定）"} 贴合插件实际做的事（选得不准维护者会改，不会打回）`, detail: [] },
    { id: "duplicate", text: duplicate ? "确认没有与已有条目重复；分叉需证明自己维护得更好或确实做了新东西" : "在列表仓库里过一遍是否有重复条目（本次未检查）", detail: [] },
    { id: "alarming", text: "扫一遍源码：没有混淆代码、凭据外传、异常的安装期行为", detail: [] },
    { id: "ownEntry", text: "PR 只改自己这一条，不重写别人的描述，不手工编辑生成的 README", detail: [] },
  ];
}

function renderPrBody(entry, naming, findings) {
  const fails = findings.filter((item) => item.level === "fail");
  const warns = findings.filter((item) => item.level === "warn");
  return [
    `Add ${entry.name}`,
    "",
    `- Entry: \`data/plugins/${naming.fileName}\``,
    `- Repository: ${entry.url}`,
    `- Category: \`${entry.category}\``,
    "",
    "本次 PR 只新增这一个条目文件；两个 README 由脚本生成，未手工编辑。",
    fails.length === 0 ? "" : `\n未通过的检查：\n${fails.map((item) => `- ${item.rule}: ${item.detail}`).join("\n")}`,
    warns.length === 0 ? "" : `\n需要人工确认：\n${warns.map((item) => `- ${item.rule}: ${item.detail}`).join("\n")}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
    .trimEnd()
    .concat("\n");
}

// ---------------------------------------------------------------------------
// Writing the entry into a clone of the list
// ---------------------------------------------------------------------------

/** Prove a directory really is a clone of the list before writing into it. */
function inspectListDir(listDir) {
  const dir = path.resolve(listDir);
  const pluginsDir = path.join(dir, "data", "plugins");
  if (!isDirectory(pluginsDir)) return { ok: false, reason: `不是列表仓库：缺少 ${path.join("data", "plugins")}` };
  const manifest = readJsonOrUndefined(path.join(dir, "package.json"));
  if (manifest?.name !== undefined && manifest.name !== "awesome-dsh-plugin") {
    return { ok: false, reason: `package.json 的 name 是 ${manifest.name}，不是 awesome-dsh-plugin` };
  }
  return { ok: true, dir, pluginsDir, entries: listEntries(dir).entries.length };
}

/**
 * Write `<listDir>/data/plugins/<file>` atomically.
 *
 * Refuses to overwrite a different existing entry unless `allowUpdate` is set:
 * a submission must never rewrite someone else's line.
 */
function writeEntry({ listDir, yaml, fileName, allowUpdate = false }) {
  const list = inspectListDir(listDir);
  if (!list.ok) return { ok: false, error: list.reason };
  if (typeof yaml !== "string" || yaml.trim() === "") return { ok: false, error: "没有要写入的条目内容" };
  if (typeof fileName !== "string" || !/^[A-Za-z0-9._-]+\.yml$/u.test(fileName)) {
    return { ok: false, error: `条目文件名不合法: ${String(fileName)}` };
  }
  const target = path.join(list.pluginsDir, fileName);
  const exists = isFile(target);
  if (exists) {
    let previous = "";
    try {
      previous = fs.readFileSync(target, "utf8");
    } catch {}
    if (previous === yaml) return { ok: true, unchanged: true, file: target, message: `${fileName} 已是这个内容，无需改动` };
    if (allowUpdate !== true) {
      return {
        ok: false,
        error: `${fileName} 已存在且内容不同。更新自己的条目前请确认这是你的插件；确认后勾选「允许更新已有条目」。`,
        file: target,
      };
    }
  }
  const temp = path.join(list.pluginsDir, `.${fileName}.${process.pid}.${Date.now().toString(36)}.tmp`);
  fs.writeFileSync(temp, yaml, "utf8");
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    throw error;
  }
  return {
    ok: true,
    created: exists !== true,
    updated: exists === true,
    file: target,
    message: `${exists ? "已更新" : "已写入"} ${path.join("data", "plugins", fileName)}`,
    nextSteps: [
      "在克隆里 npm ci && node scripts/generate-readme.mjs 预览 README（可选，提交结果必须与数据源一致）",
      "git checkout -b add-<owner>__<repo> && git add data/plugins && git commit -m \"Add <name>\"",
      "推送后开 PR；反馈会以 PR 评论指出要改什么",
    ],
  };
}

module.exports = {
  CATEGORIES,
  CONTRIBUTING_URL,
  LIST_URL,
  MAX_ENTRIES_PER_PR,
  NEW_FILE_URL,
  RULES,
  check,
  entryFileName,
  fetchRepoMeta,
  fixesText,
  inspectListDir,
  listEntries,
  parseRepoRef,
  renderEntry,
  suggestCategory,
  validateCategory,
  validateDescription,
  writeEntry,
  yamlScalar,
};
