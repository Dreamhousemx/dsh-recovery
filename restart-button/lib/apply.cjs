"use strict";
// dsh-recovery / restart-button : command line front end for lib/patch.cjs.
//
// The console tab (app/backend/restart-button.js) calls the same library, so
// the two always behave identically.
//
//   node lib\apply.cjs status  [--archive <app.asar>]
//   node lib\apply.cjs verify  [--archive <app.asar>]
//   node lib\apply.cjs apply   [--archive <app.asar>] [--backup-dir <dir>] [--state <file>]
//   node lib\apply.cjs revert  [--archive <app.asar>] [--backup-dir <dir>] [--state <file>]

const path = require("node:path");
const patch = require("./patch.cjs");

function parseArgs(argv) {
  const args = {
    command: argv[0] ?? "status",
    archive: patch.DEFAULT_ARCHIVE,
    backupDir: patch.DEFAULT_BACKUP_DIR,
    stateFile: patch.DEFAULT_STATE_FILE
  };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--archive" || flag === "--asar") {
      args.archive = value;
      i += 1;
    } else if (flag === "--backup-dir") {
      args.backupDir = value;
      i += 1;
    } else if (flag === "--state") {
      args.stateFile = value;
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      args.command = "help";
    } else {
      throw new Error(`无法识别的参数：${flag}`);
    }
  }
  return args;
}

function usage() {
  console.log(`dsh-recovery / restart-button ${patch.TOOL_VERSION}

  node lib\\apply.cjs status  [--archive <app.asar>]
  node lib\\apply.cjs verify  [--archive <app.asar>]
  node lib\\apply.cjs apply   [--archive <app.asar>] [--backup-dir <dir>] [--state <file>]
  node lib\\apply.cjs revert  [--archive <app.asar>] [--backup-dir <dir>] [--state <file>]

默认 asar：${patch.DEFAULT_ARCHIVE}
安装/还原都是原地等长改写：条目偏移不变，因此可以在 DeepSeek Harness
运行中执行，重启应用后生效。恢复器窗口的「重启按钮」页签调用同一套逻辑。

提示：工作区根目录下旧工具 dsh-restart-menu-patch\\revert.cmd 会把 asar
退回更早的原始构建，请改用本工具的 revert。`);
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (line) => console.log(line);
  const options = { archive: args.archive, backupDir: args.backupDir, stateFile: args.stateFile, log };

  switch (args.command) {
    case "status":
      patch.status(options);
      return 0;
    case "verify":
      return patch.verify(options).failures === 0 ? 0 : 1;
    case "apply": {
      const result = patch.apply(options);
      if (!result.ok) {
        console.error(`\n[X] ${result.error ?? "apply 失败"}`);
        return 1;
      }
      return 0;
    }
    case "revert": {
      const result = patch.revert(options);
      if (!result.ok) {
        console.error(`\n[X] ${result.error ?? "revert 失败"}`);
        return 1;
      }
      return 0;
    }
    case "help":
      return usage();
    default:
      throw new Error(`未知命令：${args.command}（可用：status / verify / apply / revert / help）`);
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`\n[X] ${error.message}`);
  process.exitCode = 1;
}
