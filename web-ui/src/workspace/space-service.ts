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
