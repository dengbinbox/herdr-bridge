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
  repository: vi.fn(),
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
  repositoryInfo: fixture.repository,
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
  Object.defineProperty(window, "innerWidth", {
    value: 1280,
    writable: true,
    configurable: true,
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  fixture.repository.mockResolvedValue(null);
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
  fireEvent.click(screen.getByRole("button", { name: "工作台操作" }));
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

it("previews Markdown by default and lets the user switch back to source", async () => {
  fixture.read.mockResolvedValue({
    text: "# Project guide\n\n**Hello**",
    truncated: false,
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /README.md/ }));
  await screen.findByRole("heading", { name: "Project guide" });
  fireEvent.click(screen.getByRole("button", { name: "源码" }));
  expect(screen.queryByRole("heading", { name: "Project guide" })).toBeNull();
  expect(screen.getByText("# Project guide")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  expect(screen.getByRole("heading", { name: "Project guide" })).toBeTruthy();
});

it("mobile navigation overlays the terminal, returns after choosing an agent, and switches split panes", async () => {
  Object.defineProperty(window, "innerWidth", {
    value: 390,
    writable: true,
    configurable: true,
  });
  mount();
  await screen.findByTestId("terminal:t1");
  expect(screen.queryByTestId("terminal:t2")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Spaces" })).toBeNull();
  const terminal = screen.getByTestId("terminal:t1");
  fireEvent.click(screen.getByRole("button", { name: "选择 Spaces / Agents" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByTestId("terminal:t1")).toBe(terminal);
  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  fireEvent.click(screen.getByRole("button", { name: /Second Agent/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByTestId("terminal:t2")).toBeTruthy();
  expect(screen.queryByTestId("terminal:t1")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "切换分屏终端" }), {
    target: { value: "core::p1" },
  });
  expect(screen.getByTestId("terminal:t1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Files / Changes" }));
  await screen.findByRole("button", { name: /README.md/ });
  expect(screen.getByTestId("terminal:t1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "返回终端" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not mark the terminal seen while covered by the mobile panel", async () => {
  Object.defineProperty(window, "innerWidth", {
    value: 390,
    writable: true,
    configurable: true,
  });
  mount();
  await screen.findByTestId("terminal:t1");
  fireEvent.click(screen.getByRole("button", { name: "选择 Spaces / Agents" }));
  fixture.state.core.call.mockClear();
  fixture.state.records = fixture.state.records.map((r: any) =>
    r.address === "t1" ? { ...r, turn: 2 } : r,
  );
  fireEvent.click(screen.getByRole("button", { name: "Spaces" }));
  expect(fixture.state.core.call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "返回终端" }));
  await waitFor(() =>
    expect(fixture.state.core.call).toHaveBeenCalledWith("terminal.label", {
      terminal: "t1",
      labels: { "herdr.seen": "2" },
    }),
  );
});

it("creates sessions on the device whose plus button was clicked, even without spaces", async () => {
  fixture.state.machines = [
    { name: "remote", state: "connected" },
    { name: "offline", state: "disconnected" },
  ];
  fixture.state.core.methods.push("terminal.run", "doc.get", "doc.set");
  fixture.state.core.call.mockImplementation(async (method: string) =>
    method === "doc.get" ? { version: 0, value: null } : { address: "new-session" },
  );
  mount();
  await screen.findByRole("button", { name: "空间 Project One" });
  expect(screen.queryByRole("button", { name: "新增网页空间" })).toBeNull();
  expect(screen.getByRole("button", { name: "在 offline 新增会话" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "在 remote 新增会话" }));
  await waitFor(() => expect(fixture.state.core.call).toHaveBeenCalledWith(
    "terminal.run", expect.objectContaining({ on: "remote", cwd: undefined, no_parent: true }),
  ));
  await waitFor(() => expect(fixture.state.core.call).toHaveBeenCalledWith(
    "doc.set", expect.objectContaining({ on: "remote", name: "herdr-app", version: 0 }),
  ));
  fireEvent.click(screen.getByRole("button", { name: "在 当前机器 新增会话" }));
  await waitFor(() => expect(fixture.state.core.call).toHaveBeenCalledWith(
    "terminal.run", expect.objectContaining({ on: undefined, cwd: "/one" }),
  ));
});

it("offers Close on a space context menu and confirms before ending its terminals", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fixture.state.core.call.mockImplementation(async (method: string) =>
    method === "doc.get" ? { version: 1, value: { spaces: [{ id: "one", tabs: [{ root: { type: "block", content: { terminal: "t1" } } }] }] } } : {},
  );
  mount();
  const row = await screen.findByRole("button", { name: "空间 Project One" });
  fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Close · 关闭空间" }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(fixture.state.core.call).not.toHaveBeenCalledWith("terminal.kill", expect.anything());
  confirm.mockReturnValue(true);
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByRole("menuitem", { name: "Close · 关闭空间" }));
  await waitFor(() => expect(fixture.state.core.call).toHaveBeenCalledWith("terminal.kill", { terminal: "t1" }));
  await waitFor(() => expect(fixture.state.core.call).toHaveBeenCalledWith("doc.set", expect.objectContaining({ value: { spaces: [] } })));
});

it("uses the Core repository root for the space avatar and discards it after cd", async () => {
  fixture.state.core.methods.push("machine.exec");
  fixture.state.native[0].name = "";
  fixture.state.records[0].foreground = { cwd: "/projects/herdr/src" };
  fixture.repository.mockImplementation(async (_core, ctx) => ctx.cwd === "/projects/herdr/src"
    ? { folder: "/projects/herdr", common: "/projects/herdr/.git", branch: "main" }
    : null);
  const view = mount();
  const row = await screen.findByRole("button", { name: "空间 herdr" });
  expect(row.querySelector('[aria-hidden="true"]')?.textContent).toBe("H");
  expect(fixture.repository).toHaveBeenCalledWith(fixture.state.core, expect.objectContaining({ cwd: "/projects/herdr/src", machine: "" }));
  fixture.repository.mockImplementation(() => new Promise(() => {}));
  fixture.state.records = fixture.state.records.map((r: any) => r.address === "t1" ? { ...r, foreground: { cwd: "/notes" } } : r);
  view.rerender(
    <MemoryRouter initialEntries={["/bridges/test"]}>
      <Routes><Route path="/bridges/:id" element={<Workspace refreshAuth={async () => {}} />} /></Routes>
    </MemoryRouter>,
  );
  const moved = await screen.findByRole("button", { name: "空间 notes" });
  expect(moved.querySelector('[aria-hidden="true"]')?.textContent).toBe("N");
  expect(screen.queryByRole("button", { name: "空间 herdr" })).toBeNull();
});

it("keeps letter avatars for multiple spaces in the same main checkout", async () => {
  fixture.state.core.methods.push("machine.exec");
  fixture.repository.mockResolvedValue({ folder: "/repo", common: "/repo/.git", branch: "main" });
  mount();
  await waitFor(() => expect(fixture.repository).toHaveBeenCalledTimes(2));
  for (const name of ["Project One", "Project Two"]) {
    const row = screen.getByRole("button", { name: `空间 ${name}` });
    expect(row.querySelector('span[aria-hidden="true"]')?.textContent).toBe("P");
  }
});

it("shows a branch avatar only for a linked worktree with its main checkout listed", async () => {
  fixture.state.core.methods.push("machine.exec");
  fixture.repository.mockImplementation(async (_core, ctx) => ctx.cwd === "/one"
    ? { folder: "/feature", common: "/repo/.git", branch: "feature" }
    : null);
  mount();
  await waitFor(() => expect(fixture.repository).toHaveBeenCalledTimes(2));
  const row = screen.getByRole("button", { name: "空间 Project One" });
  expect(row.querySelector('span[aria-hidden="true"]')?.textContent).toBe("P");
  cleanup();
  fixture.repository.mockImplementation(async (_core, ctx) => ({
    folder: ctx.cwd === "/one" ? "/feature" : "/repo", common: "/repo/.git", branch: "main",
  }));
  mount();
  await waitFor(() => {
    const linked = screen.getByRole("button", { name: "空间 Project One" });
    expect(linked.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(linked.querySelector("svg")).not.toBeNull();
  });
  expect(screen.getByRole("button", { name: "空间 Project Two" }).querySelector('span[aria-hidden="true"]')?.textContent).toBe("P");
});
