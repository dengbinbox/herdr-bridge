import { useEffect, useRef, useState } from "react";
import { api, APIError, type User } from "../api";
import { CoreClient, TerminalStore, type TerminalRecord } from "../core";
import { nativeLayout, type Space } from "./model";
export function useWorkspace(
  id: string,
  refreshAuth: () => Promise<void>,
  onRecords: (records: TerminalRecord[]) => void,
) {
  const [core, setCore] = useState<CoreClient | null>(null),
    [records, setRecords] = useState<TerminalRecord[]>([]),
    [machines, setMachines] = useState<{ name: string; state: string }[]>([]),
    [native, setNative] = useState<Space[]>([]),
    [state, setState] = useState("连接中"),
    [warning, setWarning] = useState(""),
    [epochs, setEpochs] = useState<Record<string, number>>({});
  const receive = useRef(onRecords);
  receive.current = onRecords;
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let stopped = false,
      current: CoreClient | null = null,
      timer: ReturnType<typeof setTimeout> | undefined,
      delay = 1000;
    async function connect() {
      if (stopped) return;
      const c = new CoreClient();
      current = c;
      let retrying = false,
        reading = false,
        dirty = false,
        subscribed = false;
      const valid = () => !stopped && current === c && !retrying;
      setState("连接中");
      const retry = (why: string) => {
        if (!valid()) return;
        retrying = true;
        setCore(null);
        setState(why + " · 正在重连");
        setNative((ss) => ss.map((s) => ({ ...s, unavailable: "连接中断" })));
        c.dispose();
        timer = setTimeout(() => void connect(), delay);
        delay = Math.min(delay * 2, 30000);
      };
      c.onDisconnect = retry;
      async function documents() {
        dirty = true;
        if (reading || !subscribed || !valid()) return;
        reading = true;
        try {
          while (dirty && valid()) {
            dirty = false;
            if (!c.methods.includes("doc.get")) {
              setWarning("此 Core 不支持原生空间文档");
              break;
            }
            const result = c.methods.includes("machine.list")
              ? await c.call<{ machines: { name: string; state: string }[] }>(
                  "machine.list",
                )
              : { machines: [] };
            if (!valid()) break;
            setMachines(result.machines || []);
            const targets = [
              { name: "", state: "connected" },
              ...(result.machines || []),
            ];
            for (const m of targets) {
              if (!valid()) break;
              if (m.state !== "connected") {
                setNative((ss) =>
                  ss.map((s) =>
                    s.machine === m.name
                      ? { ...s, unavailable: "远端不可用" }
                      : s,
                  ),
                );
                continue;
              }
              try {
                const doc = await c.call<{ value: unknown }>("doc.get", {
                  name: "herdr-app",
                  ...(m.name ? { on: m.name } : {}),
                });
                if (!valid()) break;
                if (dirty) continue;
                const parsed = nativeLayout(doc.value, m.name);
                setNative((ss) =>
                  [
                    ...ss.filter((s) => s.machine !== m.name),
                    ...parsed.spaces,
                  ].sort((a, b) => a.machine.localeCompare(b.machine)),
                );
                setWarning(parsed.warning);
              } catch (e) {
                if (valid()) {
                  setWarning(String(e));
                  setNative((ss) =>
                    ss.map((s) =>
                      s.machine === m.name
                        ? { ...s, unavailable: "布局暂不可用" }
                        : s,
                    ),
                  );
                }
              }
            }
          }
        } catch (e) {
          if (valid()) setWarning(String(e));
        } finally {
          reading = false;
        }
      }
      reload.current = () => void documents();
      try {
        await api<User>("/auth/me");
        await c.connect(id);
        if (!valid()) {
          c.dispose();
          return;
        }
        const store = new TerminalStore();
        c.onEvent = (event) => {
          if (!valid()) return;
          if (store.apply(event)) {
            const records = store.list();
            receive.current(records);
            setRecords(records);
          }
          if (event.params?.type === "restarted" && event.params.terminal) {
            const a = event.params.terminal;
            setEpochs((old) => ({ ...old, [a]: (old[a] || 0) + 1 }));
          }
          if (
            event.method === "missed" ||
            event.params?.type === "doc" ||
            event.params?.type === "created" ||
            event.method === "doc" ||
            String(event.params?.type).startsWith("machine")
          )
            void documents();
        };
        await c.subscribe((s) => {
          store.reset(s);
          if (valid()) {
            const records = store.list();
            receive.current(records);
            setRecords(records);
          }
        });
        if (!valid()) return;
        subscribed = true;
        setCore(c);
        setState("已连接");
        delay = 1000;
        void documents();
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
      reload.current = () => {};
    };
  }, [id, refreshAuth]);
  return {
    core,
    records,
    native,
    machines,
    state,
    warning,
    epochs,
    refresh: () => reload.current(),
  };
}
