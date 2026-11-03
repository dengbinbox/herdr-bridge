import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { CoreClient } from "../core";
import {
  listDirectory,
  readFile,
  joinPath,
  type Context,
  type Entry,
} from "./file-service";
import { gitStatus, gitDiff, diffLines, type Change } from "./git-service";
import styles from "./workspace.module.css";
function useTick(active: boolean) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    }, 10000);
    return () => clearInterval(timer);
  }, [active]);
  return [tick, () => setTick((t) => t + 1)] as const;
}
function Directory({
  core,
  ctx,
  path,
  depth,
  budget,
  onFile,
  tick,
}: {
  core: CoreClient;
  ctx: Context;
  path: string;
  depth: number;
  budget: MutableRefObject<number>;
  onFile: (p: string) => void;
  tick: number;
}) {
  const [data, setData] = useState<{
      entries: Entry[];
      truncated: boolean;
    } | null>(null),
    [error, setError] = useState(""),
    [open, setOpen] = useState<string[]>([]);
  useEffect(() => {
    let live = true,
      allocated = 0;
    setError("");
    void listDirectory(core, ctx, path)
      .then((r) => {
        if (!live) return;
        const available = Math.max(0, 5000 - budget.current);
        const entries = r.entries.slice(0, available);
        allocated = entries.length;
        budget.current += allocated;
        setData({
          entries,
          truncated: r.truncated || entries.length < r.entries.length,
        });
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
      budget.current -= allocated;
    };
  }, [core, path, tick]);
  return (
    <div className={styles.tree}>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>读取目录…</p>}
      {data?.entries.map((e) => {
        const full = joinPath(path, e.name),
          expanded = open.includes(full);
        return (
          <div key={e.name}>
            <button
              className={styles.treeRow}
              aria-expanded={e.directory ? expanded : undefined}
              title={e.name}
              onClick={() =>
                e.directory
                  ? setOpen((a) =>
                      expanded ? a.filter((p) => p !== full) : [...a, full],
                    )
                  : onFile(full)
              }
            >
              <span>{e.directory ? (expanded ? "▾" : "▸") : "·"}</span>
              <span>{e.name}</span>
              {e.directory && <small>目录</small>}
            </button>
            {e.directory &&
              expanded &&
              (depth >= 40 ? (
                <p>已达到 40 层目录上限</p>
              ) : (
                <Directory
                  core={core}
                  ctx={ctx}
                  path={full}
                  depth={depth + 1}
                  budget={budget}
                  onFile={onFile}
                  tick={tick}
                />
              ))}
          </div>
        );
      })}
      {data?.entries.length === 0 && <p>空目录</p>}
      {data?.truncated && <p>目录显示已达上限（每层 500 / 总计 5000）</p>}
    </div>
  );
}
function TextPreview({ text, diff = false }: { text: string; diff?: boolean }) {
  if (diff) {
    const parsed = diffLines(text);
    return (
      <>
        <div className={styles.code}>
          {parsed.lines.map((l, i) => (
            <div key={i} data-kind={l.kind}>
              <span>{l.old ?? ""}</span>
              <span>{l.next ?? ""}</span>
              <code>{l.text}</code>
            </div>
          ))}
        </div>
        {parsed.truncated && <p>差异已截断（1500 行 / 每行 4000 字符）</p>}
      </>
    );
  }
  return (
    <div className={styles.code}>
      {text
        .split("\n")
        .slice(0, 1500)
        .map((l, i) => (
          <div key={i}>
            <span>{i + 1}</span>
            <code>{l.slice(0, 4000)}</code>
          </div>
        ))}
    </div>
  );
}
function Preview({
  core,
  ctx,
  path,
  change,
  head,
  onBack,
}: {
  core: CoreClient;
  ctx: Context;
  path: string;
  change?: Change;
  head?: boolean;
  onBack: () => void;
}) {
  const [data, setData] = useState<{ text: string; truncated: boolean } | null>(
      null,
    ),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    void (
      change ? gitDiff(core, ctx, change, !!head) : readFile(core, ctx, path)
    )
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [core, ctx.cwd, ctx.machine, path, change?.status, head]);
  return (
    <div className={styles.preview}>
      <div className={styles.sectionHead}>
        <button onClick={onBack}>← 返回</button>
        <button
          disabled={!data}
          onClick={() =>
            void navigator.clipboard
              .writeText(data?.text || "")
              .catch((e) => setError(String(e)))
          }
        >
          复制文本
        </button>
      </div>
      <div className={styles.path} title={path}>
        {path}
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>读取内容…</p>}
      {data &&
        (data.text ? (
          <TextPreview text={data.text} diff={!!change} />
        ) : (
          <p>
            {change
              ? "无可显示的文本差异（可能是空文件或仅元数据变化）"
              : "空文件"}
          </p>
        ))}
      {data?.text.includes("Binary files") && (
        <p>二进制变更，无法显示文本差异</p>
      )}
      {change?.status.includes("U") && <p>此文件存在合并冲突</p>}
      {data?.truncated && <p>预览已截断，请在终端查看完整内容。</p>}
    </div>
  );
}
function Files({
  core,
  ctx,
  active,
}: {
  core: CoreClient;
  ctx: Context;
  active: boolean;
}) {
  const [tick, refresh] = useTick(active),
    [file, setFile] = useState("");
  const budget = useRef(0);
  return (
    <div hidden={!active} className={styles.inspectorBody}>
      {file ? (
        <Preview
          key={file + tick}
          core={core}
          ctx={ctx}
          path={file}
          onBack={() => setFile("")}
        />
      ) : (
        <>
          <div className={styles.sectionHead}>
            <small>只读文件浏览</small>
            <button onClick={refresh}>刷新文件</button>
          </div>
          <Directory
            core={core}
            ctx={ctx}
            path={ctx.cwd}
            depth={0}
            budget={budget}
            onFile={setFile}
            tick={tick}
          />
        </>
      )}
    </div>
  );
}
function Changes({
  core,
  ctx,
  active,
}: {
  core: CoreClient;
  ctx: Context;
  active: boolean;
}) {
  const [tick, refresh] = useTick(active),
    [data, setData] = useState<
      Awaited<ReturnType<typeof gitStatus>> | undefined
    >(),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<string>("");
  useEffect(() => {
    if (!active) return;
    let live = true;
    setError("");
    void gitStatus(core, ctx)
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [core, ctx.cwd, ctx.machine, tick, active]);
  const change = data?.changes.find((c) => c.path === selected);
  return (
    <div hidden={!active} className={styles.inspectorBody}>
      {change && data ? (
        <Preview
          key={selected + tick}
          core={core}
          ctx={data.context}
          path={selected}
          change={change}
          head={data.hasHead}
          onBack={() => setSelected("")}
        />
      ) : (
        <>
          <div className={styles.sectionHead}>
            <small>{data?.changes.length ?? 0} 个未提交文件</small>
            <button onClick={refresh}>刷新变更</button>
          </div>
          {error ? (
            <p role="alert">{error}</p>
          ) : data === undefined ? (
            <p>读取 Git 状态…</p>
          ) : data === null ? (
            <p>当前目录不是 Git 仓库</p>
          ) : !data.changes.length ? (
            <p>没有未提交修改</p>
          ) : (
            data.changes.map((c) => (
              <button
                className={styles.changeRow}
                key={c.path}
                onClick={() => setSelected(c.path)}
              >
                <code>{c.status}</code>
                <span>{c.path}</span>
                <small>
                  {c.added === "-"
                    ? "二进制"
                    : c.added === ""
                      ? "未统计"
                      : `+${c.added} −${c.removed}`}
                </small>
              </button>
            ))
          )}
          {data?.truncated && <p>仅显示前 1000 个文件</p>}
        </>
      )}
    </div>
  );
}
export function InspectorPanel({
  core,
  ctx,
  tab,
  onTab,
  onClose,
}: {
  core: CoreClient | null;
  ctx: Context;
  tab: "files" | "changes";
  onTab: (t: "files" | "changes") => void;
  onClose: () => void;
}) {
  return (
    <aside className={styles.inspector} aria-label="文件与变更">
      <header className={styles.sectionHead}>
        <div role="tablist" aria-label="检查面板">
          {(["files", "changes"] as const).map((t) => (
            <button
              role="tab"
              aria-selected={tab === t}
              key={t}
              onClick={() => onTab(t)}
            >
              {t === "files" ? "Files" : "Changes"}
            </button>
          ))}
        </div>
        <button aria-label="收起右栏" onClick={onClose}>
          »
        </button>
      </header>
      <div className={styles.path} title={ctx.cwd}>
        <strong>{ctx.machine || core?.machineName || "当前机器"}</strong>
        <br />
        {ctx.cwd || "尚未选择工作目录"}
      </div>
      {core && ctx.cwd ? (
        <>
          <Files core={core} ctx={ctx} active={tab === "files"} />
          <Changes core={core} ctx={ctx} active={tab === "changes"} />
        </>
      ) : (
        <p>
          {core ? "选择一个终端以浏览其工作目录。" : "连接恢复后可查看文件。"}
        </p>
      )}
    </aside>
  );
}
