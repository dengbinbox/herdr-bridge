import { randomUUID } from "../uuid";
import { CoreClient } from "../core";
import { nativeLayout, obj, qualify } from "./model";

// Shared machine layout, using the same document and terminal labels as the app.
export async function createSpace(core: CoreClient, machine: string, cwd = "") {
  if (!["terminal.run", "doc.get", "doc.set"].every((m) => core.methods.includes(m)))
    throw new Error("此 Core 不支持创建共享空间");
  const on = machine || undefined;
  async function read() {
    const doc = await core.call<{ version: number; value: unknown }>("doc.get", { name: "herdr-app", on });
    if (!Number.isSafeInteger(doc.version) || doc.version < 0)
      throw new Error("共享布局版本无效");
    nativeLayout(doc.value, machine); // Never replace an unreadable document.
    return doc;
  }
  let doc = await read();
  const id = `sp-${randomUUID()}`;
  const tab = `tb-${randomUUID()}`;
  const pane = `p-${randomUUID()}`;
  const result = await core.call<{ address: string }>("terminal.run", {
    on, cwd: cwd || undefined, keep: true, no_parent: true,
    labels: { "herdr.space": id, "herdr.tab": tab, "herdr.seen": "0" },
    env: { TERM: "xterm-256color", TERM_PROGRAM: "herdr-bridge", COLORTERM: "truecolor" },
  });
  const address = qualify(result.address, machine);
  const local = machine && address.startsWith(machine + "/") ? address.slice(machine.length + 1) : address;
  const space = { id, name: "", folder: cwd, tabs: [{ id: tab, name: "", root: { id: pane, type: "block", content: { terminal: local } } }] };
  try {
    for (let attempt = 0; ; attempt++) {
      const value = { ...obj(doc.value), spaces: [...(obj(doc.value).spaces as unknown[] || []), space] };
      try {
        await core.call("doc.set", { name: "herdr-app", on, version: doc.version, value });
        return { space: `core:${machine}:${id}`, tab: `core:${machine}:${tab}` };
      } catch (error) {
        if (obj(obj(error).data).kind !== "conflict" || attempt >= 2) throw error;
        doc = await read();
      }
    }
  } catch (error) {
    // Keep the running terminal recoverable; never kill a session on a failed write.
    throw new Error(`终端 ${address} 已创建，但共享空间保存失败：${String(error)}`);
  }
}

function terminals(value: unknown): string[] {
  const n = obj(value);
  return [
    ...(typeof obj(n.content).terminal === "string" ? [obj(n.content).terminal as string] : []),
    ...(Array.isArray(n.children) ? n.children.flatMap(terminals) : []),
    ...(Array.isArray(n.floating) ? n.floating.flatMap(terminals) : []),
  ];
}

async function editDocument(
  core: CoreClient,
  machine: string,
  edit: (spaces: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>,
  valid = () => true,
) {
  for (let attempt = 0; attempt < 3 && valid(); attempt++) {
    const on = machine || undefined;
    const doc = await core.call<{ version: number; value: unknown }>("doc.get", { name: "herdr-app", on });
    nativeLayout(doc.value, machine);
    if (!Number.isSafeInteger(doc.version) || doc.version < 0) throw new Error("共享布局版本无效");
    if (!valid()) return;
    const spaces = (obj(doc.value).spaces || []) as Record<string, unknown>[];
    const next = await edit(spaces);
    if (!valid() || JSON.stringify(next) === JSON.stringify(spaces)) return;
    try {
      await core.call("doc.set", { name: "herdr-app", on, version: doc.version, value: { ...obj(doc.value), spaces: next } });
      return;
    } catch (error) {
      if (obj(obj(error).data).kind !== "conflict" || attempt === 2) throw error;
    }
  }
}

export async function closeSpace(core: CoreClient, machine: string, id: string) {
  await editDocument(core, machine, async (spaces) => {
    const space = spaces.find((s) => s.id === id);
    if (!space) return spaces;
    const addresses = new Set((space.tabs as unknown[]).flatMap((t) => terminals(obj(t).root)));
    for (const address of addresses) {
      try {
        await core.call("terminal.kill", { terminal: qualify(address, machine) });
      } catch (error) {
        if (obj(obj(error).data).kind !== "not_found") throw error;
      }
    }
    return spaces.filter((s) => s.id !== id);
  });
}

// Only prune confirmed closures. Missing live records alone can mean a lost connection.
export async function reconcileSpaces(core: CoreClient, machine: string, live: Set<string>, valid = () => true) {
  if (!["doc.set", "terminal.get"].every((m) => core.methods.includes(m))) return;
  await editDocument(core, machine, async (spaces) => {
    const closed = new Set<string>();
    const candidates = new Set(spaces.flatMap((s) => (s.tabs as unknown[]).flatMap((t) => terminals(obj(t).root))));
    for (const terminal of candidates) {
      if (!valid()) return spaces;
      const address = qualify(terminal, machine);
      if (live.has(address)) continue;
      try {
        const record = await core.call<{ reason?: string }>("terminal.get", { terminal: address });
        if (["exited", "killed"].includes(record.reason || "")) closed.add(terminal);
      } catch (error) {
        if (obj(obj(error).data).kind === "not_found") closed.add(terminal);
      }
    }
    if (!closed.size) return spaces;
    function prune(raw: unknown): unknown | null {
      const n = obj(raw);
      if (closed.has(obj(n.content).terminal as string)) return null;
      const next = { ...n };
      if (Array.isArray(n.floating)) next.floating = n.floating.map(prune).filter((v) => v !== null);
      if (Array.isArray(n.children)) {
        const children = n.children.map(prune).filter((v) => v !== null);
        if (n.children.length && !children.length && !(next.floating as unknown[] | undefined)?.length) return null;
        next.children = children;
        if (n.type === "stack" && !children.some((c) => obj(c).id === n.active)) next.active = obj(children[0]).id;
      }
      return next;
    }
    return spaces.flatMap((s) => {
      const tabs = (s.tabs as unknown[]).flatMap((t) => {
        const root = prune(obj(t).root);
        return root === null ? [] : [{ ...obj(t), root }];
      });
      return (s.tabs as unknown[]).length && !tabs.length ? [] : [{ ...s, tabs }];
    });
  }, valid);
}
