// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspace } from "./useWorkspace";
const mock = vi.hoisted(() => ({
  client: null as any,
  log: [] as string[],
  reads: [] as ((r: unknown) => void)[],
}));
vi.mock("../api", () => ({
  api: async () => ({}),
  APIError: class extends Error {
    status = 0;
  },
}));
vi.mock("../core", async () => {
  const original = await vi.importActual("../core");
  return {
    ...original,
    CoreClient: class {
      methods = ["doc.get", "machine.list"];
      onEvent: any;
      onDisconnect: any;
      constructor() {
        mock.client = this;
      }
      async connect() {}
      dispose() {}
      async subscribe(callback: any) {
        mock.log.push("snapshot");
        callback({ seq: 1, terminals: [] });
      }
      async call(method: string) {
        mock.log.push(method);
        if (method === "machine.list") return { machines: [] };
        return new Promise((r) => mock.reads.push(r));
      }
    },
  };
});
afterEach(() => {
  cleanup();
  mock.log = [];
  mock.reads = [];
});
const doc = (name: string) => ({
  value: { spaces: [{ id: "s1", name, folder: "/work", tabs: [] }] },
  version: 1,
});
it("subscribes before documents and discards a stale response when a doc event races the read", async () => {
  const refresh = vi.fn(),
    receive = vi.fn();
  const { result } = renderHook(() => useWorkspace("bridge", refresh, receive));
  await waitFor(() => expect(mock.reads).toHaveLength(1));
  expect(mock.log.indexOf("snapshot")).toBeLessThan(
    mock.log.indexOf("doc.get"),
  );
  act(() =>
    mock.client.onEvent({
      method: "event",
      params: { seq: 2, type: "doc", data: { name: "herdr-app" } },
    }),
  );
  await act(async () => mock.reads[0](doc("stale")));
  await waitFor(() => expect(mock.reads).toHaveLength(2));
  expect(result.current.native).toHaveLength(0);
  await act(async () => mock.reads[1](doc("latest")));
  await waitFor(() => expect(result.current.native[0].name).toBe("latest"));
  act(() =>
    mock.client.onEvent({
      method: "missed",
      params: { seq: 3, terminals: [] },
    }),
  );
  await waitFor(() => expect(mock.reads).toHaveLength(3));
  await act(async () => mock.reads[2]({ value: { broken: true }, version: 2 }));
  expect(result.current.native[0].name).toBe("latest");
  expect(result.current.warning).toContain("解码");
});
it("drops document results after leaving a bridge", async () => {
  const refresh = vi.fn(),
    receive = vi.fn();
  const { result, unmount } = renderHook(() =>
    useWorkspace("bridge", refresh, receive),
  );
  await waitFor(() => expect(mock.reads).toHaveLength(1));
  unmount();
  await act(async () => mock.reads[0](doc("old bridge")));
  expect(result.current.native).toHaveLength(0);
});
