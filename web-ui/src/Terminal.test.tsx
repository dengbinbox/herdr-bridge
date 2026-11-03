// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalPane } from "./Terminal";
import type { CoreClient, Frame } from "./core";
const mock = vi.hoisted(() => ({
  writes: [] as (() => void)[],
  input: null as ((s: string) => void) | null,
  resize: vi.fn(),
  options: {} as Record<string, unknown>,
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    parser = { registerCsiHandler: () => ({ dispose() {} }) };
    constructor(options: Record<string, unknown>) {
      mock.options = options;
    }
    loadAddon() {}
    open() {}
    dispose() {}
    attachCustomKeyEventHandler() {}
    onData(fn: (s: string) => void) {
      mock.input = fn;
      return { dispose() {} };
    }
    write(_bytes: Uint8Array, callback: () => void) {
      mock.writes.push(callback);
    }
    resize(cols: number, rows: number) {
      mock.resize(cols, rows);
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
afterEach(() => {
  cleanup();
  mock.writes = [];
  mock.input = null;
  mock.resize.mockClear();
  vi.unstubAllGlobals();
});
function fixture(observe: boolean) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  let output: (f: Frame) => void = () => {};
  const core = {
    attach: vi.fn((_id, _cols, _rows, _observe, fn) => {
      output = fn;
      return Promise.resolve({
        channel: 9,
        terminal: { cols: 80, rows: 24 },
        resize_notifications: true,
      });
    }),
    credit: vi.fn(),
    resize: vi.fn(),
    input: vi.fn(),
    detach: vi.fn(),
    focus: vi.fn(),
  };
  const view = render(
    <TerminalPane
      core={core as unknown as CoreClient}
      id="remote/t1"
      observe={observe}
      onDetach={() => {}}
      onKill={() => {}}
    />,
  );
  return { core, view, output: (f: Frame) => output(f) };
}
it("returns credit after xterm consumes output and preserves DATA / RESIZE ordering", async () => {
  const f = fixture(true);
  await act(async () => {});
  act(() =>
    f.output({
      channel: 9,
      kind: 0,
      payload: new TextEncoder().encode("hello"),
    }),
  );
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint16(0, 120, true);
  new DataView(size.buffer).setUint16(2, 40, true);
  act(() => f.output({ channel: 9, kind: 3, payload: size }));
  expect(f.core.credit).not.toHaveBeenCalled();
  expect(mock.resize).not.toHaveBeenCalled();
  act(() => mock.writes.shift()!());
  expect(f.core.credit).toHaveBeenCalledWith(9, 5);
  expect(mock.resize).toHaveBeenCalledWith(120, 40);
});
it("observe suppresses input and resize; unmount only detaches the viewing channel", async () => {
  const f = fixture(true);
  await act(async () => {});
  act(() => mock.input?.("do not type"));
  expect(mock.options.disableStdin).toBe(true);
  expect(f.core.input).not.toHaveBeenCalled();
  expect(f.core.resize).not.toHaveBeenCalled();
  f.view.unmount();
  expect(f.core.detach).toHaveBeenCalledExactlyOnceWith(9);
});
it("does not send stale CREDIT after a pane has been disposed", async () => {
  const f = fixture(false);
  await act(async () => {});
  act(() => f.output({ channel: 9, kind: 0, payload: new Uint8Array([1]) }));
  f.view.unmount();
  act(() => mock.writes.shift()!());
  expect(f.core.credit).not.toHaveBeenCalled();
});
