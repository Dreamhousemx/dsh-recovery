"use strict";
// DSH 恢复器 — renderer.
//
// Renders the single state object produced by app/backend/ipc.js and forwards
// every user action to the `window.recovery` bridge from preload.js. The
// renderer owns no state of its own beyond the active tab: after each action
// the backend re-broadcasts `recovery:status-changed`, which re-renders.

const api = window.recovery;

// A render exception used to leave a blank window with no trace. Record the
// message on `window` so `--ui-check` can report it instead of an opaque
// "Script failed to execute".
window.addEventListener("error", (event) => {
  window.__renderError = `${event.message} (${event.filename}:${event.lineno})`;
});

const TABS = [
  { id: "quick", label: "快速恢复" },
  { id: "plugins", label: "插件管理", badge: (value) => value.selectedProfileDetail?.plugins?.length },
  // The market cannot update some plugins on Desktop (notably itself) and its
  // remove path can stall; this tab performs the same operations against the
  // stopped profile, so it advertises only the problems it can act on.
  {
    id: "updater",
    label: "插件更新",
    badge: (value) => {
      const updater = value.pluginUpdater;
      if (updater === undefined || updater.available !== true) return updater === undefined ? undefined : "!";
      const count = (updater.inconsistent?.length ?? 0) + (updater.stale?.length ?? 0) + (updater.diagnose?.stuck?.length ?? 0);
      return count === 0 ? undefined : count;
    },
  },
  { id: "checkpoints", label: "回滚", badge: (value) => value.checkpoints.length },
  {
    id: "awesome",
    label: "收录插件",
    // The badge reflects the last check only, so an untouched panel stays quiet.
    badge: (value) => {
      const check = value.awesome?.lastCheck;
      if (check === undefined) return undefined;
      if (check.ok !== true) return "!";
      return check.counts?.warn > 0 ? check.counts.warn : undefined;
    },
  },
  {
    id: "restart",
    label: "重启按钮",
    // Warn only when the patch state cannot be read or the archive holds
    // neither the payload nor a backup: an uninstalled patch is a normal state.
    badge: (value) => {
      const patch = value.restartButton;
      if (patch === undefined) return undefined;
      if (patch.available !== true) return "!";
      return patch.entries?.some((entry) => entry.verdict === "unknown") ? "!" : undefined;
    },
  },
  { id: "profiles", label: "切换 Profile", badge: (value) => value.home.profileNames.length },
  { id: "data", label: "重置与数据管理" },
  { id: "diagnostics", label: "诊断" },
];

let state;
let busy = false;
let busyLabel = "正在执行…";
let activeTab = readStoredTab();

// --- DOM helpers ----------------------------------------------------------

function append(parent, children) {
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(child);
  }
  return parent;
}

function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props !== undefined && props !== null) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    }
  }
  return append(node, children ?? []);
}

function clear(node) {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
  return node;
}

function button(label, action, arg, options = {}) {
  return el("button", {
    class: `btn ${options.className ?? ""}`.trim(),
    type: "button",
    text: label,
    title: options.title,
    disabled: busy || options.disabled === true,
    dataset: { action, ...(arg === undefined ? {} : { arg: String(arg) }) },
  });
}

function select(name, value, options) {
  // `id` mirrors the field name so `valueOf()` can read any control back out of
  // the rendered panel, whatever kind it is.
  const node = el("select", { class: "select", id: name, dataset: { select: name }, disabled: busy });
  for (const option of options) {
    node.append(
      el("option", {
        value: option.value,
        text: option.label,
        selected: option.value === value,
      }),
    );
  }
  return node;
}

function chip(text, kind) {
  return el("span", { class: `chip${kind === undefined ? "" : ` chip--${kind}`}`, text });
}

function card({ icon, title, desc, body, actions, actionsEnd, danger, tags }) {
  const head = el("div", { class: "card__head" }, [
    icon === undefined ? undefined : el("span", { class: "card__icon", text: icon }),
    el("div", { class: "card__head-text" }, [
      el("div", { class: "card__title-row" }, [
        el("h2", { class: "card__title", text: title }),
        tags === undefined ? undefined : el("div", { class: "card__tags" }, tags),
      ]),
      desc === undefined ? undefined : el("p", { class: "card__desc", text: desc }),
    ]),
  ]);
  return el("section", { class: `card${danger === true ? " card--danger" : ""}` }, [
    head,
    body === undefined ? undefined : el("div", { class: "card__body" }, Array.isArray(body) ? body : [body]),
    actions === undefined
      ? undefined
      : el("div", { class: `card__actions${actionsEnd === true ? " card__actions--end" : ""}` }, actions),
  ]);
}

function row({ name, mono, sub, side, muted }) {
  return el("div", { class: `row${muted === true ? " row--muted" : ""}` }, [
    el("div", { class: "row__main" }, [
      el("div", { class: `row__name${mono === true ? " row__name--mono" : ""}`, text: name }),
      sub === undefined ? undefined : el("div", { class: "row__sub", text: sub }),
    ]),
    el("div", { class: "row__side" }, side ?? []),
  ]);
}

function list(rows) {
  return el("div", { class: "list" }, rows);
}

function metric(label, value, mono) {
  return el("div", { class: "metric" }, [
    el("div", { class: "metric__label", text: label }),
    el("div", { class: `metric__value${mono === true ? " metric__value--mono" : ""}`, text: value ?? "—" }),
  ]);
}

function metrics(pairs) {
  return el("div", { class: "metric-grid" }, pairs.map(([label, value, mono]) => metric(label, value, mono)));
}

function empty(text) {
  return el("div", { class: "empty", text });
}

function hint(text) {
  return el("p", { class: "hint", text });
}

// A sticky strip pinned to the top of a panel: one-click actions on a long list
// must stay reachable without scrolling past every row.
function panelBar(label, side) {
  return el("div", { class: "pbar" }, [
    el("span", { class: "pbar__label", text: label }),
    el("div", { class: "pbar__side" }, side),
  ]);
}

function joinSub(...parts) {
  const kept = parts.filter((part) => part !== undefined && part !== null && part !== "");
  return kept.length === 0 ? undefined : kept.join(" · ");
}

// --- actions --------------------------------------------------------------

function absorb(response) {
  if (response === undefined || response === null || typeof response !== "object") return response;
  if (response.console !== undefined && response.home !== undefined) {
    state = response;
    render();
    return response;
  }
  if (response.state !== undefined) {
    state = response.state;
    render();
  }
  return response;
}

async function run(label, method, ...args) {
  if (busy) return;
  setBusy(true, label);
  try {
    const response = await api[method](...args);
    absorb(response);
    if (response !== null && typeof response === "object") {
      if (response.ok === false) toast(response.error ?? `${label} 失败`, "error");
      else if (typeof response.result?.message === "string") toast(response.result.message, "ok");
      else if (typeof response.message === "string") toast(response.message, "ok");
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setBusy(false, undefined);
  }
}

const ACTIONS = {
  refresh: () => run("正在刷新状态", "refresh"),
  tab: (arg) => {
    activeTab = arg;
    storeTab(arg);
    render();
  },
  "open-path": (arg) => run("打开路径", "openPath", arg),
  "show-item": (arg) => run("定位文件", "showItem", arg),
  "open-profile-dir": () => run("打开 Profile 目录", "openProfileDir"),
  "choose-home": () => run("选择数据目录", "chooseHome"),
  "reset-home": () => run("恢复默认数据目录", "resetHome"),
  "reset-data": async () => {
    if (!confirm(`将把整个数据目录移入回收站：\n${state.home.path}\n\n下次启动会创建新的默认 Profile。确定继续吗？`)) return;
    await run("重置数据目录", "resetData");
  },
  "select-profile": (arg) => run(`切换到 Profile ${arg}`, "selectProfile", arg),
  "toggle-bundle": (arg) => {
    const plugin = state.selectedProfileDetail?.plugins?.find((entry) => entry.name === arg);
    const enabled = plugin?.enabled === true;
    return run(`${enabled ? "禁用" : "启用"} ${arg}`, "setBundleEnabled", arg, enabled !== true);
  },
  "enable-all-bundles": async () => {
    const detail = state.selectedProfileDetail;
    const plugins = detail?.plugins ?? [];
    const patchEntries = detail?.patchEntries ?? [];
    const off = plugins.filter((plugin) => plugin.bundle === true && plugin.enabled !== true);
    const disabledEntries = patchEntries.filter((entry) => entry.disabled === true);
    if (off.length === 0 && disabledEntries.length === 0) {
      toast("当前 Profile 的插件已全部启用", "ok");
      return;
    }
    if (
      !confirm(
        `一键启用全部插件：\n\n` +
          (off.length === 0
            ? `· 插件层已经全部启用，本次只会处理补丁层\n`
            : `· 将把 ${off.length} 个插件加入 Profile「${detail?.name ?? state.selectedProfile}」的插件层\n` +
              `  ${off.map((plugin) => plugin.name).join("\n  ")}\n` +
              `· 不在依赖中的包与非插件包会被跳过，执行后逐条说明原因\n`) +
          (disabledEntries.length === 0
            ? ""
            : `· 另把 cordis.patch.yml 里 ${disabledEntries.length} 条 disabled: true 改为 false（只动 disabled 这一行，其它内容与 config.enabled 保持不变）：\n` +
              `  ${disabledEntries.map((entry) => entry.id ?? entry.name ?? "?").join("\n  ")}\n`) +
          `· 启用前会自动创建检查点，可随时回滚\n` +
          `\n重启应用后生效。确定继续吗？`,
      )
    )
      return;
    await run("启用全部插件", "enableAllBundles");
  },
  "uninstall-bundle": async (arg) => {
    if (!confirm(`卸载插件：${arg}\n\n包会移入 Profile 内的隔离区，可以随时还原。确定继续吗？`)) return;
    await run(`卸载 ${arg}`, "uninstallBundle", arg);
  },
  "restore-removed": (arg) => run("还原插件", "restoreRemoved", arg),
  "discard-removed": async (arg) => {
    if (!confirm(`永久删除隔离区中的 ${arg}？\n\n此操作不可撤销。`)) return;
    await run("删除隔离区条目", "discardRemoved", arg);
  },
  "sanitize-profile": async () => {
    if (
      !confirm(
        "重置插件集：\n\n" +
          "· 把当前 Profile 的插件集恢复为 DSH 默认（dsh-base + dsh-web-app）\n" +
          "· 现有 cordis.patch.yml 会另存为 .bak 备份，不会删除\n" +
          "· 已下载的包保留在磁盘上\n\n确定继续吗？",
      )
    )
      return;
    await run("重置插件集", "sanitizeProfile");
  },
  "create-checkpoint": () => run("创建检查点", "createCheckpoint", `手动创建于 ${new Date().toLocaleString("zh-CN")}`),
  "restore-checkpoint": async (arg) => {
    if (!confirm(`恢复到检查点 ${arg}？\n\n恢复前会自动为当前状态创建一个新检查点。`)) return;
    await run(`恢复检查点 ${arg}`, "restoreCheckpoint", arg);
  },
  "delete-checkpoint": async (arg) => {
    if (!confirm(`删除检查点 ${arg}？此操作不可撤销。`)) return;
    await run(`删除检查点 ${arg}`, "deleteCheckpoint", arg);
  },
  "delete-all-checkpoints": async () => {
    const total = state.checkpoints.length;
    if (total === 0) {
      toast("当前没有检查点", "ok");
      return;
    }
    const bytes = state.checkpoints.reduce((sum, entry) => sum + (typeof entry.bytes === "number" ? entry.bytes : 0), 0);
    if (
      !confirm(
        `一键删除全部检查点：\n\n` +
          `· 将永久删除 ${total} 个槽位（约 ${formatBytes(bytes)}）\n` +
          `· 包括自动检查点与恢复前的快照，全部不可撤销\n` +
          `· 不影响 Profile 当前内容，只删除历史快照\n\n确定继续吗？`,
      )
    )
      return;
    await run("删除全部检查点", "deleteAllCheckpoints");
  },
  "export-diagnostics": () => run("正在生成诊断包", "exportDiagnostics"),
  "restart-button-apply": async () => {
    if (
      !confirm(
        "安装重启按钮补丁？\n\n" +
          "· 在「应用」「编辑」右侧新增「重启」按钮：刷新页面 / 重启应用与Host / 重启到恢复模式\n" +
          "· 从「应用」菜单移除前两项\n" +
          "· 两个条目按原始字节数原地改写，应用运行时安装也安全\n\n" +
          "重启 DeepSeek Harness 后生效。确定继续吗？",
      )
    )
      return;
    await run("安装重启按钮补丁", "restartButtonApply");
  },
  "restart-button-verify": () => run("校验重启按钮补丁", "restartButtonVerify"),
  "restart-button-revert": async () => {
    if (!confirm("还原重启按钮补丁？\n\n两个条目会恢复为补丁前的原始内容，「应用」菜单重新出现刷新页面 / 重启应用与Host。可以随时重新安装。确定继续吗？")) return;
    await run("还原重启按钮补丁", "restartButtonRevert");
  },

  // --- plugin updater ----------------------------------------------------
  "plugin-repair": async () => {
    const running = state.running.isRunning;
    if (running) return;
    if (
      !confirm(
        "修复插件状态：\n\n" +
          "· 清除上一次操作留下的写入锁与运行记录（仍被运行中进程持有的会保留）\n" +
          "· 让 dsh.profile.bundles 与磁盘上实际安装的插件一致\n" +
          "  （补回被宿主丢掉的条目；移除指向已不存在包的条目）\n" +
          "· 不会改动 @deepseek-ai 自带的组件，也不会替你下载任何插件\n" +
          "· 执行前会自动创建检查点\n\n确定继续吗？",
      )
    )
      return;
    await run("修复插件状态", "pluginRepair", false);
  },
  "plugin-repair-preview": () => run("预览修复内容", "pluginRepair", true),
  "plugin-install": async () => {
    const input = document.getElementById("plugin-install-input");
    const spec = typeof input?.value === "string" ? input.value.trim() : "";
    if (spec === "") {
      toast("请先填入要安装的包名", "error");
      return;
    }
    if (!confirm(`安装插件：${spec}\n\n会用 pnpm 安装到当前 Profile，装完校验入口文件与插件层条目。\n执行前会自动创建检查点。确定继续吗？`)) return;
    const response = await run(`安装 ${spec}`, "pluginInstall", spec, false);
    if (response?.ok === true && input !== null) input.value = "";
  },
  "plugin-update": async (arg) => {
    const plugin = state.pluginUpdater?.rows?.find((entry) => entry.name === arg);
    const from = plugin?.version;
    if (
      !confirm(
        `升级插件：${arg}${from === undefined ? "" : `（当前 ${from}）`}\n\n` +
          "会用 pnpm 重新解析并安装最新版本，然后校验入口文件与插件层条目。\n" +
          "这是市场里「更新」失败时应当走的方式：应用已退出，不会卡在 HMR 队列上。\n" +
          "执行前会自动创建检查点。确定继续吗？",
      )
    )
      return;
    await run(`升级 ${arg}`, "pluginUpdate", arg, false);
  },
  "plugin-check": (arg) => run(`检查 ${arg}`, "pluginCheck", arg),

  // --- 收录插件 ----------------------------------------------------------
  "awesome-choose-repo": () => run("选择插件仓库目录", "awesomeChooseDir", "repo"),
  "awesome-choose-list": () => run("选择列表仓库克隆", "awesomeChooseDir", "list"),
  "awesome-forget-repo": () => run("清除插件仓库路径", "awesomeForgetDir", "repo"),
  "awesome-forget-list": () => run("清除列表仓库路径", "awesomeForgetDir", "list"),
  "awesome-check": async () => {
    const dirInput = document.getElementById("awesome-repo-input");
    const dir = typeof dirInput?.value === "string" && dirInput.value.trim() !== "" ? dirInput.value.trim() : state.awesome?.repoDir;
    if (typeof dir !== "string" || dir.trim() === "") {
      toast("请先指定要收录的插件仓库目录", "error");
      return;
    }
    // A directory typed into the box but never confirmed still needs to reach
    // the backend, so it is set first and validated there.
    if (dir !== state.awesome?.repoDir) {
      const set = await api.awesomeSetDir("repo", dir);
      if (set?.ok === false) {
        toast(set.error ?? "目录无效", "error");
        return;
      }
      absorb(set);
    }
    // Every field is re-read from the panel, so the check always describes what
    // is on screen rather than a stale last result.
    const options = {
      dir: dir.trim(),
      repo: valueOf("awesome-ref-input"),
      category: valueOf("awesome-category-input"),
      descriptionEn: valueOf("awesome-en-input"),
      descriptionZh: valueOf("awesome-zh-input"),
      icon: valueOf("awesome-icon-input"),
      tarball: valueOf("awesome-tarball-input"),
      ref: valueOf("awesome-ref-branch-input"),
    };
    const response = await run("检查收录条件", "awesomeCheck", options);
    if (response?.awesome?.ok === false) toast(`检查未通过：${response.awesome.counts.fail} 项必须修正`, "error");
  },
  "awesome-copy-fixes": async (arg) => {
    const check = state.awesome?.lastCheck;
    const fails = (check?.findings ?? []).filter((item) => item.level === "fail");
    if (fails.length === 0) {
      toast("没有必须修正的项目", "ok");
      return;
    }
    // The engine built both payloads with the check, so the copy always matches
    // the findings on screen.
    const text = arg === "list" ? check.fixesText?.list : check.fixesText?.prompt;
    if (typeof text !== "string" || text === "") {
      toast("没有可复制的内容", "error");
      return;
    }
    await copyText(text, arg === "list" ? `已复制 ${fails.length} 项问题清单` : "已复制给 AI 的修改说明");
  },
  "awesome-use-draft": async () => {
    const draft = state.awesome?.lastCheck?.manifest?.description;
    const input = document.getElementById("awesome-en-input");
    if (typeof draft !== "string" || draft.trim() === "" || input === null) {
      toast("package.json 里没有可用的描述", "error");
      return;
    }
    // Collapse to one line and add the period the list requires.
    const single = draft.replace(/\s+/gu, " ").trim();
    input.value = /[.!?。！？]$/u.test(single) ? single : `${single}.`;
    input.focus();
    toast("已填入，请确认它真的描述了功能后再检查", "ok");
  },
  "awesome-copy": async () => {
    const yaml = state.awesome?.lastCheck?.yaml;
    if (typeof yaml !== "string") {
      toast("还没有生成条目", "error");
      return;
    }
    await copyText(yaml, "条目 YAML 已复制");
  },
  "awesome-copy-pr": async () => {
    const body = state.awesome?.lastCheck?.prBody;
    if (typeof body !== "string") {
      toast("还没有生成 PR 说明", "error");
      return;
    }
    await copyText(body, "PR 说明已复制");
  },
  "awesome-write": async () => {
    const check = state.awesome?.lastCheck;
    if (check?.ok !== true) {
      toast("检查未通过，不能写入", "error");
      return;
    }
    if (!confirm(`把条目写入列表克隆？\n\n文件：data/plugins/${check.fileName}\n\n只会新增或更新这一个文件，不会碰别人的条目。`)) return;
    await run("写入条目", "awesomeWrite", {});
  },
  "awesome-open-contributing": () => run("打开 contributing.md", "openExternal", state.awesome?.contributingUrl),
  "awesome-open-new": () => {
    const file = state.awesome?.lastCheck?.fileName;
    const base = state.awesome?.newFileUrl;
    if (typeof base !== "string") return;
    return run("打开 GitHub", "openExternal", file === undefined ? base : `${base}?filename=${encodeURIComponent(file)}`);
  },

  "set-target": (arg) => run("切换目标应用", "setTarget", arg),
  "choose-target": () => run("选择安装位置", "chooseTarget"),
  "choose-target-exe": () => run("选择应用主程序", "chooseTarget", "exe"),
  "forget-target": async (arg) => {
    if (!confirm(`移除手动指定的安装位置？\n\n${arg}\n\n移除后仍可通过「已发现的安装」或重新手动选择找回。确定继续吗？`)) return;
    await run("移除手动指定的安装", "forgetTarget", arg);
  },
  launch: (arg) => run(arg === "safe" ? "以安全模式启动" : "启动应用", "launchTarget", { mode: arg }),
  stop: () => run("停止应用", "stopTarget"),
  restart: (arg) => {
    if (!confirm(`重启目标应用${arg === "safe" ? "（安全模式）" : ""}？正在运行的会话会被关闭。`)) return;
    return run(arg === "safe" ? "以安全模式重启" : "重启应用", "restartTarget", { mode: arg });
  },
  quit: async () => {
    if (!confirm("退出 DSH 恢复器？")) return;
    await api.quit();
  },
};

const SELECTS = {
  target: (value) => run("切换目标应用", "setTarget", value),
};

// --- render ---------------------------------------------------------------

function mustState() {
  return state;
}

function render() {
  if (state === undefined) return;
  renderTitle();
  renderReason();
  renderTabs();
  renderPanels();
  renderFooter();
}

function renderTitle() {
  const hint = document.getElementById("title-hint");
  if (hint !== null) {
    hint.textContent = `v${state.console.version} · Electron ${state.console.electron} · ${state.console.platform}`;
  }
}

// Electron reports a process per GPU/renderer/utility child too; the main
// process (the one without `--type=`) is what the user should see.
function runningPidText(running) {
  const main = Array.isArray(running?.mainPids) && running.mainPids.length > 0 ? running.mainPids : running?.pids;
  return (main ?? []).join(", ");
}

function renderReason() {
  const host = document.getElementById("reason");
  if (host === null) return;
  const running = state.running.isRunning;
  clear(host).append(
    el("div", { class: "reason__row" }, [
      el("span", { class: "card__icon", text: "ⓘ" }),
      el("h2", { class: "reason__title", text: "当前状态" }),
      chip(state.selected?.label ?? "未找到目标应用", state.selected === undefined ? "danger" : undefined),
      state.selected?.appVersion === undefined ? undefined : chip(`v${state.selected.appVersion}`),
      chip(`Profile: ${state.selectedProfile}`, "mono"),
      chip(running ? `运行中（PID ${runningPidText(state.running)}）` : "未运行", running ? "ok" : "warn"),
    ]),
    el("p", { class: "reason__state", text: `数据目录：${state.home.path}` }),
    el("p", {
      class: "reason__note",
      text: `恢复器独立于 DSH 运行时运行，不加载任何插件；改动 Profile 前必须先停止应用（退出流程会重写 Profile）。数据目录来源：${state.home.sourceLabel}。`,
    }),
  );
}

function renderTabs() {
  const host = document.getElementById("tabs");
  if (host === null) return;
  clear(host);
  for (const tab of TABS) {
    const badge = tab.badge?.(state);
    host.append(
      el(
        "button",
        {
          class: "tab",
          type: "button",
          role: "tab",
          "aria-selected": tab.id === activeTab ? "true" : "false",
          dataset: { action: "tab", arg: tab.id },
        },
        [el("span", { text: tab.label }), badge === undefined || badge === 0 ? undefined : el("span", { class: "tab__badge", text: String(badge) })],
      ),
    );
  }
}

function renderPanels() {
  const host = document.getElementById("panels");
  if (host === null) return;
  clear(host);
  host.append(panel("quick", renderQuick()));
  host.append(panel("plugins", renderPlugins()));
  host.append(panel("updater", renderUpdater()));
  host.append(panel("awesome", renderAwesome()));
  host.append(panel("checkpoints", renderCheckpoints()));
  host.append(panel("restart", renderRestartButton()));
  host.append(panel("profiles", renderProfiles()));
  host.append(panel("data", renderData()));
  host.append(panel("diagnostics", renderDiagnostics()));
}

function panel(id, nodes) {
  return el("section", { class: "panel", dataset: { panel: id, active: id === activeTab ? "true" : "false" } }, nodes);
}

// --- panel: quick recovery ------------------------------------------------

function renderQuick() {
  const detail = state.selectedProfileDetail;
  const running = state.running.isRunning;
  const source = state.selected?.exe;

  const nodes = [
    hint("选择适合当前问题的恢复方式。不确定原因时，可先尝试安全模式；如果已有故障线索，也可以直接管理插件、重置插件集或恢复检查点。"),
    card({
      icon: "🛡",
      title: "安全模式",
      desc: "使用临时数据目录启动，暂不读取原有插件、设置、会话和工作区记录。原有数据会保留；临时目录位于恢复器的 .safemode 下，可随时删除。",
      tags: state.safeModeHomes.length === 0 ? undefined : [chip(`已有 ${state.safeModeHomes.length} 个临时目录`, "warn")],
      actions: [
        running
          ? button("以安全模式重启", "restart", "safe", { className: "btn--primary" })
          : button("以安全模式启动", "launch", "safe", { className: "btn--primary" }),
        running ? button("正常运行重启", "restart", "normal") : button("正常启动", "launch", "normal"),
        state.safeModeHomes.length === 0
          ? undefined
          : button("显示临时目录", "show-item", state.safeModeHomes[state.safeModeHomes.length - 1].dir),
      ],
    }),
    card({
      icon: "⚙",
      title: "插件管理",
      desc: "安装或更新插件后出现问题？查看当前 Profile 的插件，禁用或卸载可能引发问题的第三方插件。",
      body:
        detail === undefined || detail.exists !== true
          ? empty("Profile 目录不存在，无法读取插件。")
          : metrics([
              ["已启用的插件层", String(detail.bundles.length)],
              ["已安装的组合包", String(detail.plugins.length)],
              ["隔离区中的包", String(detail.removed.length)],
              ["补丁条目", `${detail.patchEntries.length}（禁用 ${detail.patchDisabledCount}）`],
            ]),
      actions: [button("管理插件", "tab", "plugins", { className: "btn--primary" })],
    }),
    card({
      icon: "⚡",
      title: "重置插件集",
      desc: "把当前 Profile 的插件集恢复为 DSH 默认（dsh-base + dsh-web-app），并把 cordis.patch.yml 另存为 .bak 备份。已下载的包保留在磁盘上，可重新启用。",
      actions: [
        button("重置插件集", "sanitize-profile", undefined, { className: "btn--danger", disabled: running }),
      ],
    }),
    card({
      icon: "📂",
      title: "打开位置",
      desc: "直接查看恢复器会用到的目录与文件。",
      actions: [
        button("Profile 目录", "open-profile-dir"),
        detail?.patchPath === undefined ? undefined : button("插件补丁", "open-path", detail.patchPath),
        button("数据目录", "open-path", state.home.path),
        button("检查点目录", "open-path", state.checkpointRoot),
        button("恢复器配置", "open-path", state.config.file),
      ],
    }),
  ];

  if (source === undefined) {
    nodes.unshift(
      card({
        title: "未找到目标应用",
        danger: true,
        desc: "恢复器没有在已知安装位置找到 DeepSeek Harness 或 DSH Desktop。可以直接选择安装目录或应用主程序，恢复器会把该位置记住。",
        actions: [
          button("选择安装目录…", "choose-target", undefined, { className: "btn--primary" }),
          button("选择应用主程序…", "choose-target-exe"),
          button("打开恢复器配置", "open-path", state.config.file),
        ],
      }),
    );
  }

  return nodes;
}

// --- panel: plugin management ---------------------------------------------

function renderPlugins() {
  const detail = state.selectedProfileDetail;
  if (detail === undefined || detail.exists !== true) {
    return [hint(`Profile「${state.selectedProfile}」的目录不存在：${detail?.dir ?? state.home.profilesDir}`)];
  }

  const running = state.running.isRunning;
  const bundles = detail.plugins.filter((plugin) => plugin.bundle === true);
  const others = detail.plugins.filter((plugin) => plugin.bundle !== true);
  const allEnabled = bundles.every((plugin) => plugin.enabled === true);
  const offCount = bundles.filter((plugin) => plugin.enabled !== true).length;
  const patchDisabledCount = (detail.patchEntries ?? []).filter((entry) => entry.disabled === true).length;

  const nodes = [
    panelBar(
      `已启用 ${bundles.filter((plugin) => plugin.enabled === true).length} / ${bundles.length} 个插件` +
        (patchDisabledCount > 0 ? ` · 补丁层禁用 ${patchDisabledCount} 条` : ""),
      [
        button("一键启用全部插件", "enable-all-bundles", undefined, {
          className: "btn--primary",
          disabled: running || (allEnabled && patchDisabledCount === 0),
          title: running
            ? "目标应用正在运行，请先停止或重启应用"
            : allEnabled && patchDisabledCount > 0
              ? `插件层已全启用，但 cordis.patch.yml 里还有 ${patchDisabledCount} 条 disabled: true`
              : allEnabled
                ? "所有插件都已启用"
                : `把另外 ${offCount} 个可加载的插件一次性加入插件层`,
        }),
        button("刷新", "refresh", undefined, { className: "btn--ghost" }),
      ],
    ),
    hint(
      "查看当前 Profile 中安装的插件。可以禁用插件（保留安装，启动时不加载），也可以彻底卸载（移入隔离区，可随时还原）。" +
        (running ? " 目标应用正在运行，改动类操作已暂时禁用。" : ""),
    ),
    card({
      title: "插件",
      desc: `Profile ${detail.name} · 清单 ${detail.manifestPath}`,
      tags: running ? [chip("应用运行中", "warn")] : undefined,
      body:
        bundles.length === 0
          ? empty("这个 Profile 还没有启用任何插件。")
          : list(bundles.map((plugin) => pluginRow(plugin, running))),
    }),
  ];

  if (others.length > 0) {
    nodes.push(
      card({
        title: "其他依赖",
        desc: "这些包不是插件组合包（未声明 dsh.bundle.patch），无法作为插件层启停，只列出以便确认安装状态。",
        body: list(
          others.map((plugin) =>
            row({
              name: plugin.name,
              mono: true,
              muted: true,
              sub: joinSub(plugin.categoryLabel, plugin.version, plugin.installedLocal === true ? undefined : "未安装在本地"),
              side: [chip(plugin.enabled === true ? "在插件层中" : "未启用", plugin.enabled === true ? "ok" : undefined)],
            }),
          ),
        ),
      }),
    );
  }

  if (detail.removed.length > 0) {
    nodes.push(
      card({
        title: "隔离区",
        desc: "已卸载的包保存在 Profile 内的 .dsh-recovery/removed 下。还原会把包目录与依赖声明一起写回 Profile。",
        body: list(
          detail.removed.map((entry) =>
            row({
              name: entry.name ?? entry.id,
              mono: true,
              sub: joinSub(entry.version, entry.removedAt === undefined ? undefined : new Date(entry.removedAt).toLocaleString("zh-CN"), entry.id),
              side: [
                button("还原", "restore-removed", entry.id),
                button("永久删除", "discard-removed", entry.id, { className: "btn--danger" }),
              ],
            }),
          ),
        ),
      }),
    );
  }

  nodes.push(
    card({
      title: "Profile 补丁",
      desc: `cordis.patch.yml 由 DSH 与用户共同维护。恢复器只在「一键启用全部插件」时把 disabled: true 改成 false，其余内容一律不动（重置插件集时会另存为 .bak）。共 ${detail.patchEntries.length} 条，其中 ${detail.patchDisabledCount} 条为禁用。`,
      body:
        detail.patchEntries.length === 0
          ? empty("补丁文件中没有条目。")
          : list(
              detail.patchEntries.map((entry) =>
                row({
                  name: entry.id,
                  mono: true,
                  muted: entry.disabled === true,
                  sub: joinSub(entry.name, entry.disabled === true ? "disabled: true" : undefined),
                  side: [chip(entry.disabled === true ? "禁用" : "启用", entry.disabled === true ? "warn" : "ok")],
                }),
              ),
            ),
      actions: [button("打开插件补丁", "open-path", detail.patchPath), button("在文件夹中显示", "show-item", detail.patchPath)],
      actionsEnd: true,
    }),
  );

  return nodes;
}

function pluginRow(plugin, running) {
  const core = plugin.core === true;
  const cannotUninstall = core || plugin.quarantinable !== true;
  return row({
    name: plugin.name,
    mono: true,
    sub: joinSub(plugin.categoryLabel, plugin.version, plugin.installedLocal === true ? undefined : "未安装在本地"),
    side: [
      chip(plugin.enabled === true ? "已启用" : "已禁用", plugin.enabled === true ? "ok" : undefined),
      button(plugin.enabled === true ? "禁用" : "启用", "toggle-bundle", plugin.name, {
        disabled: running || (core && plugin.enabled === true) || (plugin.enabled !== true && plugin.declared !== true),
        title: core
          ? "启动必需的组件，不能禁用"
          : plugin.enabled !== true && plugin.declared !== true
            ? "该包不在 Profile 依赖中，请先用 DSH 安装"
            : undefined,
      }),
      button("卸载", "uninstall-bundle", plugin.name, {
        className: "btn--danger",
        disabled: running || cannotUninstall,
        title: core ? "内置组件不可卸载" : plugin.quarantinable !== true ? "包不在本地，无法移入隔离区" : undefined,
      }),
    ],
  });
}

// --- panel: plugin updater ------------------------------------------------

/**
 * Why this panel exists rather than "just use the market": on DSH Desktop 0.2.1
 * the in-app update path runs `removeBundle()` → pnpm → `hmr.runExclusive()`,
 * and that queue never settles if a plugin's teardown does. pnpm has already
 * deleted the old copy by then, so the UI sticks on "Removing…" and the plugin
 * is gone after a restart. The market also refuses to update itself
 * (`market-self-update`) because removing it unloads the code that would run
 * the reinstall. Both disappear when the package change happens with the app
 * stopped — which is exactly what this console can arrange.
 */
function renderUpdater() {
  const info = state.pluginUpdater;
  const running = state.running.isRunning;

  if (info === undefined) {
    return [hint("插件更新数据尚未读取，请点「刷新」。")];
  }
  if (info.available !== true) {
    return [
      hint(`无法读取 Profile 的插件状态：${info.reason ?? "未知原因"}`),
      hint(`Profile 目录：${info.profileDir ?? "—"}`),
    ];
  }

  const stuck = info.diagnose?.stuck ?? [];
  const notes = info.diagnose?.notes ?? [];
  const stale = info.stale ?? [];
  const inconsistent = info.inconsistent ?? [];
  const rows = info.rows ?? [];
  const installed = rows.filter((entry) => entry.version !== undefined && entry.declared !== undefined);
  const problemCount = stuck.length + stale.length + inconsistent.length;

  const nodes = [
    panelBar(
      problemCount === 0 ? "插件状态一致" : `发现 ${problemCount} 处需要处理`,
      [
        button("修复插件状态", "plugin-repair", undefined, {
          className: "btn--primary",
          disabled: running,
          title: running ? "目标应用正在运行，请先停止或退出应用" : "清理僵死的写入锁与运行记录，并让插件层与磁盘保持一致",
        }),
        button("预览修复内容", "plugin-repair-preview", undefined, { className: "btn--ghost" }),
        button("刷新", "refresh", undefined, { className: "btn--ghost" }),
      ],
    ),
    hint(
      "这些操作直接对 Profile 执行 pnpm，等价于在 DSH 完全退出后手工升级。应用运行时会禁用写入 —— 该状态下市场自己的更新会卡在 HMR 队列上，这里不会。" +
        (info.pnpm === undefined
          ? " 未找到 pnpm，安装/升级/卸载不可用（修复仍可用）。"
          : ` 使用 ${info.pnpm.source}${info.pnpm.version === undefined ? "" : ` 的 pnpm ${info.pnpm.version}`}。`),
    ),
    running ? card({ danger: true, title: "请先退出 DSH", desc: `应用正在运行（PID ${runningPidText(state.running)}）。请用下方「停止」或直接退出 DSH（含托盘图标），然后刷新本页。运行中写入会被应用退出流程覆盖。` }) : undefined,
  ];

  // --- what went wrong last time ------------------------------------------
  if (stuck.length > 0) {
    nodes.push(
      card({
        title: "上次操作卡住了",
        desc: "这些操作只有开始、没有结果。若 pnpm 日志已经写完，说明卡点在 pnpm 之后的宿主重组，而不是包管理器。",
        tags: [chip(`${stuck.length} 项`, "warn")],
        body: list(
          stuck.map((entry) =>
            row({
              name: entry.name,
              mono: true,
              sub: joinSub(
                entry.at === undefined ? undefined : new Date(entry.at).toLocaleString("zh-CN"),
                entry.event,
                entry.pnpmFinished ? "pnpm 已完成" : "pnpm 未确认完成",
                entry.logDir,
              ),
              side: [
                chip(entry.pnpmFinished ? "卡在 HMR" : "原因待定", entry.pnpmFinished ? "warn" : undefined),
                button("重新升级到最新", "plugin-update", entry.name, { className: "btn--primary", disabled: running }),
              ],
            }),
          ),
        ),
      }),
    );
  }

  if (stale.length > 0) {
    nodes.push(
      card({
        title: "残留的锁与运行记录",
        desc: "上一次操作留下的写入锁或运行记录会挡住市场后续的所有操作。修复会清掉它们（仍在运行的进程持有的会保留）。",
        body: list(
          stale.map((item) =>
            row({
              name: item.label ?? item.kind,
              sub: joinSub(item.path, item.pid === undefined ? undefined : `PID ${item.pid}`, item.alive ? "进程仍在运行" : "进程已退出"),
              side: [chip(item.alive ? "保留" : "可清除", item.alive ? "warn" : "ok")],
            }),
          ),
        ),
      }),
    );
  }

  // --- inconsistencies ----------------------------------------------------
  if (inconsistent.length > 0) {
    nodes.push(
      card({
        title: "不一致的插件",
        desc: "这些问题会让下一次启动组不起插件，或在重启后发现「插件不见了」。",
        tags: [chip(`${inconsistent.length} 个`, "warn")],
        body: list(
          inconsistent.map((entry) =>
            row({
              name: entry.name,
              mono: true,
              sub: entry.problems.join("；"),
              side: [
                button("重新安装", "plugin-install", entry.name, { disabled: running }),
                button("检查", "plugin-check", entry.name, { className: "btn--ghost" }),
              ],
            }),
          ),
        ),
      }),
    );
  }

  // --- the one case with no in-app path -----------------------------------
  const market = rows.find((entry) => entry.name === "dshmarket" || entry.name === "dsh-market");
  if (market !== undefined) {
    nodes.push(
      card({
        icon: "🔄",
        title: "更新插件市场本身",
        desc:
          "桌面端的市场不能在自己发起的请求里更新自己（会先把市场从运行中的组合里摘掉，补装那一步就执行不到了），应用内也没有更新入口。这一项只能在这里做。",
        body: metrics([
          ["当前版本", market.version ?? "—"],
          ["声明", market.declared ?? "—"],
          ["插件层", market.inBundles ? "已启用" : "未在插件层"],
        ]),
        actions: [
          button("升级到最新", "plugin-update", market.name, { className: "btn--primary", disabled: running }),
          button("检查安装", "plugin-check", market.name),
        ],
      }),
    );
  }

  // --- every updatable plugin ---------------------------------------------
  nodes.push(
    card({
      title: "已安装的插件",
      desc: "升级会用 pnpm 重新解析该包（包括固定版本号的那些），装完再校验入口文件与插件层条目。",
      body:
        installed.length === 0
          ? empty("这个 Profile 还没有安装任何插件。")
          : list(
              installed.map((entry) =>
                row({
                  name: entry.name,
                  mono: true,
                  muted: entry.problems.length > 0,
                  sub: joinSub(entry.version, entry.declared === entry.version ? undefined : `声明 ${entry.declared}`, entry.bundle ? undefined : "非插件包"),
                  side: [
                    chip(entry.inBundles ? "插件层" : "未启用", entry.inBundles ? "ok" : undefined),
                    button("升级", "plugin-update", entry.name, { className: "btn--primary", disabled: running }),
                    button("检查", "plugin-check", entry.name, { className: "btn--ghost" }),
                  ],
                }),
              ),
            ),
    }),
  );

  // --- install by name ----------------------------------------------------
  nodes.push(
    card({
      title: "安装一个插件",
      desc: "填入 npm 包名或完整 spec（例如 dsh-connect-workbuddy 或 name@1.2.3）。装完若该包声明了 dsh.bundle，会自动加入插件层。",
      body: el("div", { class: "field-row" }, [
        el("input", {
          class: "input",
          type: "text",
          placeholder: "包名或 name@version",
          id: "plugin-install-input",
          spellcheck: "false",
          disabled: running,
        }),
        button("安装", "plugin-install", undefined, { className: "btn--primary", disabled: running }),
      ]),
    }),
  );

  if (notes.length > 0) {
    nodes.push(card({ title: "日志说明", desc: "以下情况已经不需要处理，仅作记录。", body: list(notes.map((note) => row({ name: note, muted: true })) ) }));
  }

  return nodes.filter((node) => node !== undefined);
}

// --- panel: 收录插件 (awesome-dsh-plugin submission) ----------------------

function renderAwesome() {
  const info = state.awesome;
  if (info === undefined) return [hint("收录插件数据尚未读取，请点「刷新」。")];

  const check = info.lastCheck;
  const listReady = info.list?.available === true;
  const dirReady = info.repoExists === true;

  const nodes = [
    hint(
      "按 awesome-dsh-plugin 的 contributing.md 逐条核对一个插件仓库，生成可直接提交的 data/plugins/<owner>__<repo>.yml，" +
        "并（在指定了列表克隆时）把它写进克隆。检查只读，不需要停止 DSH。",
    ),
    card({
      icon: "📥",
      title: "收录到 awesome-dsh-plugin",
      desc: "一个插件一条：目录文件永不冲突，两个 README 由脚本生成，不要手改。",
      tags: [
        chip(listReady ? `列表克隆 ${info.list.entries} 条` : "未指定列表克隆", listReady ? "ok" : "warn"),
        chip(dirReady ? "已指定插件仓库" : "未指定插件仓库", dirReady ? "ok" : "warn"),
      ],
      body: [
        el("div", { class: "field-row" }, [
          el("input", {
            class: "input",
            type: "text",
            id: "awesome-repo-input",
            placeholder: "插件仓库目录，例如 D:\\Workspace\\DeepSeek Harness\\my-plugin",
            spellcheck: "false",
            value: info.repoDir ?? "",
          }),
          button("选择目录…", "awesome-choose-repo", undefined, { className: "btn--primary" }),
          info.repoDir === undefined ? undefined : button("清除", "awesome-forget-repo", undefined, { className: "btn--ghost" }),
        ]),
        el("div", { class: "field-row" }, [
          el("input", {
            class: "input",
            type: "text",
            id: "awesome-list-input",
            placeholder: "awesome-dsh-plugin 的本地克隆（可选：启用重复检查与写入）",
            spellcheck: "false",
            value: info.listDir ?? "",
          }),
          button("选择克隆…", "awesome-choose-list", undefined, { className: "btn--ghost" }),
          info.listDir === undefined ? undefined : button("清除", "awesome-forget-list", undefined, { className: "btn--ghost" }),
        ]),
        hint(
          listReady
            ? "列表克隆可用：会做重复检查，并允许把条目直接写进 data/plugins/。"
            : info.list === undefined || info.list.available === true
              ? "没有列表克隆也能检查，只是跳过重复核对、不能写入。"
              : `列表克隆不可用：${info.list.reason ?? "未知原因"}`,
        ),
      ],
      actions: [
        button("检查并生成条目", "awesome-check", undefined, { className: "btn--primary", disabled: !dirReady }),
        button(check === undefined ? "复制条目 YAML" : "重新复制 YAML", "awesome-copy", undefined, {
          className: "btn--ghost",
          disabled: check?.yaml === undefined,
        }),
        button("写入列表克隆", "awesome-write", undefined, { className: "btn--primary", disabled: !listReady || check?.ok !== true }),
      ],
    }),
  ];

  if (check !== undefined) {
    nodes.push(...renderAwesomeResult(info, check));
  } else {
    nodes.push(
      card({
        title: "尚未检查",
        desc: dirReady
          ? "点「检查并生成条目」开始。检查会读取仓库清单、补丁、源码、图标与截图声明，并（联网时）核对仓库年龄与 topic。"
          : "先指定要收录的插件仓库目录，再执行检查。",
      }),
    );
  }

  nodes.push(renderAwesomeFields(info, check));

  nodes.push(
    card({
      title: "规则与限制",
      desc: "取自 contributing.md。列表收插件、不收纯聚合包；一个 PR 最多 3 条。",
      body: list(
        Object.entries(info.rules ?? {}).map(([id, title]) =>
          row({
            name: title,
            sub: RULE_NOTES[id],
            side: [],
          }),
        ),
      ),
      actions: [],
      actionsEnd: true,
    }),
  );

  return nodes;
}

// One-line reminders for the rules a human (or an AI) is most likely to get wrong.
const RULE_NOTES = {
  singleFile: "只新增 data/plugins/<owner>__<repo>.yml；README 自动生成",
  bundle: "package.json 必须声明 dsh.bundle；只有 dsh.client 无法安装",
  patch: "dsh.bundle.patch 指向的 cordis.patch.yml 必须存在并真的 insert",
  code: "占位、空壳、纯 README 仓库不收",
  age: "仓库创建满 1 天（CI 自动检查）",
  topic: "仓库要加 dsh-plugin topic",
  description: "单行、以句号结尾、只说功能；含「: 」要加引号",
  category: "选贴合实际行为的分类；选不准维护者会改，不会打回",
  naming: "文件名 owner__repo.yml；monorepo 用 owner__repo--路径.yml",
  icon: "仅 GitHub 托管的 png/jpg/webp；SVG 与第三方图床被拒",
  screenshots: "1-8 张，写在插件仓库的 screenshots.json 里",
  count: "一个 PR 最多 3 条，超过 CI 直接拒",
  duplicate: "先到者保留位置，但更好的一方可以取代",
  meta: "纯聚合包不单独收录：收插件，不收聚合包",
  upstream: "聚合包依赖必须指回原作者，不能依赖自己转存的副本",
  peer: "官方 @deepseek-ai/* 用 peerDependencies，范围要带预发布分支",
  readme: "不要手工编辑生成的 README",
  maintained: "停止维护、归档、长期停更的条目会被移除",
};

function renderAwesomeResult(info, check) {
  const nodes = [];
  const verdictChip =
    check.ok === true
      ? chip(check.counts?.warn > 0 ? `通过（${check.counts.warn} 项需确认）` : "通过", "ok")
      : chip(`${check.counts?.fail ?? 0} 项必须修正`, "danger");

  nodes.push(
    card({
      icon: check.ok === true ? "✅" : "⛔",
      title: "检查结果",
      desc: check.checkedLabel === undefined ? undefined : `检查于 ${check.checkedLabel}`,
      tags: [verdictChip, chip(`${check.counts?.ok ?? 0} 项通过`, "mono")],
      body: [
        metrics([
          ["条目文件", check.fileName ?? "—", true],
          ["分类", check.category ?? "—"],
          ["仓库", check.identity?.owner === undefined ? "—" : `${check.identity.owner}/${check.identity.repo}`],
          ["源码", check.code === undefined ? "—" : `${check.code.count} 个文件`],
        ]),
        check.git?.remote === undefined ? undefined : hint(`git remote：${check.git.remote}${check.git.lastCommit === undefined ? "" : ` · 最近提交 ${check.git.lastCommit.slice(0, 10)}`}`),
      ],
    }),
  );

  const fails = check.findings.filter((item) => item.level === "fail");
  const warns = check.findings.filter((item) => item.level === "warn");
  const oks = check.findings.filter((item) => item.level === "ok");

  if (fails.length > 0) {
    nodes.push(
      card({
        danger: true,
        title: "必须修正",
        desc: "这些项会让 PR 被拒或让条目名不副实。修好后重新检查。",
        tags: [chip(`${fails.length} 项`, "danger")],
        body: list(fails.map(findingRow)),
        // The whole point of this card is that its contents get handed to
        // someone else (a person or an AI) to fix, so both copies carry every
        // field needed to act: rule, what is wrong, and how to fix it.
        actions: [
          button("复制给 AI 修改", "awesome-copy-fixes", "prompt", { className: "btn--primary" }),
          button("复制问题清单", "awesome-copy-fixes", "list", { className: "btn--ghost" }),
        ],
      }),
    );
  }
  if (warns.length > 0) {
    nodes.push(
      card({
        title: "需要人工确认",
        desc: "检查器无法自动判定，或依赖网络信息。提交前请逐条看过。",
        body: list(warns.map(findingRow)),
      }),
    );
  }

  if (check.manualChecklist?.length > 0) {
    nodes.push(
      card({
        title: "评审会看什么",
        desc: "CI 通过只是前置条件；维护者会实际读仓库。以下几条必须人工完成。",
        body: list(
          check.manualChecklist.map((item) =>
            row({
              name: item.text,
              muted: true,
              sub: item.detail.length === 0 ? undefined : `相关声明：${item.detail.join("、")}`,
            }),
          ),
        ),
      }),
    );
  }

  if (check.yaml !== undefined) {
    nodes.push(
      card({
        title: `条目文件 data/plugins/${check.fileName}`,
        desc: "直接提交这一个文件即可；两个 README 会在合并后自动重新生成。",
        body: el("pre", { class: "code-block", text: check.yaml }),
        actions: [
          button("复制 YAML", "awesome-copy", undefined, { className: "btn--primary" }),
          check.prBody === undefined ? undefined : button("复制 PR 说明", "awesome-copy-pr", undefined, { className: "btn--ghost" }),
          info.list?.available === true && info.lastCheck?.ok === true
            ? button("写入列表克隆", "awesome-write", undefined, { className: "btn--primary" })
            : undefined,
        ],
      }),
    );
  }

  if (oks.length > 0) {
    nodes.push(
      card({
        title: "已通过的检查",
        desc: "记录实际读到的内容，便于复核。",
        body: list(oks.map((item) => row({ name: `${item.rule} · ${item.title}`, sub: item.detail, muted: true }))),
      }),
    );
  }

  if (check.screenshots?.present === true) {
    nodes.push(
      card({
        title: "截图声明",
        desc: "来自插件仓库的 screenshots.json（市场详情页按它展示）。",
        body: list(check.screenshots.images.map((image) => row({ name: image, mono: true }))),
      }),
    );
  }

  nodes.push(
    card({
      title: "提交",
      desc: "分支 → 提交 → 推送 → 开 PR。反馈会以 PR 评论指出要改什么。",
      body: hint(
        `git checkout -b add-${(check.identity?.repo ?? "plugin").replace(/[^A-Za-z0-9._-]/gu, "-")} && ` +
          `git add data/plugins/${check.fileName ?? "<file>"} && git commit -m "Add ${check.entry?.name ?? "plugin"}"`,
      ),
      actions: [
        button("打开 contributing.md", "awesome-open-contributing", undefined, { className: "btn--ghost" }),
        button("在 GitHub 新建条目文件", "awesome-open-new", undefined, { className: "btn--ghost" }),
      ],
    }),
  );

  return nodes;
}

function findingRow(item) {
  return row({
    name: `${item.rule} · ${item.title}`,
    sub: item.fix === undefined ? item.detail : `${item.detail}\n修法：${item.fix}`,
    side: [chip(item.level === "fail" ? "必须修正" : "待确认", item.level === "fail" ? "danger" : "warn")],
  });
}

/** The entry fields a human supplies; everything else is derived from the repo. */
function renderAwesomeFields(info, check) {
  const entry = check?.entry;
  const categories = info.categories ?? [];
  // The manifest's own description, offered as a starting point when the field
  // is still empty. It is a draft, never applied silently.
  const draft = check?.manifest?.description;
  return card({
    title: "条目字段",
    desc: "只有 description.en 是必填的；分类留空会按仓库内容推断，中文描述留空由维护者补。",
    tags: draft === undefined ? undefined : [chip("package.json 里有现成描述", "mono")],
    body: [
      el("div", { class: "field-grid" }, [
        el("label", { class: "field" }, [
          el("span", { class: "field__label", text: "仓库地址（可选：仓库没有远端时用 owner/repo）" }),
          el("input", { class: "input", type: "text", id: "awesome-ref-input", placeholder: "owner/repo 或 GitHub 链接", spellcheck: "false" }),
        ]),
        el("label", { class: "field" }, [
          el("span", { class: "field__label", text: "monorepo 分支（可选，默认 main 或当前分支）" }),
          el("input", { class: "input", type: "text", id: "awesome-ref-branch-input", placeholder: "main", spellcheck: "false" }),
        ]),
        el("label", { class: "field" }, [
          el("span", { class: "field__label", text: "分类" }),
          select("awesome-category-input", entry?.category ?? check?.category ?? "", [
            { value: "", label: "（按仓库内容推断）" },
            ...categories.map((category) => ({ value: category, label: category })),
          ]),
        ]),
        el("label", { class: "field" }, [
          el("span", { class: "field__label", text: "英文描述（必填，单行，以句号结尾）" }),
          el("input", {
            class: "input",
            type: "text",
            id: "awesome-en-input",
            placeholder: "One-line description ending with a period.",
            spellcheck: "false",
            value: entry?.description?.en ?? "",
          }),
        ]),
        el("label", { class: "field" }, [
          el("span", { class: "field__label", text: "中文描述（可选）" }),
          el("input", {
            class: "input",
            type: "text",
            id: "awesome-zh-input",
            placeholder: "一句话描述，以句号结尾。",
            spellcheck: "false",
            value: entry?.description?.zh ?? "",
          }),
        ]),
        el("label", { class: "field" }, [
          el("span", { class: "field__label", text: "图标 URL（可选，GitHub 托管的 png/jpg/webp）" }),
          el("input", {
            class: "input",
            type: "text",
            id: "awesome-icon-input",
            placeholder: "https://raw.githubusercontent.com/owner/repo/main/assets/icon-180.png",
            spellcheck: "false",
            value: entry?.icon ?? "",
          }),
        ]),
        el("label", { class: "field" }, [
          el("span", { class: "field__label", text: "预构建 tarball（可选，GitHub Release 上的 .tgz）" }),
          el("input", {
            class: "input",
            type: "text",
            id: "awesome-tarball-input",
            placeholder: "https://github.com/owner/repo/releases/latest/download/plugin.tgz",
            spellcheck: "false",
            value: entry?.tarball ?? "",
          }),
        ]),
      ]),
      hint("填完后点上面的「检查并生成条目」。检查会读这些字段，并重新生成 YAML。"),
    ],
    // Only offered when there is something to offer: a one-click fill of the
    // repo's own wording beats retyping it, and it is still the user's call.
    actions:
      draft === undefined
        ? undefined
        : [button("用 package.json 的描述填入", "awesome-use-draft", undefined, { className: "btn--ghost" })],
    actionsEnd: true,
  });
}

/** Read a text/select field out of the panel current render. */
function valueOf(id) {
  const node = document.getElementById(id);
  if (node === null) return undefined;
  const value = typeof node.value === "string" ? node.value.trim() : "";
  return value === "" ? undefined : value;
}

/** Copy through the main process: the renderer runs with contextIsolation on. */
async function copyText(text, message) {
  try {
    const response = await api.copyText(text);
    if (response?.ok === false) toast(response.error ?? "复制失败", "error");
    else toast(message, "ok");
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
}

// --- panel: rollback ------------------------------------------------------

function renderCheckpoints() {
  const running = state.running.isRunning;
  const rows = state.checkpoints.map((entry, index) =>
    row({
      name: `槽位 ${index + 1}`,
      sub: joinSub(
        entry.timeLabel,
        entry.label,
        entry.files.length === 0 ? "无配置文件" : `${entry.files.length} 个配置文件`,
        entry.bytesLabel,
        entry.metaValid === true ? undefined : "元数据缺失",
      ),
      side: [
        chip(entry.trigger === "manual" ? "手动" : "自动", entry.trigger === "manual" ? "ok" : undefined),
        button("恢复此检查点", "restore-checkpoint", entry.id, { className: "btn--primary", disabled: running }),
        button("删除", "delete-checkpoint", entry.id, { disabled: running }),
      ],
    }),
  );

  const totalBytes = state.checkpoints.reduce((sum, entry) => sum + (typeof entry.bytes === "number" ? entry.bytes : 0), 0);
  return [
    panelBar(
      state.checkpoints.length === 0 ? "暂无检查点" : `共 ${state.checkpoints.length} 个检查点 · ${formatBytes(totalBytes)}`,
      [
        button("立即创建检查点", "create-checkpoint", undefined, { className: "btn--primary", disabled: running }),
        button("一键删除全部", "delete-all-checkpoints", undefined, {
          className: "btn--danger",
          disabled: running || state.checkpoints.length === 0,
          title: running
            ? "目标应用正在运行，请先停止或重启应用"
            : state.checkpoints.length === 0
              ? "当前没有检查点"
              : `永久删除全部 ${state.checkpoints.length} 个检查点`,
        }),
        button("在文件夹中显示", "open-path", state.checkpointRoot),
        button("生成诊断包", "export-diagnostics", undefined, { className: "btn--ghost" }),
      ],
    ),
    hint("检查点只保存 Profile 的配置文件（package.json、cordis.patch.yml、cordis.yml、锁文件），不含 node_modules，因此创建与恢复都很快。恢复前会自动为当前状态再建一个检查点。"),
    card({
      title: "回滚",
      desc: `共 ${state.checkpoints.length} 个检查点，保存在 ${state.checkpointRoot}`,
      tags: running ? [chip("应用运行中", "warn")] : undefined,
      body: rows.length === 0 ? empty("还没有检查点。执行插件改动时恢复器会自动创建，也可以现在手动创建一个。") : list(rows),
    }),
  ];
}

// --- panel: profile switching ---------------------------------------------

function renderProfiles() {
  const running = state.running.isRunning;
  const rows = state.profiles.map((entry) => {
    const current = entry.name === state.selectedProfile;
    return row({
      name: entry.name,
      mono: true,
      sub: joinSub(
        entry.dir,
        entry.exists !== true ? "目录不存在" : `${entry.plugins.length} 个插件 · ${entry.patchEntries.length} 条补丁`,
      ),
      side: current
        ? [chip("当前 Profile", "ok")]
        : [button("选择", "select-profile", entry.name, { disabled: false })],
    });
  });

  return [
    hint("切换 Profile 只改变恢复器查看与修复的对象；目标应用实际启动哪个 Profile 由它自己的命令行与配置决定。"),
    card({
      title: "可用 Profile",
      desc: `Profile 根目录：${state.home.profilesDir}`,
      body: rows.length === 0 ? empty("数据目录下还没有任何 Profile。") : list(rows),
      actions: [
        button("打开 Profile 根目录", "open-path", state.home.profilesDir),
        button("刷新", "refresh", undefined, { className: "btn--ghost" }),
      ],
    }),
    card({
      title: "新建 Profile",
      desc:
        "恢复器不会自行新建 Profile：一个可用的 Profile 需要 pnpm 安装其依赖与组合包。请使用 DSH 自身的 profile 初始化流程（例如 `dsh plugin` / `--from-default-profile`），或先在 DSH 中切换并初始化，之后回到这里修复它。",
      actions: [button("打开 Profile 根目录", "open-path", state.home.profilesDir), button("打开数据目录", "open-path", state.home.path)],
    }),
  ];
}

// --- panel: data ----------------------------------------------------------

function renderData() {
  const running = state.running.isRunning;
  const config = state.config;
  return [
    hint("查看或更改 DSH 数据目录。Profile、插件、设置和会话等数据保存在此目录中；更改目录不会删除原目录中的数据。"),
    card({
      icon: "🗄",
      title: "数据管理",
      desc: `来源：${state.home.sourceLabel}${state.home.envValue === undefined ? "" : `（DSH_HOME=${state.home.envValue}）`}`,
      body: metrics([
        ["当前数据目录", state.home.path, true],
        ["默认数据目录", state.home.defaultPath, true],
        ["目录是否存在", state.home.exists === true ? "是" : "否"],
      ]),
      actions: [
        button("更改数据目录", "choose-home", undefined, { className: "btn--primary" }),
        button("使用默认目录", "reset-home"),
        button("打开数据目录", "open-path", state.home.path),
        button("打开恢复器配置", "open-path", config.file),
      ],
    }),
    card({
      icon: "⚠",
      title: "恢复出厂设置",
      desc: "把当前 DSH 数据目录整体移入回收站，然后重新启动应用即可创建新的默认 Profile。此目录以外的项目文件会保留；需要时可以从回收站恢复。",
      danger: true,
      tags: running ? [chip("应用运行中，不可执行", "warn")] : undefined,
      actions: [
        button("重置数据并重启", "reset-data", undefined, {
          className: "btn--danger",
          disabled: running || state.home.exists !== true,
          title: state.home.exists === true ? undefined : "数据目录不存在",
        }),
        button("打开数据目录", "open-path", state.home.path),
      ],
      actionsEnd: true,
    }),
  ];
}

// --- panel: restart button patch ------------------------------------------

const PATCH_ACTION_LABEL = { apply: "安装", revert: "还原", verify: "校验" };
const PATCH_LAYOUT_LABEL = { root: "工具根目录", scoped: "按目标归档", explicit: "显式指定" };
const chipKind = (tone) => (tone === "ok" || tone === "warn" || tone === "danger" ? tone : undefined);

function renderRestartButton() {
  const patch = state.restartButton;
  const running = state.running.isRunning;
  const nodes = [
    hint(
      "重启按钮补丁直接改写目标应用 app.asar 里的两个文件（lib/main.js 与 lib/preload-app.cjs）：在「应用」「编辑」右侧加一个「重启」按钮，内含刷新页面 / 重启应用与Host / 重启到恢复模式，并把这两项从「应用」菜单移除。" +
        "两个条目改写后与原始字节数完全相同，因此应用正在运行时安装或还原也是安全的；改动在重启 DeepSeek Harness 之后生效。",
    ),
  ];

  if (patch === undefined || patch.available !== true) {
    nodes.push(
      card({
        title: "补丁工具不可用",
        danger: true,
        desc: patch?.reason ?? "状态中没有补丁信息。",
        body: patch?.archive === undefined ? undefined : metrics([["app.asar", patch.archive, true]]),
        actions: patch?.toolDir === undefined ? undefined : [button("打开工具目录", "open-path", patch.toolDir)],
      }),
    );
    nodes.push(
      hint("补丁工具位于恢复器目录的 restart-button 子目录，命令行入口为 install.cmd / status.cmd / verify.cmd / revert.cmd，可在 DSH 无法启动时使用。"),
    );
    return nodes;
  }

  const unknown = patch.entries.some((entry) => entry.verdict === "unknown");
  const hasBackup = patch.entries.some((entry) => entry.hasBackup === true);

  nodes.push(
    card({
      icon: "🔁",
      title: "重启按钮补丁",
      desc: patch.installed
        ? `已安装：${patch.installedCount}/${patch.entryTotal} 个条目是补丁内容，重启 DeepSeek Harness 后界面上出现「重启」按钮。`
        : unknown
          ? "两个条目的内容与补丁载荷、原始备份都不一致：可能被其它工具或官方更新改写。可以先校验，再决定是否安装或还原。"
          : "未安装：当前是两个条目的原始内容，「应用」菜单仍是刷新页面 / 重启应用与Host。",
      tags: [
        chip(patch.installed ? "已安装" : unknown ? "内容未知" : "未安装", patch.installed ? "ok" : unknown ? "warn" : undefined),
        patch.installedAt === undefined ? undefined : chip(`安装于 ${new Date(patch.installedAt).toLocaleString("zh-CN")}`),
        running ? chip("应用运行中（可安全改写）", "warn") : undefined,
      ],
      body: [
        metrics([
          ["补丁条目", `${patch.installedCount} / ${patch.entryTotal}`],
          ["目标 app.asar", patch.archive, true],
          ["工具状态布局", PATCH_LAYOUT_LABEL[patch.layout] ?? patch.layout],
        ]),
        list(
          patch.entries.map((entry) =>
            row({
              name: entry.entryPath,
              mono: true,
              sub: joinSub(
                `${formatBytes(entry.size)} · 载荷 ${formatBytes(entry.payloadSize)}`,
                `文件哈希 ${entry.hashLabel}`,
                `头部哈希 ${entry.headerHashLabel}`,
                entry.integrityOk ? "头部 integrity 一致" : `头部 integrity 不一致（${entry.integrityDetail}）`,
                entry.lengthMismatch ? "载荷长度与条目长度不一致" : undefined,
                entry.hasBackup ? "有原始备份" : "无原始备份",
              ),
              side: [chip(entry.verdictLabel, chipKind(entry.verdictTone))],
            }),
          ),
        ),
      ],
      actions: [
        button("安装补丁", "restart-button-apply", undefined, {
          className: "btn--primary",
          disabled: patch.installed === true,
          title: patch.installed === true ? "已经安装了" : undefined,
        }),
        button("校验内容", "restart-button-verify"),
        button("还原补丁", "restart-button-revert", undefined, {
          className: "btn--danger",
          disabled: patch.installed !== true && hasBackup !== true,
          title: patch.installed !== true && hasBackup !== true ? "没有可还原的内容（缺少原始备份）" : undefined,
        }),
      ],
    }),
  );

  const payloads = patch.payloads.filter((payload) => payload.exists === true);
  nodes.push(
    card({
      title: "补丁工具",
      desc: "界面与命令行使用同一份实现（restart-button\\lib\\patch.cjs）。命令行入口适合在 DSH 无法启动时使用。",
      body: metrics([
        ["工具目录", patch.toolDir, true],
        ["工具版本", patch.toolVersion],
        ["状态文件", patch.stateFile, true],
        ["备份目录", patch.backupDir, true],
        ["载荷文件", payloads.map((payload) => `${payload.entryPath} ${formatBytes(payload.size)}`).join(" · ") || "缺失"],
      ]),
      actions: [
        button("打开工具目录", "open-path", patch.toolDir),
        patch.stateExists === true ? button("打开状态文件", "open-path", patch.stateFile) : undefined,
        patch.backupExists === true ? button("打开备份目录", "open-path", patch.backupDir) : undefined,
      ],
    }),
  );

  const last = patch.lastRun;
  if (last !== undefined) {
    nodes.push(
      card({
        title: `上一次运行：${PATCH_ACTION_LABEL[last.action] ?? last.action ?? "补丁操作"}${last.ok === true ? "成功" : "失败"}`,
        desc: `${last.timeLabel ?? ""} ${last.message ?? ""}`.trim(),
        body: Array.isArray(last.lines) && last.lines.length > 0 ? el("pre", { class: "log", text: last.lines.join("\n") }) : empty("没有输出。"),
      }),
    );
  }

  return nodes;
}

// --- panel: diagnostics ---------------------------------------------------

function renderDiagnostics() {
  const latest = state.diagnostics.latest;
  const detail = state.selectedProfileDetail;
  const settings = `${state.home.path}\\settings.yaml`;
  return [
    hint("诊断包保存在本地，不会自动上传。"),
    card({
      icon: "🧭",
      title: "安装位置",
      desc:
        state.targets.filter((target) => target.manual === true).length === 0
          ? "自动扫描只覆盖常见安装目录。如果 DeepSeek Harness 装在别处（例如其他盘符或自定义目录），可以在这里直接选择安装目录或应用主程序，恢复器会把该位置记住。"
          : "下列位置已加入恢复器的目标清单。手动指定的安装可以随时移除；自动发现的会在卸载后自行消失。",
      body: metrics([
        ["当前目标应用", state.selected?.exe ?? "未找到", true],
        ["已发现的安装", String(state.targets.length)],
        ["手动指定的安装", String(state.targets.filter((target) => target.manual === true).length)],
      ]),
      actions: [
        state.targets.length < 2
          ? undefined
          : select("target", state.selectedTargetId, state.targets.map((target) => ({ value: target.id, label: `${target.label}（${target.appVersion ?? "?"}）` }))),
        button("选择安装目录…", "choose-target", undefined, {
          className: state.selected?.exe === undefined ? "btn--primary" : undefined,
        }),
        button("选择应用主程序…", "choose-target-exe"),
        state.selected?.manual === true
          ? button("移除此手动指定的安装", "forget-target", state.selectedTargetId, { className: "btn--ghost" })
          : undefined,
      ],
    }),
    card({
      title: "诊断包",
      desc:
        state.diagnostics.count === 0
          ? "还没有生成过诊断包。诊断包内含恢复器环境、Profile 清单、插件列表、补丁条目、检查点索引、进程列表与日志片段。"
          : `最近生成：${latest?.name ?? "—"}（${formatBytes(latest?.bytes)}）· 保存在 ${state.diagnostics.dir}`,
      tags: state.diagnostics.count === 0 ? undefined : [chip(`${state.diagnostics.count} 个`, "ok")],
      body: state.diagnostics.count === 0 ? undefined : metrics([
        ["诊断包", latest?.name, true],
        ["大小", formatBytes(latest?.bytes)],
        ["生成时间", latest?.modifiedAt === undefined ? undefined : new Date(latest.modifiedAt).toLocaleString("zh-CN")],
      ]),
      actions: [
        button("生成诊断包", "export-diagnostics", undefined, { className: "btn--primary" }),
        button("在文件夹中显示", "open-path", state.diagnostics.dir),
        latest === undefined ? undefined : button("定位诊断包", "show-item", latest.file),
      ],
    }),
    card({
      title: "配置文件",
      desc: "查看或编辑当前 Profile 的配置与 DSH 数据目录中的共享配置。更改后需重启应用才能生效。",
      actions: [
        button("打开 settings.yaml", "open-path", settings),
        detail === undefined ? undefined : button("打开 Profile 清单", "open-path", detail.manifestPath),
        detail === undefined ? undefined : button("打开插件补丁", "open-path", detail.patchPath),
        button("打开 Profile 目录", "open-profile-dir"),
        button("打开数据目录", "open-path", state.home.path),
      ],
    }),
    card({
      title: "运行环境",
      body: metrics([
        ["恢复器版本", `v${state.console.version}`],
        ["Electron / Node", `${state.console.electron} / ${state.console.node}`],
        ["系统", state.console.platform],
        ["恢复器目录", state.console.root, true],
        ["应用版本", state.selected?.appVersion ?? "—"],
        ["应用 Electron", state.selected?.electronVersion ?? "—"],
        ["数据目录来源", state.home.sourceLabel],
        ["恢复器配置", state.config.file, true],
      ]),
    }),
  ];
}

// --- footer ---------------------------------------------------------------

function renderFooter() {
  const host = document.getElementById("status");
  const actions = document.getElementById("footer-actions");
  if (host === null || actions === null) return;

  const running = state.running.isRunning;
  const last = state.lastAction;
  clear(host).append(
    busy
      ? el("span", { class: "spinner" })
      : el("span", { class: `dot ${running ? "dot--on" : ""}`.trim() }),
    el("span", {
      text: busy
        ? busyLabel
        : last === undefined
          ? running
            ? `应用运行中（PID ${runningPidText(state.running)}）`
            : "就绪"
          : `${last.timeLabel ?? ""} ${last.message ?? ""}`.trim(),
    }),
  );

  clear(actions).append(
    button("刷新状态", "refresh", undefined, { className: "btn--ghost" }),
    running ? button("停止", "stop") : undefined,
    running ? button("重启", "restart", "normal", { className: "btn--primary" }) : button("启动", "launch", "normal", { className: "btn--primary" }),
    button("退出", "quit"),
  );
}

// --- toasts ---------------------------------------------------------------

function toast(message, kind) {
  const host = document.getElementById("toasts");
  if (host === null) return;
  const node = el("div", { class: `toast${kind === undefined ? "" : ` toast--${kind}`}`, text: message });
  host.append(node);
  while (host.childElementCount > 4) host.removeChild(host.firstChild);
  setTimeout(() => node.remove(), kind === "error" ? 9000 : 5000);
}

function setBusy(value, label) {
  busy = value;
  busyLabel = label ?? "正在执行…";
  document.body.dataset.busy = value === true ? "1" : "0";
  render();
}

// --- helpers --------------------------------------------------------------

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${index === 0 ? value : value.toFixed(1)} ${units[index]}`;
}

function readStoredTab() {
  try {
    const stored = window.localStorage.getItem("dsh-recovery.tab");
    if (stored !== null && TABS.some((tab) => tab.id === stored)) return stored;
  } catch {
    /* localStorage unavailable */
  }
  return "quick";
}

function storeTab(id) {
  try {
    window.localStorage.setItem("dsh-recovery.tab", id);
  } catch {
    /* ignore */
  }
}

// --- wiring ---------------------------------------------------------------

document.addEventListener("click", (event) => {
  const origin = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  if (origin === null) return;
  const handler = ACTIONS[origin.dataset.action];
  if (handler === undefined) return;
  event.preventDefault();
  if (busy && origin.dataset.action !== "quit") return;
  void handler(origin.dataset.arg, origin);
});

document.addEventListener("change", (event) => {
  const origin = event.target instanceof Element ? event.target.closest("[data-select]") : null;
  if (origin === null || busy) return;
  const handler = SELECTS[origin.dataset.select];
  if (handler !== undefined) void handler(origin.value, origin);
});

document.getElementById("refresh-button")?.addEventListener("click", () => {
  void ACTIONS.refresh();
});

api.onStatus((next) => {
  state = next;
  render();
});

(async () => {
  try {
    state = await api.status();
    render();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
})();
