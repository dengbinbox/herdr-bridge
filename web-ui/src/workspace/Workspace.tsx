import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { Panel, Group, Separator } from "react-resizable-panels";
import { api } from "../api";
import { TerminalPane } from "../Terminal";
import { useWorkspace } from "./useWorkspace";
import {
  focusTree,
  qualify,
  emptyView,
  readView,
  recover,
  panes,
  shown,
  spaceName,
  cwdOf,
  machineOf,
  terminalTab,
  obj,
  str,
  type View,
  type Space,
  type Node,
  type Pane,
} from "./model";
import {
  agents,
  agentGroups,
  updateAttention,
  counter,
  stateLabel,
  type AgentRow,
  type Attention,
} from "./agent-state";
import { InspectorPanel } from "./InspectorPanel";
import { repositoryInfo } from "./git-service";
import styles from "./workspace.module.css";
import app from "../app.module.css";
export function Workspace({
  refreshAuth,
}: {
  refreshAuth: () => Promise<void>;
}) {
  const { id = "" } = useParams();
  const [view, setView] = useState<View>(emptyView),
    [loaded, setLoaded] = useState(false),
    [version, setVersion] = useState(0),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [kill, setKill] = useState<string | null>(null),
    [peek, setPeek] = useState(""),
    [held, setHeld] = useState(""),
    [front, setFront] = useState(
      document.visibilityState === "visible" && document.hasFocus(),
    ),
    [pending, setPending] = useState<string[]>([]),
    [narrow, setNarrow] = useState(window.innerWidth < 1000),
    [repos, setRepos] = useState<
      Record<string, Awaited<ReturnType<typeof repositoryInfo>>>
    >({});
  const attention = useRef(new Map<string, Attention>()),
    look = useRef(new Set<string>()),
    written = useRef(new Map<string, string>()),
    [attentionVersion, bumpAttention] = useState(0);
  const { core, records, native, state, warning, epochs, refresh } =
    useWorkspace(id, refreshAuth, (records) => {
      attention.current = updateAttention(
        attention.current,
        records,
        look.current,
      );
    });
  const update = (patch: Partial<View>) => setView((v) => ({ ...v, ...patch }));
  useEffect(() => {
    let live = true;
    void api<{ version: number; document: unknown }>(`/layouts/${id}`)
      .then((r) => {
        if (!live) return;
        const v = readView(r.document);
        if (!v) throw new Error("保存的布局格式无法识别；未覆盖原数据");
        setView(v);
        setVersion(r.version);
        setLoaded(true);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    const focus = () =>
      setFront(document.visibilityState === "visible" && document.hasFocus());
    const resize = () => setNarrow(window.innerWidth < 1000);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", focus);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", focus);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("resize", resize);
    };
  }, []);
  const spaces = useMemo(() => {
    const all = [...native, ...view.spaces];
    return [...all, ...recover(records, all)].sort((a, b) =>
      a.machine.localeCompare(b.machine),
    );
  }, [native, view.spaces, records]);
  const space = spaces.find((s) => s.id === view.active) || spaces[0];
  const tab =
    space?.tabs.find((t) => t.id === view.tabs[space.id]) ||
    (space?.source === "recovered" && !view.active
      ? undefined
      : space?.tabs[0]);
  const focus = tab && (view.focus[tab.id] || shown(tab.root)[0]?.id);
  const displayRoot = tab ? focusTree(tab.root, focus) : undefined;
  const actualPanes = displayRoot
    ? shown(displayRoot).filter((p) => !view.detached.includes(p.id))
    : [];
  const pane = actualPanes.find((p) => p.id === focus) || actualPanes[0];
  const address = peek || pane?.terminal || "";
  const record = records.find((t) => t.address === address);
  const cwd = cwdOf(record, space);
  const machine = address ? machineOf(address) : space?.machine || "";
  const visibleKey = (
    peek
      ? [peek]
      : actualPanes
          .filter((p) => records.some((r) => r.address === p.terminal))
          .map((p) => p.terminal)
  ).join("\0");
  const rows = useMemo(
    () => agents(records, spaces, attention.current, held),
    [records, spaces, held, attentionVersion],
  );
  useEffect(() => {
    const visible = new Set(
      front && core && loaded ? visibleKey.split("\0").filter(Boolean) : [],
    );
    look.current = visible;
    for (const key of written.current.keys())
      if (!visible.has(key)) written.current.delete(key);
    let changed = false;
    for (const a of visible) {
      const t = records.find((t) => t.address === a),
        local = attention.current.get(a);
      if (local && !local.seen) {
        local.seen = true;
        changed = true;
      }
      if (
        !t ||
        !str(obj(t.status).state) ||
        !core?.methods.includes("terminal.label")
      )
        continue;
      const turn = counter(t.turn);
      if (turn === null) continue;
      const key = turn.toString();
      if (written.current.get(a) === key) continue;
      written.current.set(a, key);
      const seen = counter(obj(t.labels)["herdr.seen"]);
      if (seen !== null && seen >= turn) continue;
      void core
        .call("terminal.label", { terminal: a, labels: { "herdr.seen": key } })
        .catch((e) => setError(String(e)));
    }
    if (changed) bumpAttention((n) => n + 1);
  }, [front, visibleKey, records, core, loaded]);
  useEffect(() => {
    if (held && held !== address) setHeld("");
  }, [address, held]);
  // Metadata refreshes are bounded and only run in the foreground. Each response belongs to this connection.
  const repoContexts = spaces.map((s) => ({
    id: s.id,
    machine: s.machine,
    cwd: cwdOf(
      records.find(
        (r) => r.address === s.tabs.flatMap((t) => panes(t.root))[0]?.terminal,
      ),
      s,
    ),
  }));
  const repoKey = JSON.stringify(repoContexts);
  const activityKey = records
    .map(
      (t) =>
        `${t.address}:${str(obj(t.status).state)}:${str(obj(t.foreground).name)}`,
    )
    .join("|");
  useEffect(() => {
    if (!core || !front || !core.methods.includes("machine.exec")) return;
    let live = true,
      busy = false;
    async function run() {
      if (busy) return;
      busy = true;
      for (const ctx of repoContexts) {
        if (!live) break;
        if (!ctx.cwd) continue;
        try {
          const r = await repositoryInfo(core!, ctx);
          if (live) setRepos((old) => ({ ...old, [ctx.id]: r }));
        } catch {
          /* Inspector reports detailed read failures; missing Git metadata does not hide spaces. */
        }
      }
      busy = false;
    }
    void run();
    const timer = setInterval(() => void run(), 30000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [core, front, repoKey, activityKey]);
  function select(s: Space, tid?: string, pid?: string) {
    setPeek("");
    setView((v) => ({
      ...v,
      active: s.id,
      tabs: tid ? { ...v.tabs, [s.id]: tid } : v.tabs,
      focus: tid && pid ? { ...v.focus, [tid]: pid } : v.focus,
      detached: pid ? v.detached.filter((x) => x !== pid) : v.detached,
    }));
  }
  function openAgent(row: AgentRow, child = false) {
    if (row.effective === "done") setHeld(row.record.address);
    if (child) {
      setPeek(row.record.address);
      return;
    }
    select(row.space, row.tab, row.pane);
  }
  async function pin(row: AgentRow) {
    if (!core) return;
    const a = row.record.address;
    setPending((p) => [...p, a]);
    try {
      await core.call("terminal.label", {
        terminal: a,
        labels: { "herdr.pinned": row.pinned ? "" : "1" },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setPending((p) => p.filter((x) => x !== a));
    }
  }
  function toggle(key: string) {
    setView((v) => ({
      ...v,
      collapsed: v.collapsed.includes(key)
        ? v.collapsed.filter((x) => x !== key)
        : [...v.collapsed, key],
    }));
  }
  async function run() {
    if (!core) return;
    try {
      const result = await core.call<{ address: string }>("terminal.run", {
        cwd: cwd || undefined,
        on: machine || undefined,
        env: {
          TERM: "xterm-256color",
          TERM_PROGRAM: "herdr-bridge",
          COLORTERM: "truecolor",
        },
        no_parent: true,
      });
      const address = qualify(result.address, machine);
      if (space?.source === "web") addToWeb(address);
      else
        setView((v) => ({
          ...v,
          active: `recovered:${machine}`,
          tabs: { ...v.tabs, [`recovered:${machine}`]: `tab:${address}` },
        }));
    } catch (e) {
      setError(String(e));
    }
  }
  async function save() {
    setSaving(true);
    try {
      const r = await api<{ version: number }>(`/layouts/${id}`, "PUT", {
        version,
        document: view,
      });
      setVersion(r.version);
      setError("");
    } catch (e) {
      setError(String(e) + "；布局未覆盖。重新进入页面以读取已保存的布局。");
    } finally {
      setSaving(false);
    }
  }
  function detach(p: Pane) {
    if (peek) {
      setPeek("");
      return;
    }
    setView((v) => ({ ...v, detached: [...new Set([...v.detached, p.id])] }));
  }
  function openTerminal(s: Space, tid: string, p: Pane, observe: boolean) {
    select(s, tid, p.id);
    setView((v) => ({
      ...v,
      observe: { ...v.observe, [p.terminal]: observe },
    }));
  }
  function splitWeb() {
    if (!space || space.source !== "web" || space.tabs.length < 2) return;
    const tabs = space.tabs;
    const merged = {
      id: `split:${crypto.randomUUID()}`,
      name: "分屏",
      root: {
        id: `split:${crypto.randomUUID()}`,
        type: "row" as const,
        children: tabs.map((t) => t.root),
      },
    };
    setView((v) => ({
      ...v,
      spaces: v.spaces.map((s) =>
        s.id === space.id ? { ...s, tabs: [merged] } : s,
      ),
      tabs: { ...v.tabs, [space.id]: merged.id },
    }));
  }
  function addSpace() {
    const name = window.prompt("网页空间名称");
    if (!name?.trim()) return;
    const folder = window.prompt("工作目录", cwd);
    if (folder === null) return;
    const s: Space = {
      id: "web:" + crypto.randomUUID(),
      name: name.trim(),
      folder,
      machine,
      source: "web",
      tabs: [],
    };
    setView((v) => ({ ...v, spaces: [...v.spaces, s], active: s.id }));
  }
  function addToWeb(address: string) {
    if (!space || space.source !== "web") return;
    const existing = space.tabs.find((t) =>
      panes(t.root).some((p) => p.terminal === address),
    );
    const created = terminalTab(address, false, space.id);
    setView((v) => ({
      ...v,
      active: space.id,
      spaces: v.spaces.map((s) =>
        s.id === space.id
          ? { ...s, tabs: existing ? s.tabs : [...s.tabs, created] }
          : s,
      ),
      tabs: { ...v.tabs, [space.id]: existing?.id || created.id },
    }));
  }
  function unsplitWeb() {
    if (!space || space.source !== "web" || !tab) return;
    const tabs = panes(tab.root).map((p) => ({
      id: `tab:${p.id}`,
      name: "",
      root: { id: p.id, type: "block" as const, pane: p },
    }));
    setView((v) => ({
      ...v,
      spaces: v.spaces.map((s) =>
        s.id === space.id
          ? {
              ...s,
              tabs: s.tabs.flatMap((t) => (t.id === tab.id ? tabs : [t])),
            }
          : s,
      ),
      tabs: { ...v.tabs, [space.id]: tabs[0]?.id || "" },
    }));
  }
  const onLayout = (layout: { [id: string]: number }) =>
    setView((v) => {
      const changed = Object.entries(layout).some(
        ([k, n]) => Math.abs((v.sizes[k] ?? 0) - n) > 0.1,
      );
      return changed ? { ...v, sizes: { ...v.sizes, ...layout } } : v;
    });
  function renderNode(node: Node): React.ReactNode {
    if (node.pane) {
      const p = node.pane;
      if (view.detached.includes(p.id))
        return (
          <div className={styles.empty}>
            <button
              onClick={() =>
                setView((v) => ({
                  ...v,
                  detached: v.detached.filter((x) => x !== p.id),
                }))
              }
            >
              重新附着 {p.terminal}
            </button>
          </div>
        );
      const r = records.find((t) => t.address === p.terminal);
      return (
        <div
          className={styles.terminalSlot}
          data-focused={p.id === focus}
          onFocusCapture={() =>
            tab &&
            setView((v) => ({ ...v, focus: { ...v.focus, [tab.id]: p.id } }))
          }
          onPointerDown={() =>
            tab &&
            setView((v) => ({ ...v, focus: { ...v.focus, [tab.id]: p.id } }))
          }
        >
          {core && r && loaded ? (
            <TerminalPane
              key={`${p.terminal}/${epochs[p.terminal] || 0}`}
              core={core}
              id={p.terminal}
              observe={view.observe[p.terminal] ?? p.observe}
              grid={r}
              onDetach={() => detach(p)}
              onKill={() => setKill(p.terminal)}
            />
          ) : (
            <p className={styles.empty}>
              {p.terminal} · {core ? "终端已结束或机器不可用" : "等待连接恢复"}
            </p>
          )}
        </div>
      );
    }
    const children =
      node.type === "stack"
        ? [
            node.children?.find((n) => n.id === node.active) ||
              node.children?.[0],
          ].filter((n): n is Node => !!n)
        : node.children || [];
    if (!children.length)
      return <p className={styles.empty}>此标签没有可显示的终端</p>;
    return (
      <Group
        orientation={node.type === "column" ? "vertical" : "horizontal"}
        onLayoutChanged={onLayout}
      >
        {children.map((n, i) => (
          <React.Fragment key={n.id}>
            {i > 0 && <Separator className={styles.separator} />}
            <Panel
              id={n.id}
              minSize="5%"
              defaultSize={`${view.sizes[n.id] || 100 / children.length}%`}
            >
              {renderNode(n)}
            </Panel>
          </React.Fragment>
        ))}
      </Group>
    );
  }
  function agentRow(r: AgentRow, depth = 0): React.ReactNode {
    const expanded = !view.collapsed.includes("agent:" + r.record.address);
    return (
      <div key={r.record.address}>
        <div
          className={styles.agentRow}
          style={{ paddingLeft: 8 + depth * 12 }}
          data-selected={address === r.record.address}
        >
          <button
            className={styles.agentLink}
            onClick={() => openAgent(r, depth > 0)}
          >
            <span
              className={styles.stateIcon}
              data-state={r.effective}
              aria-label={stateLabel[r.effective]}
            >
              {r.effective === "blocked"
                ? "!"
                : r.effective === "working"
                  ? "◉"
                  : r.effective === "done"
                    ? "●"
                    : "○"}
            </span>
            <span>
              <strong>{r.title}</strong>
              <small>{r.detail}</small>
            </span>
          </button>
          {r.children.length > 0 && (
            <button
              aria-label="展开子 Agent"
              aria-expanded={expanded}
              onClick={() => toggle("agent:" + r.record.address)}
            >
              {expanded ? "▾" : "▸"}
            </button>
          )}
          {depth === 0 && (
            <button
              disabled={
                !core ||
                pending.includes(r.record.address) ||
                !core.methods.includes("terminal.label")
              }
              aria-label={r.pinned ? "Unpin" : "Pin"}
              title={r.pinned ? "取消置顶" : "置顶"}
              onClick={() => void pin(r)}
            >
              {r.pinned ? "◆" : "◇"}
            </button>
          )}
        </div>
        {expanded && r.children.map((c) => agentRow(c, depth + 1))}
      </div>
    );
  }
  const showLeft = view.left && (!narrow || !view.right),
    showRight = view.right && (!narrow || !view.left);
  return (
    <section className={styles.workspace} aria-label="终端工作台">
      <header className={styles.toolbar}>
        <button
          aria-label="切换左栏"
          aria-expanded={showLeft}
          onClick={() =>
            update({ left: !showLeft, ...(narrow ? { right: false } : {}) })
          }
        >
          ☰
        </button>
        <strong>{core?.machineName || "终端工作台"}</strong>
        <span role="status" className={styles.connection}>
          {state}
        </span>
        <div className={styles.toolbarActions}>
          <button disabled={!core} onClick={() => void run()}>
            新建 Shell
          </button>
          <button onClick={refresh}>刷新终端</button>
          <button disabled={saving || !loaded} onClick={() => void save()}>
            {saving ? "保存中…" : "保存布局"}
          </button>
          <button
            aria-expanded={showRight}
            onClick={() =>
              update({ right: !showRight, ...(narrow ? { left: false } : {}) })
            }
          >
            Files / Changes
          </button>
        </div>
      </header>
      {(error || warning) && (
        <div role="alert" className={styles.notice}>
          {error || warning}
          <button aria-label="关闭提示" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      <div className={styles.body}>
        <Group orientation="horizontal" onLayoutChanged={onLayout}>
          {showLeft && (
            <>
              <Panel
                id="sidebar"
                defaultSize={
                  view.sizes.sidebar ? `${view.sizes.sidebar}%` : "268px"
                }
                minSize={narrow ? "35%" : "180px"}
                maxSize={narrow ? "80%" : "420px"}
              >
                <aside className={styles.sidebar}>
                  <Group orientation="vertical" onLayoutChanged={onLayout}>
                    <Panel
                      id="spaces"
                      defaultSize={`${view.sizes.spaces || 46}%`}
                      minSize="20%"
                    >
                      <div className={styles.listPanel}>
                        <header className={styles.sectionHead}>
                          <h2>Spaces</h2>
                          <button aria-label="新增网页空间" onClick={addSpace}>
                            ＋
                          </button>
                        </header>
                        <div className={styles.scroll}>
                          {spaces.map((s, i) => {
                            const prev = spaces[i - 1],
                              repo = repos[s.id],
                              shared =
                                repo &&
                                spaces
                                  .slice(0, i)
                                  .some(
                                    (x) =>
                                      x.machine === s.machine &&
                                      repos[x.id]?.common === repo.common,
                                  );
                            return (
                              <React.Fragment key={s.id}>
                                {(!prev || prev.machine !== s.machine) && (
                                  <div className={styles.groupTitle}>
                                    {s.machine || core?.machineName || "本机"}
                                  </div>
                                )}
                                <button
                                  className={styles.spaceRow}
                                  aria-label={`空间 ${spaceName(s, records)}`}
                                  data-selected={space?.id === s.id}
                                  style={{ paddingLeft: shared ? 26 : 12 }}
                                  onClick={() =>
                                    select(s, view.tabs[s.id] || s.tabs[0]?.id)
                                  }
                                  title={s.folder}
                                >
                                  <span>▱</span>
                                  <span>
                                    <strong>{spaceName(s, records)}</strong>
                                    <small>
                                      {s.unavailable ||
                                        repo?.branch ||
                                        s.folder ||
                                        (s.source === "core"
                                          ? "原生空间"
                                          : s.source === "web"
                                            ? "网页私有空间"
                                            : "恢复终端")}
                                    </small>
                                  </span>
                                  <small>{s.tabs.length}</small>
                                </button>
                              </React.Fragment>
                            );
                          })}
                          {!spaces.length && (
                            <p className={styles.empty}>
                              暂无空间。新建 Shell 后可在未分组中打开。
                            </p>
                          )}
                          {space?.source === "web" && (
                            <>
                              <button
                                className={styles.inlineAction}
                                onClick={() => {
                                  const name = window.prompt(
                                    "空间名称",
                                    space.name,
                                  );
                                  if (name?.trim())
                                    setView((v) => ({
                                      ...v,
                                      spaces: v.spaces.map((s) =>
                                        s.id === space.id
                                          ? { ...s, name: name.trim() }
                                          : s,
                                      ),
                                    }));
                                }}
                              >
                                重命名空间
                              </button>
                              <button
                                className={styles.inlineAction}
                                disabled={space.tabs.length < 2}
                                onClick={splitWeb}
                              >
                                基础分屏
                              </button>
                              {tab && panes(tab.root).length > 1 && (
                                <button
                                  className={styles.inlineAction}
                                  onClick={unsplitWeb}
                                >
                                  标签视图
                                </button>
                              )}
                              <select
                                aria-label="添加已有终端到空间"
                                value=""
                                onChange={(e) => addToWeb(e.target.value)}
                              >
                                <option value="">添加已有终端…</option>
                                {records
                                  .filter(
                                    (t) =>
                                      machineOf(t.address) === space.machine,
                                  )
                                  .map((t) => (
                                    <option key={t.address} value={t.address}>
                                      {t.title || t.address}
                                    </option>
                                  ))}
                              </select>
                            </>
                          )}
                          {space && (
                            <details
                              open={space.source === "recovered"}
                              className={styles.terminals}
                            >
                              <summary>
                                空间终端 ·{" "}
                                {
                                  space.tabs.flatMap((t) => panes(t.root))
                                    .length
                                }
                              </summary>
                              {space.tabs.flatMap((t) =>
                                panes(t.root).map((p) => (
                                  <div key={p.id}>
                                    <span title={p.terminal}>
                                      {records.find(
                                        (r) => r.address === p.terminal,
                                      )?.title || p.terminal}
                                    </span>
                                    <button
                                      onClick={() =>
                                        openTerminal(space, t.id, p, false)
                                      }
                                    >
                                      附着
                                    </button>
                                    <button
                                      onClick={() =>
                                        openTerminal(space, t.id, p, true)
                                      }
                                    >
                                      只读
                                    </button>
                                  </div>
                                )),
                              )}
                            </details>
                          )}
                        </div>
                      </div>
                    </Panel>
                    <Separator className={styles.separator} />
                    <Panel id="agents" minSize="20%">
                      <div className={styles.listPanel}>
                        <header className={styles.sectionHead}>
                          <h2>Agents</h2>
                          <select
                            aria-label="Agent 分组方式"
                            value={view.grouped ? "space" : "priority"}
                            onChange={(e) =>
                              update({ grouped: e.target.value === "space" })
                            }
                          >
                            <option value="priority">Priority</option>
                            <option value="space">Grouped by space</option>
                          </select>
                        </header>
                        <div className={styles.scroll}>
                          {agentGroups(rows, view.grouped).map(
                            ([group, rs]) => (
                              <section key={group}>
                                <button
                                  className={styles.groupTitle}
                                  aria-expanded={
                                    !view.collapsed.includes(group)
                                  }
                                  onClick={() => toggle(group)}
                                >
                                  {view.collapsed.includes(group) ? "▸" : "▾"}{" "}
                                  {view.grouped && group !== "Pinned"
                                    ? spaceName(rs[0].space, records)
                                    : group}
                                  <span>{rs.length}</span>
                                </button>
                                {!view.collapsed.includes(group) &&
                                  rs.map((r) => agentRow(r))}
                              </section>
                            ),
                          )}
                          {!rows.length && (
                            <p className={styles.empty}>
                              暂无 Agent 状态
                              <br />
                              <small>普通 Shell 显示在 Spaces 中</small>
                            </p>
                          )}
                        </div>
                      </div>
                    </Panel>
                  </Group>
                </aside>
              </Panel>
              <Separator className={styles.separator} />
            </>
          )}
          <Panel id="center" minSize={narrow ? "15%" : "25%"}>
            <div className={styles.center}>
              <header className={styles.tabHeader}>
                <span>{space ? spaceName(space, records) : "Workspace"}</span>
                <nav aria-label="终端标签">
                  {space?.tabs.map((t, i) => (
                    <button
                      key={t.id}
                      aria-pressed={t.id === tab?.id}
                      onClick={() => select(space, t.id)}
                    >
                      {t.name || i + 1}
                    </button>
                  ))}
                </nav>
              </header>
              {peek && (
                <div className={styles.peekHeader}>
                  <span>子 Agent · {peek}</span>
                  <button onClick={() => setPeek("")}>关闭预览</button>
                </div>
              )}
              <div className={styles.canvas}>
                {peek && core ? (
                  <TerminalPane
                    core={core}
                    id={peek}
                    observe
                    grid={record}
                    onDetach={() => setPeek("")}
                    onKill={() => setKill(peek)}
                  />
                ) : displayRoot ? (
                  renderNode(displayRoot)
                ) : (
                  <div className={styles.welcome}>
                    <span>▱</span>
                    <h2>选择一个空间，继续工作</h2>
                    <p>
                      终端与分屏在中间，项目和 Agent 在左侧。
                      <br />
                      Files 与 Changes 跟随当前终端的工作目录。
                    </p>
                    <button disabled={!core} onClick={() => void run()}>
                      新建 Shell
                    </button>
                  </div>
                )}
              </div>
            </div>
          </Panel>
          {showRight && (
            <>
              <Separator className={styles.separator} />
              <Panel
                id="inspector"
                defaultSize={
                  view.sizes.inspector ? `${view.sizes.inspector}%` : "368px"
                }
                minSize={narrow ? "35%" : "240px"}
                maxSize={narrow ? "80%" : "55%"}
              >
                <InspectorPanel
                  key={`${id}/${machine}/${cwd}/${core ? "online" : "offline"}`}
                  core={core}
                  ctx={{ machine, cwd }}
                  tab={view.inspector}
                  onTab={(inspector) => update({ inspector })}
                  onClose={() => update({ right: false })}
                />
              </Panel>
            </>
          )}
        </Group>
      </div>
      <footer className={styles.footer}>
        <span>{address || "尚未附着终端"}</span>
        <span title={cwd}>{cwd || space?.folder || "—"}</span>
        <span>
          {peek || (pane && (view.observe[pane.terminal] ?? pane.observe))
            ? "只读观察"
            : "共享输入 · 多窗口可能共同控制"}
        </span>
      </footer>
      <Dialog.Root
        open={kill !== null}
        onOpenChange={(open) => {
          if (!open) setKill(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={app.overlay} />
          <Dialog.Content className={app.dialog}>
            <Dialog.Title>结束终端 {kill}？</Dialog.Title>
            <Dialog.Description>
              这将结束程序，所有查看窗口都会受到影响。仅关闭当前视图请使用「分离」。
            </Dialog.Description>
            <button
              className={app.danger}
              onClick={async () => {
                if (!core || !kill) return;
                try {
                  await core.call("terminal.kill", { terminal: kill });
                  setKill(null);
                } catch (e) {
                  setError(String(e));
                  setKill(null);
                }
              }}
            >
              结束程序
            </button>
            <Dialog.Close>取消</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
