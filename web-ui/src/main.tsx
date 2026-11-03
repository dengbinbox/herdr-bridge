import React, { createContext, useContext, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Panel, Group, Separator } from "react-resizable-panels";
import {
  api,
  setCSRF,
  type User,
  type Bridge,
  type KeyInfo,
  type ManagedUser,
  type ConnectionInfo,
  APIError,
} from "./api";
import { CoreClient, TerminalStore, type TerminalRecord } from "./core";
import { TerminalPane } from "./Terminal";
import { readLayout, type Tab, type Layout } from "./layout";
import styles from "./app.module.css";
const Auth = createContext<{ user: User | null; refresh: () => Promise<void> }>(
  { user: null, refresh: async () => {} },
);
function ErrorText({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className={styles.error}>
      {String(error instanceof Error ? error.message : error)}
    </p>
  ) : null;
}
function Login() {
  const { refresh } = useContext(Auth);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className={styles.login}>
      <h1>Herdr Bridge</h1>
      <p>连接你的机器，继续你的工作。</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const d = new FormData(e.currentTarget);
          try {
            const u = await api<User>("/auth/login", "POST", {
              username: d.get("username"),
              password: d.get("password"),
            });
            setCSRF(u.csrf_token);
            await refresh();
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          用户名
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button disabled={busy}>登录</button>
        <ErrorText error={error} />
      </form>
    </main>
  );
}
function Password() {
  const { refresh } = useContext(Auth);
  const [error, setError] = useState("");
  return (
    <section>
      <h1>修改密码</h1>
      <p>密码至少 12 个字符。修改后请重新登录。</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          try {
            await api("/auth/password", "POST", {
              current_password: d.get("current"),
              new_password: d.get("new"),
            });
            await refresh();
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        <label>
          当前密码
          <input
            type="password"
            name="current"
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          新密码
          <input
            type="password"
            name="new"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        <button>更新密码</button>
        <ErrorText error={error} />
      </form>
    </section>
  );
}
function agentStatus(value: unknown): string {
  if (!value || typeof value !== "object") return "尚无 Agent 状态";
  const v = value as Record<string, unknown>;
  const parts = [v.app, v.state, v.title, v.msg].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  if (typeof v.progress === "number" && v.progress >= 0 && v.progress <= 100)
    parts.push(`${v.progress}%`);
  return parts.length ? parts.join(" · ").slice(0, 300) : "尚无 Agent 状态";
}
function Bridges() {
  const q = useQuery({
    queryKey: ["bridges"],
    queryFn: () => api<Bridge[]>("/bridges"),
    refetchInterval: 5000,
  });
  return (
    <section>
      <h1>我的机器</h1>
      <p>选择代理以查看本地与远程终端。</p>
      <ErrorText error={q.error} />
      {q.isPending && <p>加载中…</p>}
      <div className={styles.cards}>
        {q.data?.map((b) => (
          <Link className={styles.card} key={b.id} to={`/bridges/${b.id}`}>
            <h2>{b.name}</h2>
            <span className={b.online ? styles.online : ""}>
              {b.online
                ? b.core_available
                  ? "在线 · core 可用"
                  : "在线 · core 不可用"
                : "离线"}
            </span>
            <p>
              {b.os} · {b.agent_version}
            </p>
          </Link>
        ))}
      </div>
      {q.data?.length === 0 && (
        <p>还没有代理。先在「连接 Key」中创建 Key，再启动机器上的代理。</p>
      )}
    </section>
  );
}
function Keys() {
  const q = useQuery({
    queryKey: ["keys"],
    queryFn: () => api<KeyInfo[]>("/keys"),
  });
  const [secret, setSecret] = useState(""),
    [error, setError] = useState("");
  async function change(id: string, rotate = false) {
    try {
      if (rotate) {
        const result = await api<{ key: string }>(
          `/keys/${id}/rotate`,
          "POST",
          { name: "轮换 Key" },
        );
        setSecret(result.key);
      } else {
        await api(`/keys/${id}`, "DELETE");
      }
      await q.refetch();
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section>
      <h1>连接 Key</h1>
      <p>每台机器建议使用独立 Key。撤销将立即断开相关连接，不结束终端进程。</p>
      <form
        className={styles.row}
        onSubmit={async (e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          try {
            const result = await api<{ key: string }>("/keys", "POST", {
              name: d.get("name"),
              expires_at: d.get("expiry")
                ? new Date(String(d.get("expiry"))).toISOString()
                : null,
            });
            setSecret(result.key);
            await q.refetch();
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        <label>
          名称
          <input name="name" maxLength={128} required />
        </label>
        <label>
          到期时间（可选）
          <input type="datetime-local" name="expiry" />
        </label>
        <button>生成 Key</button>
      </form>
      <ErrorText error={error || q.error} />
      <ul className={styles.list}>
        {q.data?.map((k) => (
          <li key={k.id}>
            <strong>{k.name}</strong>
            <code>{k.mask}</code>
            <span>
              {k.revoked_at
                ? "已撤销"
                : k.expires_at
                  ? `到期 ${new Date(k.expires_at).toLocaleString()}`
                  : "无到期时间"}
            </span>
            {!k.revoked_at && (
              <>
                <button onClick={() => void change(k.id, true)}>轮换</button>
                <button onClick={() => void change(k.id)}>撤销</button>
              </>
            )}
          </li>
        ))}
      </ul>
      <Dialog.Root
        open={!!secret}
        onOpenChange={(open) => {
          if (!open) setSecret("");
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content className={styles.dialog}>
            <Dialog.Title>Key 仅显示一次</Dialog.Title>
            <Dialog.Description>
              保存以下配置到代理的 auth/config.json，并将权限设为
              0600。关闭后无法找回秘密。
            </Dialog.Description>
            <pre>
              {JSON.stringify(
                {
                  server_url: location.origin,
                  key: secret,
                  name: "my-machine",
                  core: {
                    binary: "/absolute/path/to/hc",
                    session: "default",
                    socket: null,
                  },
                  connection: {
                    reconnect_min_seconds: 1,
                    reconnect_max_seconds: 30,
                  },
                },
                null,
                2,
              )}
            </pre>
            <button
              onClick={() => {
                void navigator.clipboard
                  .writeText(secret)
                  .catch((e) => setError(String(e)));
              }}
            >
              复制 Key
            </button>
            <Dialog.Close>已保存，关闭</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
function Admin() {
  const metadata = useQuery({
    queryKey: ["connections"],
    queryFn: () => api<ConnectionInfo[]>("/admin/connections"),
    refetchInterval: 5000,
  });
  const q = useQuery({
    queryKey: ["users"],
    queryFn: () => api<ManagedUser[]>("/admin/users"),
  });
  const [error, setError] = useState(""),
    [target, setTarget] = useState<ManagedUser | null>(null);
  async function update(id: string, data: unknown) {
    try {
      await api(`/admin/users/${id}`, "PATCH", data);
      await q.refetch();
      setTarget(null);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section>
      <h1>用户管理</h1>
      <p>管理员可管理账号与连接元数据，无法访问其他用户的终端。</p>
      <form
        className={styles.row}
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget,
            d = new FormData(form);
          try {
            await api("/admin/users", "POST", {
              username: d.get("name"),
              password: d.get("password"),
            });
            form.reset();
            await q.refetch();
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        <label>
          用户名
          <input name="name" required />
        </label>
        <label>
          初始密码
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        <button>创建用户</button>
      </form>
      <ErrorText error={error || q.error || metadata.error} />
      <ul className={styles.list}>
        {q.data?.map((u) => (
          <li key={u.id}>
            <strong>{u.username}</strong>
            <span>
              {u.role} · {u.status}
            </span>
            {u.role !== "admin" && (
              <>
                <button
                  onClick={() =>
                    void update(u.id, {
                      status: u.status === "active" ? "disabled" : "active",
                    })
                  }
                >
                  {u.status === "active" ? "禁用" : "启用"}
                </button>
                <button onClick={() => setTarget(u)}>重置密码</button>
              </>
            )}
          </li>
        ))}
      </ul>
      <h2>在线连接元数据</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>用户 ID</th>
              <th>代理 ID</th>
              <th>隧道数</th>
              <th>Core</th>
            </tr>
          </thead>
          <tbody>
            {metadata.data?.map((c) => (
              <tr key={c.connection_id}>
                <td>{c.user_id}</td>
                <td>{c.bridge_id}</td>
                <td>{c.tunnels}</td>
                <td>{c.core_available ? "可用" : "不可用"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog.Root
        open={!!target}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content className={styles.dialog}>
            <Dialog.Title>重置 {target?.username} 的密码</Dialog.Title>
            <Dialog.Description>
              用户将在下次登录时修改密码，已有会话将退出。
            </Dialog.Description>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (target)
                  void update(target.id, {
                    password: new FormData(e.currentTarget).get("password"),
                  });
              }}
            >
              <label>
                新密码
                <input
                  type="password"
                  name="password"
                  minLength={12}
                  autoComplete="new-password"
                  required
                />
              </label>
              <button>重置</button>
              <Dialog.Close type="button">取消</Dialog.Close>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
function WorkspaceRoute() {
  const { id } = useParams();
  return <Workspace key={id} />;
}
function Workspace() {
  const { refresh: refreshAuth } = useContext(Auth);
  const { id = "" } = useParams();
  const [core, setCore] = useState<CoreClient | null>(null),
    [records, setRecords] = useState<TerminalRecord[]>([]),
    [state, setState] = useState("连接中"),
    [error, setError] = useState(""),
    [tabs, setTabs] = useState<Tab[]>([]),
    [split, setSplit] = useState(false),
    [active, setActive] = useState(""),
    [version, setVersion] = useState(0),
    [sizes, setSizes] = useState<number[]>([]),
    [kill, setKill] = useState<string | null>(null),
    [saving, setSaving] = useState(false),
    [layoutLoaded, setLayoutLoaded] = useState(false),
    [epochs, setEpochs] = useState<Record<string, number>>({});
  useEffect(() => {
    let disposed = false;
    setLayoutLoaded(false);
    api<{ version: number; document: Layout | null }>(`/layouts/${id}`)
      .then((l) => {
        if (disposed) return;
        setVersion(l.version);
        const layout = readLayout(l.document);
        setTabs(layout?.tabs || []);
        setSplit(layout?.split || false);
        setActive(layout?.active || "");
        setSizes(layout?.sizes || []);
        setLayoutLoaded(true);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [id]);
  useEffect(() => {
    let stopped = false,
      current: CoreClient | null = null,
      timer: ReturnType<typeof setTimeout> | undefined,
      delay = 1000;
    async function connect() {
      if (stopped) return;
      const c = new CoreClient();
      current = c;
      setState("连接中");
      let reconnecting = false;
      const retry = (message: string) => {
        if (stopped || reconnecting) return;
        reconnecting = true;
        setState(message + " · 正在重连");
        setCore(null);
        c.dispose();
        timer = setTimeout(() => void connect(), delay);
        delay = Math.min(delay * 2, 30000);
      };
      c.onDisconnect = retry;
      try {
        await api<User>("/auth/me");
        await c.connect(id);
        if (stopped) {
          c.dispose();
          return;
        }
        const store = new TerminalStore();
        c.onEvent = (event) => {
          if (stopped) return;
          if (store.apply(event)) setRecords(store.list());
          if (event.params?.type === "restarted" && event.params.terminal) {
            const address = event.params.terminal;
            setEpochs((old) => ({
              ...old,
              [address]: (old[address] || 0) + 1,
            }));
          }
        };
        await c.subscribe((snapshot) => {
          store.reset(snapshot);
          if (!stopped) setRecords(store.list());
        });
        if (stopped) {
          c.dispose();
          return;
        }
        setCore(c);
        setState("已连接");
        delay = 1000;
      } catch (e) {
        if (e instanceof APIError && e.status === 401) {
          c.dispose();
          await refreshAuth();
          return;
        }
        retry(String(e));
      }
    }
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      current?.dispose();
    };
  }, [id]);
  async function run() {
    if (!core) return;
    try {
      await core.call("terminal.run", {
        env: {
          TERM: "xterm-256color",
          TERM_PROGRAM: "herdr-bridge",
          COLORTERM: "truecolor",
        },
        no_parent: true,
      });
      const result = await core.call<{ terminals: TerminalRecord[] }>(
        "terminal.list",
      );
      setRecords(result.terminals);
    } catch (e) {
      setError(String(e));
    }
  }
  function open(t: TerminalRecord, observe: boolean) {
    if (tabs.some((x) => x.id === t.address)) {
      setTabs(tabs.map((x) => (x.id === t.address ? { ...x, observe } : x)));
    } else {
      if (tabs.length >= 8) {
        setError("最多打开 8 个终端标签");
        return;
      }
      setTabs([...tabs, { id: t.address, observe }]);
    }
    setActive(t.address);
  }
  function detach(tid: string) {
    const next = tabs.filter((t) => t.id !== tid);
    setTabs(next);
    if (active === tid) setActive(next[0]?.id || "");
  }
  async function save() {
    setSaving(true);
    try {
      const result = await api<{ version: number }>(`/layouts/${id}`, "PUT", {
        version,
        document: { tabs, split, active, sizes },
      });
      setVersion(result.version);
      setError("");
    } catch (e) {
      setError(String(e) + "；布局未覆盖。重新进入页面以读取已保存的布局。");
    } finally {
      setSaving(false);
    }
  }
  const visible = split
    ? tabs
    : tabs.filter((t) => t.id === (active || tabs[0]?.id));
  return (
    <section className={styles.workspace}>
      <header className={styles.row}>
        <h1>终端工作台</h1>
        <span role="status">{state}</span>
        <button disabled={!core} onClick={() => void run()}>
          新建 Shell
        </button>
        <button
          disabled={!core}
          onClick={() => {
            void core
              ?.call<{ terminals: TerminalRecord[] }>("terminal.list")
              .then((r) => setRecords(r.terminals))
              .catch((e) => setError(String(e)));
          }}
        >
          刷新终端
        </button>
        <button onClick={() => setSplit(!split)}>
          {split ? "标签视图" : "基础分屏"}
        </button>
        <button disabled={saving || !layoutLoaded} onClick={() => void save()}>
          保存布局
        </button>
      </header>
      <ErrorText error={error} />
      <div className={styles.workbody}>
        <aside>
          <h2>终端与 Agent</h2>
          {records.map((t) => (
            <div className={styles.record} key={`${id}/${t.address}`}>
              <strong>{t.title || t.address}</strong>
              <small>
                {t.address} · {t.state}
              </small>
              <small>{agentStatus(t.status)}</small>
              <button
                disabled={t.state !== "live"}
                onClick={() => open(t, false)}
              >
                附着
              </button>
              <button
                disabled={t.state !== "live"}
                onClick={() => open(t, true)}
              >
                只读
              </button>
            </div>
          ))}
          {records.length === 0 && <p>暂无终端</p>}
        </aside>
        <div className={styles.canvas}>
          <nav aria-label="终端标签">
            {tabs.map((t) => (
              <button
                key={t.id}
                aria-pressed={active === t.id}
                onClick={() => setActive(t.id)}
              >
                {t.id}
                {t.observe ? " · 只读" : ""}
              </button>
            ))}
          </nav>
          {core && visible.length > 0 ? (
            <Group
              orientation="horizontal"
              onLayoutChanged={(layout) => {
                if (split) setSizes(visible.map((t) => layout[t.id]));
              }}
            >
              {visible.map((t, i) => (
                <React.Fragment key={`${id}/${t.id}/${epochs[t.id] || 0}`}>
                  {i > 0 && <Separator className={styles.handle} />}
                  <Panel
                    id={t.id}
                    minSize="10%"
                    defaultSize={`${sizes.length === visible.length ? sizes[i] : 100 / visible.length}%`}
                  >
                    <TerminalPane
                      core={core}
                      id={t.id}
                      observe={t.observe}
                      grid={records.find((r) => r.address === t.id)}
                      onDetach={() => detach(t.id)}
                      onKill={() => setKill(t.id)}
                    />
                  </Panel>
                </React.Fragment>
              ))}
            </Group>
          ) : (
            <p className={styles.empty}>
              {core
                ? "选择终端，或新建 Shell。"
                : "等待代理连接，恢复后重新确认终端状态。"}
            </p>
          )}
        </div>
      </div>
      <Dialog.Root
        open={kill !== null}
        onOpenChange={(open) => {
          if (!open) setKill(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content className={styles.dialog}>
            <Dialog.Title>结束终端 {kill}？</Dialog.Title>
            <Dialog.Description>
              这将结束程序，所有查看窗口都会受到影响。仅关闭当前视图请使用「分离」。
            </Dialog.Description>
            <button
              className={styles.danger}
              onClick={async () => {
                if (!core || !kill) return;
                try {
                  await core.call("terminal.kill", { terminal: kill });
                  detach(kill);
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
function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true);
  const query = useQueryClient();
  async function refresh() {
    try {
      const u = await api<User>("/auth/me");
      setCSRF(u.csrf_token);
      setUser(u);
    } catch {
      setCSRF("");
      setUser(null);
      query.clear();
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  if (loading) return <p>加载中…</p>;
  return (
    <Auth.Provider value={{ user, refresh }}>
      {!user ? (
        <Login />
      ) : (
        <>
          <header className={styles.topbar}>
            <Link to="/">Herdr Bridge</Link>
            <nav>
              <Link to="/">机器</Link>
              <Link to="/keys">连接 Key</Link>
              {user.role === "admin" && <Link to="/admin">用户管理</Link>}
              <Link to="/password">修改密码</Link>
            </nav>
            <span>{user.username}</span>
            <button
              onClick={async () => {
                try {
                  await api("/auth/logout", "POST");
                  setUser(null);
                  setCSRF("");
                  query.clear();
                } catch {
                  await refresh();
                }
              }}
            >
              退出
            </button>
          </header>
          <main className={styles.main}>
            {user.must_change_password ? (
              <Password />
            ) : (
              <Routes>
                <Route path="/" element={<Bridges />} />
                <Route path="/keys" element={<Keys />} />
                <Route path="/password" element={<Password />} />
                <Route path="/bridges/:id" element={<WorkspaceRoute />} />
                <Route
                  path="/admin"
                  element={
                    user.role === "admin" ? <Admin /> : <Navigate to="/" />
                  }
                />
                <Route path="*" element={<Navigate to="/" />} />
              </Routes>
            )}
          </main>
        </>
      )}
    </Auth.Provider>
  );
}
const query = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={query}>
    <BrowserRouter basename="/ui">
      <App />
    </BrowserRouter>
  </QueryClientProvider>,
);
