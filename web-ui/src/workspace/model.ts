import type { TerminalRecord } from "../core";
import { readLayout } from "../layout";
export type Pane = { id: string; terminal: string; observe: boolean };
export type Node = {
  id: string;
  type: "row" | "column" | "stack" | "block";
  children?: Node[];
  pane?: Pane;
  active?: string;
};
export type Tab = { id: string; name: string; root: Node };
export type Space = {
  id: string;
  name: string;
  folder: string;
  machine: string;
  source: "core" | "web" | "recovered";
  tabs: Tab[];
  unavailable?: string;
};
export type View = {
  schemaVersion: 2;
  spaces: Space[];
  active: string;
  tabs: Record<string, string>;
  focus: Record<string, string>;
  observe: Record<string, boolean>;
  detached: string[];
  left: boolean;
  right: boolean;
  inspector: "files" | "changes";
  grouped: boolean;
  collapsed: string[];
  sizes: Record<string, number>;
};
export const emptyView = (): View => ({
  schemaVersion: 2,
  spaces: [],
  active: "",
  tabs: {},
  focus: {},
  observe: {},
  detached: [],
  left: true,
  right: true,
  inspector: "files",
  grouped: false,
  collapsed: [],
  sizes: {},
});
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export const str = (v: unknown) => (typeof v === "string" ? v : "");
export const machineOf = (address: string) =>
  address.includes("/") ? address.slice(0, address.lastIndexOf("/")) : "";
export const qualify = (id: string, machine: string) =>
  !machine || id.startsWith(machine + "/") ? id : `${machine}/${id}`;
export const basename = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;
export function cwdOf(t?: TerminalRecord, space?: Space) {
  return str(obj(t?.foreground).cwd) || str(t?.cwd) || space?.folder || "";
}
export function panes(node: Node): Pane[] {
  return node.pane ? [node.pane] : (node.children || []).flatMap(panes);
}
export function shown(node: Node): Pane[] {
  return node.type === "stack"
    ? shown(
        node.children?.find((n) => n.id === node.active) ||
          node.children?.[0] || { id: "", type: "block" },
      )
    : node.pane
      ? [node.pane]
      : (node.children || []).flatMap(shown);
}
export function terminalTab(address: string, observe = false, scope = ""): Tab {
  const key = scope ? `${scope}:${address}` : address;
  return {
    id: `tab:${key}`,
    name: "",
    root: {
      id: `pane:${key}`,
      type: "block",
      pane: { id: `pane:${key}`, terminal: address, observe },
    },
  };
}
export function spaceName(s: Space, records: TerminalRecord[]) {
  const first = s.tabs.flatMap((t) => panes(t.root))[0];
  return (
    s.name ||
    basename(
      cwdOf(
        records.find((t) => t.address === first?.terminal),
        s,
      ),
    ) ||
    "未命名空间"
  );
}
export function nativeLayout(
  value: unknown,
  machine: string,
): { spaces: Space[]; warning: string } {
  if (value == null) return { spaces: [], warning: "" };
  const doc = obj(value);
  if (!Array.isArray(doc.spaces))
    throw new Error("无法解码原生布局，保留上次空间");
  let count = 0,
    warning = "";
  const key = (id: string) => `core:${machine}:${id}`;
  function node(raw: unknown, depth = 0): Node {
    const n = obj(raw),
      id = key(str(n.id) || String(count));
    if (++count > 5000 || depth > 40) {
      warning = "布局超出显示上限";
      return { id, type: "block" };
    }
    if (n.type === "block" && typeof obj(n.content).terminal === "string")
      return {
        id,
        type: "block",
        pane: {
          id,
          terminal: qualify(str(obj(n.content).terminal), machine),
          observe: false,
        },
      };
    const children = Array.isArray(n.children)
      ? n.children.map((c) => node(c, depth + 1))
      : [];
    if (!["row", "column", "stack"].includes(str(n.type)))
      warning = "部分原生节点无法显示；可识别的终端已保留";
    return {
      id,
      type:
        n.type === "column" ? "column" : n.type === "stack" ? "stack" : "row",
      children,
      active: key(str(n.active)),
    };
  }
  const spaces = doc.spaces.slice(0, 1000).map((raw): Space => {
    const s = obj(raw);
    if (!str(s.id) || !Array.isArray(s.tabs))
      throw new Error("原生空间格式无效，保留上次布局");
    return {
      id: key(str(s.id)),
      name: str(s.name),
      folder: str(s.folder),
      machine,
      source: "core",
      tabs: s.tabs.map((raw, i) => {
        const t = obj(raw);
        return {
          id: key(str(t.id) || `${s.id}:${i}`),
          name: str(t.name),
          root: node(t.root),
        };
      }),
    };
  });
  return { spaces, warning };
}
export function readView(value: unknown): View | null {
  if (value == null) return emptyView();
  const v = obj(value);
  if (v.schemaVersion !== 2) {
    const old = readLayout(value);
    if (!old) return null;
    const view = emptyView();
    const tabs = old.tabs.map((t) => terminalTab(t.id, t.observe));
    const root: Node = {
      id: "legacy-split",
      type: "row",
      children: tabs.map((t) => t.root),
    };
    view.spaces = [
      {
        id: "web:recovered",
        name: "网页恢复空间",
        folder: "",
        machine: "",
        source: "web",
        tabs: old.split ? [{ id: "legacy", name: "恢复分屏", root }] : tabs,
      },
    ];
    view.active = "web:recovered";
    view.tabs[view.active] = old.split ? "legacy" : `tab:${old.active}`;
    view.focus[view.tabs[view.active]] = `pane:${old.active}`;
    old.sizes?.forEach((n, i) => {
      if (tabs[i]) view.sizes[tabs[i].root.id] = n;
    });
    return view;
  }
  // Validate the persisted tree with a bounded traversal; native documents are never persisted here.
  let nodes = 0;
  function validNode(raw: unknown, depth = 0): boolean {
    const n = obj(raw);
    return (
      ++nodes <= 5000 &&
      depth <= 40 &&
      !!str(n.id) &&
      ["row", "column", "stack", "block"].includes(str(n.type)) &&
      (n.pane !== undefined
        ? !!str(obj(n.pane).terminal) &&
          !!str(obj(n.pane).id) &&
          typeof obj(n.pane).observe === "boolean"
        : Array.isArray(n.children) &&
          n.children.every((c) => validNode(c, depth + 1)))
    );
  }
  if (
    !Array.isArray(v.spaces) ||
    v.spaces.length > 1000 ||
    !v.spaces.every((raw) => {
      const s = obj(raw);
      return (
        s.source === "web" &&
        !!str(s.id) &&
        typeof s.machine === "string" &&
        typeof s.folder === "string" &&
        typeof s.name === "string" &&
        Array.isArray(s.tabs) &&
        s.tabs.every((raw) => {
          const t = obj(raw);
          return !!str(t.id) && typeof t.name === "string" && validNode(t.root);
        })
      );
    })
  )
    return null;
  const out = emptyView();
  out.spaces = v.spaces as Space[];
  out.active = str(v.active);
  for (const field of ["tabs", "focus"] as const)
    for (const [k, x] of Object.entries(obj(v[field])))
      if (typeof x === "string") out[field][k] = x;
  for (const [k, x] of Object.entries(obj(v.observe)))
    if (typeof x === "boolean") out.observe[k] = x;
  for (const [k, x] of Object.entries(obj(v.sizes)))
    if (typeof x === "number" && Number.isFinite(x) && x > 0 && x <= 100)
      out.sizes[k] = x;
  for (const field of ["left", "right", "grouped"] as const)
    if (typeof v[field] === "boolean") out[field] = v[field];
  for (const field of ["collapsed", "detached"] as const)
    if (Array.isArray(v[field]))
      out[field] = v[field]
        .filter((x): x is string => typeof x === "string")
        .slice(0, 5000);
  out.inspector = v.inspector === "changes" ? "changes" : "files";
  return out;
}
export function recover(records: TerminalRecord[], spaces: Space[]): Space[] {
  const used = new Set(
    spaces.flatMap((s) =>
      s.tabs.flatMap((t) => panes(t.root).map((p) => p.terminal)),
    ),
  );
  const groups = new Map<string, Space>();
  for (const t of records) {
    if (
      used.has(t.address) ||
      (t.parent && records.some((p) => p.address === t.parent))
    )
      continue;
    const machine = machineOf(t.address);
    let s = groups.get(machine);
    if (!s) {
      s = {
        id: `recovered:${machine}`,
        name: "未分组",
        folder: "",
        machine,
        source: "recovered",
        tabs: [],
      };
      groups.set(machine, s);
    }
    s.tabs.push(terminalTab(t.address));
  }
  return [...groups.values()];
}

// A focused pane may live under a stack. Select its ancestor branches without changing the shared document.
export function focusTree(node: Node, focused?: string): Node {
  if (!focused || node.pane) return node;
  const children = node.children?.map((n) => focusTree(n, focused));
  const selected = children?.find((n) =>
    panes(n).some((p) => p.id === focused),
  );
  return {
    ...node,
    children,
    active: node.type === "stack" && selected ? selected.id : node.active,
  };
}
