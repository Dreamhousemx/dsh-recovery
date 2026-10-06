"use strict";
// Builds payload/lib/main.js and payload/lib/preload-app.cjs for the restart button patch.
//
// Why a build step: the patch must not move a single byte of any other entry in
// the archive, so both replaced files must keep their exact original length.
// Every edit below is therefore paired with a documentation trim, and the build
// reports the remaining bytes it still has to absorb (a marked padding comment).
//
// Usage:
//   node lib/build-payload.cjs                 # report deltas only
//   node lib/build-payload.cjs --write         # write payload/lib/*

const fs = require("node:fs");
const path = require("node:path");
const { readHeader, entryAt, readEntry, sha256 } = require("./asar.cjs");

const PROJECT = path.resolve(__dirname, "..");
const SRC = process.env.DSH_PATCH_SRC ?? path.resolve(PROJECT, "..", "..", ".dsh-src", "lib");
const ASAR = process.env.DSH_PATCH_ASAR ?? "D:\\Dev Tools\\DeepSeek Harness\\resources\\app.asar";
const OUT = path.join(PROJECT, "payload", "lib");
const WRITE = process.argv.includes("--write");
const MAX_PAD = 400;

// The recovery console the third menu item starts. Backslashes are literal here:
// the string below is JavaScript source, so each one is doubled.
const CONSOLE_EXE = '"D:\\\\Workspace\\\\DeepSeek Harness\\\\dsh-recovery\\\\.runtime\\\\dsh-recovery.exe"';

const lines = (...rows) => rows.join("\n");

const MAIN_INSERT = lines(
  "\t// The restart menu owns the reload/restart entries; DSH_RECOVERY_CONSOLE overrides the console location.",
  `\tconst RECOVERY_CONSOLE = process.env.DSH_RECOVERY_CONSOLE ?? ${CONSOLE_EXE};`,
  "\tconst launchRecoveryConsole = () => new Promise((resolve) => {",
  "\t\tconst env = { ...process.env };",
  "\t\tdelete env.ELECTRON_RUN_AS_NODE;",
  "\t\tconst child = spawn(RECOVERY_CONSOLE, [], {",
  "\t\t\tdetached: true,",
  "\t\t\tstdio: \"ignore\",",
  "\t\t\tenv",
  "\t\t});",
  "\t\tchild.once(\"error\", (error) => {",
  "\t\t\tconsole.error(\"recovery console\", error);",
  "\t\t\tresolve(false);",
  "\t\t});",
  "\t\tchild.once(\"spawn\", () => {",
  "\t\t\tchild.unref();",
  "\t\t\tresolve(true);",
  "\t\t});",
  "\t});",
  "\tconst restartItems = () => [",
  "\t\t{",
  "\t\t\tlabel: currentDesktopLocale().messages.reloadPageMenu,",
  "\t\t\trole: \"reload\"",
  "\t\t},",
  "\t\t{",
  "\t\t\tlabel: currentDesktopLocale().messages.restartAppHostMenu,",
  "\t\t\tclick: () => {",
  "\t\t\t\tif (quitting) return;",
  "\t\t\t\tapp.relaunch();",
  "\t\t\t\tquitWithoutConfirmation();",
  "\t\t\t}",
  "\t\t},",
  "\t\t{",
  "\t\t\tlabel: currentDesktopLocale().messages.restartRecoveryMenu,",
  "\t\t\tclick: async () => {",
  "\t\t\t\tif (quitting) return;",
  "\t\t\t\tif (!await launchRecoveryConsole()) {",
  "\t\t\t\t\tdialog.showErrorBox(currentDesktopLocale().messages.restartRecoveryMenu, RECOVERY_CONSOLE);",
  "\t\t\t\t\treturn;",
  "\t\t\t\t}",
  "\t\t\t\tquitWithoutConfirmation();",
  "\t\t\t}",
  "\t\t}",
  "\t];",
  `\t// dsh-restart-button-patch:__PAD__ (bytes added to keep this file at its original length; see README.md)`,
  ""
);

// The reload/restart entries no longer belong to the Application menu.
const MAIN_DEV_BLOCK = lines(
  "\t\t...development ? [",
  "\t\t\t{ type: \"separator\" },",
  "\t\t\t{",
  "\t\t\t\tlabel: currentDesktopLocale().messages.reloadPageMenu,",
  "\t\t\t\trole: \"reload\"",
  "\t\t\t},",
  "\t\t\t{",
  "\t\t\t\tlabel: currentDesktopLocale().messages.restartAppHostMenu,",
  "\t\t\t\tclick: () => {",
  "\t\t\t\t\tif (quitting) return;",
  "\t\t\t\t\tapp.relaunch();",
  "\t\t\t\t\tquitWithoutConfirmation();",
  "\t\t\t\t}",
  "\t\t\t}",
  "\t\t] : [],",
  ""
);

const edits = [
  {
    file: "main.js",
    name: "去掉 applicationItems 里的开发块（刷新页面/重启应用与Host 不再出现在应用菜单）",
    from: MAIN_DEV_BLOCK,
    to: ""
  },
  {
    file: "main.js",
    name: "新增 restartItems / launchRecoveryConsole / RECOVERY_CONSOLE",
    from: "\tconst applicationItems = () => [",
    to: () => `${MAIN_INSERT}\tconst applicationItems = () => [`
  },
  {
    file: "main.js",
    name: "windowsMenu 允许 name===\"restart\"",
    from: "if (name !== \"application\" && name !== \"edit\" || typeof x !== \"number\"",
    to: "if (name !== \"application\" && name !== \"edit\" && name !== \"restart\" || typeof x !== \"number\""
  },
  {
    file: "main.js",
    name: "菜单项分支加入 restart",
    from: "const items = name === \"application\" ? applicationItems() : [",
    to: "const items = name === \"application\" ? applicationItems() : name === \"restart\" ? restartItems() : ["
  },
  {
    file: "main.js",
    name: "英文文案 restartRecoveryMenu",
    from: "\trestartAppHostMenu: \"Restart App and Host\",\n",
    to: "\trestartAppHostMenu: \"Restart App and Host\",\n\trestartRecoveryMenu: \"Restart into Recovery Mode\",\n"
  },
  {
    file: "main.js",
    name: "中文文案 restartRecoveryMenu",
    from: "\trestartAppHostMenu: \"重启应用与 Host\",\n",
    to: "\trestartAppHostMenu: \"重启应用与 Host\",\n\trestartRecoveryMenu: \"重启到恢复模式\",\n"
  },
  {
    file: "main.js",
    name: "精简 writeFileAtomic 文档注释（等长代价）",
    from: lines(
      "* Replace `filename` with `content` in one atomic step, creating parent",
      "* directories. The content is first written to a random-suffix sibling opened",
      "* with exclusive create (`wx`): the open refuses to follow a symlink planted",
      "* at the temp path, and the fresh inode carries `options.mode` through the",
      "* rename, so replacing a wider-permission file narrows it without a chmod",
      "* race. The rename also replaces a symlinked target itself instead of writing",
      "* through to its referent, and the same-directory sibling keeps the rename on",
      "* one filesystem. Windows replacement retries transient `EACCES`, `EBUSY`,",
      "* and `EPERM` failures for a bounded interval while the complete temp file",
      "* remains the rename source. On any remaining failure the temp file is",
      "* removed and the failure rethrown. Crash durability (fsync) is out of scope.",
      ""
    ),
    to: lines(
      "* Replace `filename` with `content` in one atomic step through a",
      "* random-suffix sibling opened with exclusive create (`wx`), so the rename",
      "* cannot follow a planted symlink and inherits `options.mode`. Windows",
      "* retries transient `EACCES`/`EBUSY`/`EPERM` failures for a bounded",
      "* interval. Crash durability (fsync) is out of scope.",
      ""
    )
  },
  {
    file: "main.js",
    name: "精简 Host 子进程构造函数文档注释（等长代价）",
    from: lines(
      "\t* @param node - Absolute Electron executable in Node mode.",
      "\t* @param runtimeDir - Immutable packages carried by the current application.",
      "\t* @param projectDir - Desktop plugin profile and child working directory.",
      "\t* @param inspectPort - Optional loopback inspector port for workspace development.",
      "\t* @param environment - Environment inherited by the Host and its plugin subprocesses.",
      "\t* @param onFailure - Receives the first unexpected child failure, including after readiness.",
      "\t* @param primaryRuntime - Optional bundled dependency payload; when supplied, missing sibling",
      "\t*   `office-skills` resources fail Host startup.",
      "\t* @param packageManager - Bundled pnpm entry and Node launcher directory, scoped to package operations.",
      "\t* @param onPlatformSession - Private credential updates for embedded Platform views.",
      "\t*/",
      ""
    ),
    to: lines(
      "\t* Host child parameters are documented on the assignments below.",
      "\t*/",
      ""
    )
  },
  {
    file: "preload-app.cjs",
    name: "重启按钮 createButton(\"restart\", 2)",
    from: "\tconst buttons = [createButton(\"application\", 0), createButton(\"edit\", 1)];",
    to: lines(
      "\tconst buttons = [createButton(\"application\", 0), createButton(\"edit\", 1), createButton(\"restart\", 2)];",
      "\t// dsh-restart-button-patch:__PAD__ (bytes added to keep this file at its original length; see README.md)"
    )
  },
  {
    file: "preload-app.cjs",
    name: "精简 syncWindowFullscreen 文档注释（等长代价）",
    from: lines(
      "/**",
      "* Mirrors the window's macOS and Windows fullscreen state onto `<html data-fullscreen>` so",
      "* CSS drops the clearance for hidden native window controls. The main",
      "* process sends the state on every transition and after each load.",
      "*/",
      ""
    ),
    to: lines(
      "/** Mirrors the window's macOS/Windows fullscreen state onto `<html data-fullscreen>`. */",
      ""
    )
  },
  {
    file: "preload-app.cjs",
    name: "按钮文案复用 messages.restartApplication（重启）",
    from: "\t\tbuttons[1].textContent = messages.edit;\n",
    to: "\t\tbuttons[1].textContent = messages.edit;\n\t\tbuttons[2].textContent = messages.restartApplication;\n"
  },
  {
    file: "preload-app.cjs",
    name: "左右方向键在三个按钮间循环",
    from: "const next = buttons[index === 0 ? 1 : 0];",
    to: "const next = buttons[(index + 1) % buttons.length];"
  },
  {
    file: "preload-app.cjs",
    name: "精简 installWindowsMenu 文档注释（等长代价）",
    from: lines(
      "/**",
      "* Mount the Windows caption menubar without moving focus out of the active editor.",
      "* @returns Language refresh and document teardown operations.",
      "*/",
      ""
    ),
    to: lines(
      "/** Mount the Windows caption menubar without moving focus out of the active editor. */",
      ""
    )
  }
];

const byteLength = (text) => Buffer.byteLength(text, "utf8");
const apply = (text, edit) => {
  const hits = text.split(edit.from).length - 1;
  if (hits !== 1) throw new Error(`${edit.file}: 「${edit.name}」匹配 ${hits} 次（需要 1 次）`);
  const replacement = typeof edit.to === "function" ? edit.to() : edit.to;
  return text.replace(edit.from, replacement);
};

const main = () => {
  const fd = fs.openSync(ASAR, "r");
  let sizes;
  let current;
  try {
    const header = readHeader(fd);
    sizes = {
      "main.js": entryAt(header.json, "lib/main.js").size,
      "preload-app.cjs": entryAt(header.json, "lib/preload-app.cjs").size
    };
    current = {
      "main.js": sha256(readEntry(fd, header, "lib/main.js").buf),
      "preload-app.cjs": sha256(readEntry(fd, header, "lib/preload-app.cjs").buf)
    };
  } finally {
    fs.closeSync(fd);
  }
  process.stdout.write(`asar      ${ASAR}\n`);
  process.stdout.write(`源码      ${SRC}\n`);
  process.stdout.write(`目标长度  main.js ${sizes["main.js"]}  preload-app.cjs ${sizes["preload-app.cjs"]}\n`);
  process.stdout.write(`当前散列  main.js ${current["main.js"].slice(0, 16)}  preload-app.cjs ${current["preload-app.cjs"].slice(0, 16)}\n\n`);

  const report = [];
  for (const file of ["main.js", "preload-app.cjs"]) {
    const source = fs.readFileSync(path.join(SRC, file), "utf8");
    process.stdout.write(`${file}  原始 ${byteLength(source)} 字节  sha256 ${sha256(Buffer.from(source)).slice(0, 16)}\n`);
    let text = source;
    for (const edit of edits.filter((entry) => entry.file === file)) {
      const before = byteLength(text);
      text = apply(text, edit);
      const delta = byteLength(text) - before;
      process.stdout.write(`  ${delta >= 0 ? "+" : ""}${String(delta).padStart(6)}  ${edit.name}\n`);
    }
    const target = sizes[file];
    const gap = target - byteLength(text);
    process.stdout.write(`  小计 ${byteLength(text)} 字节；距目标 ${gap} 字节（正数=由填充注释补齐，负数=还要再精简 ${-gap} 字节注释）\n`);
    if (gap < 0) throw new Error(`${file}: 仍多出 ${-gap} 字节，需要再精简注释`);
    if (gap > MAX_PAD) throw new Error(`${file}: 需填充 ${gap} 字节，超过上限 ${MAX_PAD}`);
    const marker = "__PAD__";
    const hits = text.split(marker).length - 1;
    if (hits !== 1) throw new Error(`${file}: 填充标记出现 ${hits} 次（需要 1 次）`);
    text = text.replace(marker, "=".repeat(gap + byteLength(marker)));
    if (byteLength(text) !== target) throw new Error(`${file}: 填充后 ${byteLength(text)} 字节 ≠ ${target}`);
    if (text.includes("__PAD__")) throw new Error(`${file}: 填充标记未被替换`);
    report.push({ file, bytes: byteLength(text), padding: gap, target });
    if (WRITE) {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, file), text, "utf8");
      process.stdout.write(`  已写出 ${path.join(OUT, file)}\n`);
    }
    process.stdout.write("\n");
  }
  if (WRITE) fs.writeFileSync(path.join(PROJECT, "payload", "build.json"), `${JSON.stringify({
    builtAt: new Date().toISOString(),
    asar: ASAR,
    source: SRC,
    targets: report
  }, null, 2)}\n`, "utf8");
  process.stdout.write(WRITE ? "payload 已生成\n" : "仅报告（加 --write 生成 payload）\n");
};

main();
