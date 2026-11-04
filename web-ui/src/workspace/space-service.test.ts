import { expect, it, vi } from "vitest";
import { CoreClient } from "../core";
import { closeSpace, createSpace, reconcileSpaces } from "./space-service";

it("retries CAS with the latest layout, preserves other spaces and stores local terminal IDs", async () => {
  const core = new CoreClient();
  core.methods = ["terminal.run", "doc.get", "doc.set"];
  const existing = { id: "existing", tabs: [], extra: "preserved" };
  let reads = 0, writes = 0;
  const call = vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "doc.get") return { version: ++reads, value: { extra: true, spaces: reads === 1 ? [] : [existing] } } as never;
    if (method === "terminal.run") return { address: "remote/t1" } as never;
    if (++writes === 1) throw Object.assign(new Error("conflict"), { data: { kind: "conflict" } });
    return { version: 3 } as never;
  });
  const created = await createSpace(core, "remote", "/project");
  const params = call.mock.calls.filter(([m]) => m === "doc.set").at(-1)![1] as any;
  expect(params).toMatchObject({ on: "remote", version: 2, value: { extra: true } });
  expect(params.value.spaces[0]).toEqual(existing);
  const space = params.value.spaces[1];
  expect(space.tabs[0].root.content.terminal).toBe("t1");
  expect(created.space).toBe(`core:remote:${space.id}`);
  expect(call.mock.calls.filter(([m]) => m === "terminal.run")).toHaveLength(1);
  expect(call).toHaveBeenCalledWith("terminal.run", expect.objectContaining({
    keep: true, labels: { "herdr.space": space.id, "herdr.tab": space.tabs[0].id, "herdr.seen": "0" },
  }));
});

it("does not spawn a terminal when the existing shared layout cannot be decoded", async () => {
  const core = new CoreClient();
  core.methods = ["terminal.run", "doc.get", "doc.set"];
  const call = vi.spyOn(core, "call").mockResolvedValue({ version: 1, value: { spaces: "invalid" } });
  await expect(createSpace(core, "")).rejects.toThrow("无法解码");
  expect(call).toHaveBeenCalledTimes(1);
});

it("reports a failed save without deleting the running terminal", async () => {
  const core = new CoreClient();
  core.methods = ["terminal.run", "doc.get", "doc.set"];
  const call = vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "doc.get") return { version: 0, value: null } as never;
    if (method === "terminal.run") return { address: "t1" } as never;
    throw new Error("disconnected");
  });
  await expect(createSpace(core, "")).rejects.toThrow("终端 t1 已创建，但共享空间保存失败");
  expect(call.mock.calls.map(([m]) => m)).toEqual(["doc.get", "terminal.run", "doc.set"]);
});

it("closes the shared space and its remote terminals while preserving other spaces", async () => {
  const core = new CoreClient();
  const spaces = [
    { id: "target", tabs: [{ root: { id: "pane", type: "block", content: { terminal: "t1" } } }] },
    { id: "other", tabs: [] },
  ];
  const call = vi.spyOn(core, "call").mockImplementation(async (method) =>
    (method === "doc.get" ? { version: 4, value: { spaces, extra: true } } : {}) as never,
  );
  await closeSpace(core, "remote", "target");
  expect(call).toHaveBeenCalledWith("terminal.kill", { terminal: "remote/t1" });
  expect(call).toHaveBeenLastCalledWith("doc.set", {
    name: "herdr-app", on: "remote", version: 4, value: { spaces: [spaces[1]], extra: true },
  });
});

it("prunes exited panes, then empty tabs and spaces, preserving live and mod panes", async () => {
  const core = new CoreClient();
  core.methods = ["doc.set", "terminal.get"];
  const block = (terminal: string) => ({ id: terminal, type: "block", content: { terminal } });
  const mod = { id: "mod", type: "block", content: { mod: "files" } };
  const spaces = [
    { id: "empty", tabs: [{ root: block("dead") }] },
    { id: "split", tabs: [{ root: { id: "stack", type: "stack", active: "dead", children: [block("dead"), block("live"), mod] } }] },
    { id: "offline", tabs: [{ root: block("unreachable") }] },
  ];
  const call = vi.spyOn(core, "call").mockImplementation(async (method, params: any) => {
    if (method === "doc.get") return { version: 1, value: { spaces } } as never;
    if (method === "terminal.get") {
      if (params.terminal === "remote/unreachable") throw new Error("machine offline");
      return { reason: "exited" } as never;
    }
    return {} as never;
  });
  await reconcileSpaces(core, "remote", new Set(["remote/live"]));
  const write = call.mock.calls.find(([m]) => m === "doc.set")![1] as any;
  expect(write.value.spaces.map((s: any) => s.id)).toEqual(["split", "offline"]);
  expect(write.value.spaces[0].tabs[0].root.children).toEqual([block("live"), mod]);
  expect(write.value.spaces[0].tabs[0].root.active).toBe("live");
  expect(call).not.toHaveBeenCalledWith("terminal.get", { terminal: "remote/live" });
  expect(call.mock.calls.some(([m]) => m === "terminal.kill")).toBe(false);
});

it("keeps lost terminals and skips writes after a connection becomes stale", async () => {
  const core = new CoreClient();
  core.methods = ["doc.set", "terminal.get"];
  let valid = true;
  const call = vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "doc.get") return { version: 1, value: { spaces: [{ id: "s", tabs: [{ root: { type: "block", content: { terminal: "t1" } } }] }] } } as never;
    return { reason: "lost" } as never;
  });
  await reconcileSpaces(core, "", new Set());
  expect(call.mock.calls.some(([m]) => m === "doc.set")).toBe(false);
  call.mockImplementation(async () => {
    valid = false;
    return { version: 1, value: null } as never;
  });
  await reconcileSpaces(core, "", new Set(), () => valid);
  expect(call.mock.calls.some(([m]) => m === "doc.set")).toBe(false);
});

it("reconciles again on CAS conflict without overwriting a concurrently added space", async () => {
  const core = new CoreClient();
  core.methods = ["doc.set", "terminal.get"];
  let reads = 0, writes = 0;
  const added = { id: "added", tabs: [] };
  const old = { id: "old", tabs: [{ root: { type: "block", content: { terminal: "gone" } } }] };
  const call = vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "doc.get") return { version: ++reads, value: { spaces: reads === 1 ? [old] : [old, added] } } as never;
    if (method === "terminal.get") throw Object.assign(new Error("not found"), { data: { kind: "not_found" } });
    if (++writes === 1) throw Object.assign(new Error("conflict"), { data: { kind: "conflict" } });
    return {} as never;
  });
  await reconcileSpaces(core, "", new Set());
  expect(call).toHaveBeenLastCalledWith("doc.set", expect.objectContaining({ version: 2, value: { spaces: [added] } }));
});
