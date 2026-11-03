import { createContext, useContext, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useParams,
  useLocation,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Workspace } from "./workspace/Workspace";
import {
  api,
  setCSRF,
  type User,
  type Bridge,
  type KeyInfo,
  type ManagedUser,
  type ConnectionInfo,
} from "./api";
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
  const { refresh } = useContext(Auth);
  return <Workspace key={id} refreshAuth={refresh} />;
}
function App() {
  const workspacePage = useLocation().pathname.startsWith("/bridges/");
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
          <header
            className={`${styles.topbar} ${workspacePage ? styles.workspaceTopbar : ""}`}
          >
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
          <main
            className={`${styles.main} ${workspacePage ? styles.workspaceMain : ""}`}
          >
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
