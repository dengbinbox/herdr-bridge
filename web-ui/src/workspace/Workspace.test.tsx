// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Workspace } from "./Workspace";
import { nativeLayout } from "./model";
import { CoreClient } from "../core";
const fixture = vi.hoisted(() => ({
  state: {} as any,
  api: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  git: vi.fn(),
}));
vi.mock("../api", () => ({ api: fixture.api }));
vi.mock("./useWorkspace", () => ({ useWorkspace: () => fixture.state }));
vi.mock("./file-service", () => ({
  listDirectory: fixture.list,
  readFile: fixture.read,
  joinPath: (p: string, n: string) => p + "/" + n,
}));
vi.mock("./git-service", async () => ({
  ...(await vi.importActual("./git-service")),
  repositoryInfo: async () => null,
  gitStatus: fixture.git,
}));
vi.mock("../Terminal", () => ({
  TerminalPane: ({ id, onDetach, observe }: any) => (
    <div data-testid={"terminal:" + id}>
      <button onClick={onDetach}>分离</button>
      <button>
        {id} {observe ? "只读" : "共享输入"}
      </button>
    </div>
  ),
}));
vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: any) => <div>{children}</div>,
  Panel: ({ children }: any) => <div>{children}</div>,
  Separator: () => <div />,
}));
const block = (id: string, terminal: string) => ({
  id,
  type: "block",
  content: { terminal },
});
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  fixture.api.mockResolvedValue({ version: 0, document: null });
  fixture.list.mockResolvedValue({
    entries: [{ name: "README.md", directory: false }],
    truncated: false,
  });
  fixture.read.mockResolvedValue({ text: "Hello file", truncated: false });
  fixture.git.mockResolvedValue({
    context: { machine: "", cwd: "/one" },
    hasHead: true,
    changes: [],
    truncated: false,
  });
  const core = new CoreClient();
  core.methods = ["terminal.label", "file.read"];
  vi.spyOn(core, "call").mockResolvedValue({});
  fixture.state = {
    core,
    state: "已连接",
    warning: "",
    epochs: {},
    refresh: vi.fn(),
    records: [
      {
        address: "t1",
        cwd: "/one",
        title: "First Agent",
        state: "live",
        cols: 80,
        rows: 24,
        status: { state: "working" },
        labels: {},
        turn: 1,
      },
      {
        address: "t2",
        cwd: "/two",
        title: "Second Agent",
        state: "live",
        cols: 80,
        rows: 24,
        status: { state: "error" },
        labels: {},
        turn: 1,
      },
      {
        address: "child",
        cwd: "/child",
        title: "Child Agent",
        parent: "t1",
        state: "live",
        cols: 80,
        rows: 24,
        status: { state: "working" },
        turn: 1,
      },
    ],
    native: nativeLayout(
      {
        spaces: [
          {
            id: "one",
            name: "Project One",
            folder: "/one",
            tabs: [
              {
                id: "tab",
                name: "Split",
                root: {
                  id: "root",
                  type: "row",
                  children: [block("p1", "t1"), block("p2", "t2")],
                },
              },
            ],
          },
          {
            id: "two",
            name: "Project Two",
            folder: "/same",
            tabs: [{ id: "tab2", name: "Other", root: block("p3", "t2") }],
          },
        ],
      },
      "",
    ).spaces,
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function mount() {
  return render(
    <MemoryRouter initialEntries={["/bridges/test"]}>
      <Routes>
        <Route
          path="/bridges/:id"
          element={<Workspace refreshAuth={async () => {}} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}
it("navigates spaces and restores actual pane focus for inspector context", async () => {
  mount();
  await screen.findByRole("button", { name: /空间 Project One/ });
  await waitFor(() => expect(fixture.list).toHaveBeenCalled());
  expect(fixture.list.mock.calls.at(-1)?.[1].cwd).toBe("/one");
  fireEvent.pointerDown(screen.getByTestId("terminal:t2"));
  await waitFor(() =>
    expect(fixture.list.mock.calls.at(-1)?.[1].cwd).toBe("/two"),
  );
  fireEvent.click(screen.getByRole("button", { name: /空间 Project Two/ }));
  expect(screen.queryByTestId("terminal:t1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /空间 Project One/ }));
  expect(screen.getByTestId("terminal:t1")).toBeTruthy();
  await waitFor(() =>
    expect(fixture.list.mock.calls.at(-1)?.[1].cwd).toBe("/two"),
  );
});
it("pins with labels without navigation and peeks children using their own directory", async () => {
  mount();
  await screen.findByRole("button", { name: /First Agent/ });
  fireEvent.click(screen.getAllByRole("button", { name: "Pin" })[0]);
  expect(fixture.state.core.call).toHaveBeenCalledWith(
    "terminal.label",
    expect.objectContaining({ labels: { "herdr.pinned": "1" } }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Child Agent/ }));
  expect(screen.queryByTestId("terminal:t1")).toBeNull();
  expect(screen.getByTestId("terminal:child").textContent).toContain("只读");
  await waitFor(() =>
    expect(fixture.list.mock.calls.at(-1)?.[1].cwd).toBe("/child"),
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
  expect(screen.getByTestId("terminal:t1")).toBeTruthy();
});
it("preserves file selection across inspector tabs and saves only private structures", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /README.md/ }));
  await screen.findByText("Hello file");
  fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
  await screen.findByText("没有未提交修改");
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(screen.getByText("Hello file")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存布局" }));
  await waitFor(() =>
    expect(fixture.api).toHaveBeenCalledWith(
      "/layouts/test",
      "PUT",
      expect.objectContaining({
        version: 0,
        document: expect.objectContaining({ schemaVersion: 2, spaces: [] }),
      }),
    ),
  );
  expect(
    fixture.state.core.call.mock.calls.some((c: any[]) => c[0] === "doc.set"),
  ).toBe(false);
});
it("ignores a slow file preview after switching pane context", async () => {
  let resolve: (v: any) => void = () => {};
  fixture.read.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /README.md/ }));
  fireEvent.pointerDown(screen.getByTestId("terminal:t2"));
  await waitFor(() =>
    expect(fixture.list.mock.calls.at(-1)?.[1].cwd).toBe("/two"),
  );
  resolve({ text: "STALE FILE", truncated: false });
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByText("STALE FILE")).toBeNull();
});
