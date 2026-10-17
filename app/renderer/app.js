"use strict";
// DSH 恢复器 — renderer.
//
// Renders the single state object produced by app/backend/ipc.js and forwards
// every user action to the `window.recovery` bridge from preload.js. The
// renderer owns no state of its own beyond the active tab: after each action
// the backend re-broadcasts `recovery:status-changed`, which re-renders.

const api = window.recovery;

const TABS = [
  { id: "quick", label: "快速恢复" },
  { id: "plugins", label: "插件管理", badge: (value) => value.selectedProfileDetail?.plugins?.length },
  { id: "checkpoints", label: "回滚", badge: (value) => value.checkpoints.length },
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
  const node = el("select", { class: "select", dataset: { select: name }, disabled: busy });
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
  "set-target": (arg) => run("切换目标应用", "setTarget", arg),
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
        desc: "恢复器没有在已知安装位置找到 DeepSeek Harness 或 DSH Desktop。可用 --target=<安装目录> 启动恢复器，或检查恢复器配置文件。",
        actions: [button("打开恢复器配置", "open-path", state.config.file)],
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
        ["目标应用", state.selected?.exe ?? "未找到", true],
        ["应用版本", state.selected?.appVersion ?? "—"],
        ["应用 Electron", state.selected?.electronVersion ?? "—"],
        ["已发现的安装", String(state.targets.length)],
        ["数据目录来源", state.home.sourceLabel],
        ["恢复器配置", state.config.file, true],
      ]),
      actions: state.targets.length < 2 ? undefined : [
        select("target", state.selectedTargetId, state.targets.map((target) => ({ value: target.id, label: `${target.label}（${target.appVersion ?? "?"}）` }))),
      ],
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
