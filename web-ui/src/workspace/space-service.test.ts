import { expect, it, vi } from "vitest";
import { CoreClient } from "../core";
import { createSpace } from "./space-service";

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
