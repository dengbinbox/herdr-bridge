import { describe, it, expect } from "vitest";
import {
  nativeLayout,
  panes,
  shown,
  focusTree,
  readView,
  recover,
  spaceName,
} from "./model";
import {
  agentState,
  agents,
  agentGroups,
  counter,
  updateAttention,
} from "./agent-state";
import { TerminalStore, type TerminalRecord } from "../core";
const t = (
  address: string,
  state?: string,
  extra: Partial<TerminalRecord> = {},
): TerminalRecord => ({
  address,
  state: "live",
  cols: 80,
  rows: 24,
  status: state ? { state } : null,
  ...extra,
});
const block = (id: string, address: string) => ({
  id,
  type: "block",
  content: { terminal: address },
});
const document = {
  spaces: [
    {
      id: "s1",
      name: "One",
      folder: "/same",
      tabs: [
        {
          id: "tab1",
          name: "",
          root: {
            id: "root",
            type: "column",
            children: [
              block("p1", "t1"),
              {
                id: "stack",
                type: "stack",
                active: "p2",
                children: [block("p2", "t2"), block("p3", "t3")],
              },
            ],
          },
        },
      ],
    },
    { id: "s2", name: "Two", folder: "/same", tabs: [] },
  ],
};
describe("native spaces and private layout", () => {
  it("qualifies machine IDs once, keeps named spaces distinct and preserves splits/stacks", () => {
    const a = nativeLayout(document, "box").spaces;
    expect(a).toHaveLength(2);
    expect(a[0].id).not.toBe(nativeLayout(document, "").spaces[0].id);
    expect(panes(a[0].tabs[0].root).map((p) => p.terminal)).toEqual([
      "box/t1",
      "box/t2",
      "box/t3",
    ]);
    expect(shown(a[0].tabs[0].root).map((p) => p.terminal)).toEqual([
      "box/t1",
      "box/t2",
    ]);
    expect(
      shown(focusTree(a[0].tabs[0].root, "core:box:p3")).map((p) => p.terminal),
    ).toEqual(["box/t1", "box/t3"]);
    expect(spaceName(a[1], [])).toBe("Two");
  });
  it("supports null documents and rejects corrupt ones without silently treating them as empty", () => {
    expect(nativeLayout(null, "").spaces).toEqual([]);
    expect(() => nativeLayout({ spaces: "bad" }, "")).toThrow();
  });
  it("migrates legacy addresses, observation, split sizes and focus", () => {
    const v = readView({
      tabs: [
        { id: "box/t1", observe: true },
        { id: "t2", observe: false },
      ],
      split: true,
      active: "t2",
      sizes: [30, 70],
    })!;
    expect(v.schemaVersion).toBe(2);
    expect(panes(v.spaces[0].tabs[0].root)[0]).toMatchObject({
      terminal: "box/t1",
      observe: true,
    });
    expect(v.focus.legacy).toBe("pane:t2");
    expect(v.sizes["pane:t2"]).toBe(70);
    expect(readView(v)).toEqual(v);
  });
  it("rejects native spaces in persisted web documents", () => {
    const v = readView(null)!;
    expect(
      readView({ ...v, spaces: nativeLayout(document, "").spaces }),
    ).toBeNull();
  });
  it("recovers unowned roots and orphans without turning child-only agents into panes", () => {
    const records = [
      t("t1"),
      t("t4"),
      t("sub", "working", { parent: "t1" }),
      t("orphan", "idle", { parent: "gone" }),
    ];
    expect(
      recover(records, nativeLayout(document, "").spaces)[0]
        .tabs.flatMap((t) => panes(t.root))
        .map((p) => p.terminal),
    ).toEqual(["t4", "orphan"]);
  });
});
describe("agent attention and groups", () => {
  it("rejects unsafe, negative and partial turn numbers", () => {
    expect(counter("18446744073709551615")).toBe(18446744073709551615n);
    for (const v of [
      -1,
      NaN,
      9007199254740992,
      "12x",
      "-2",
      "18446744073709551616",
    ])
      expect(counter(v)).toBeNull();
  });
  it("never classifies an ordinary shell as working", () => {
    expect(agentState(t("shell"))).toBeNull();
    expect(agentState(t("t", "error"))).toBe("blocked");
  });
  it("distinguishes missing seen from zero and supports large exact counters", () => {
    expect(agentState(t("t", "done", { turn: 7 }))).toBe("idle");
    expect(
      agentState(t("t", "done", { turn: 7, labels: { "herdr.seen": "0" } })),
    ).toBe("done");
    expect(
      agentState(
        t("t", "done", {
          turn: "9007199254740993",
          labels: { "herdr.seen": "9007199254740992" },
        }),
      ),
    ).toBe("done");
  });
  it("initially sees idle, notices unwatched busy completion, and does not reorder on read", () => {
    let records = [t("t", "idle")];
    let a = updateAttention(new Map(), records, new Set());
    expect(agentState(records[0], a.get("t"))).toBe("idle");
    a = updateAttention(a, [t("t", "working")], new Set());
    records = [t("t", "done")];
    a = updateAttention(a, records, new Set());
    expect(agentState(records[0], a.get("t"))).toBe("done");
    const seq = a.get("t")!.seq;
    a = updateAttention(a, records, new Set(["t"]));
    expect(agentState(records[0], a.get("t"))).toBe("idle");
    expect(a.get("t")!.seq).toBe(seq);
  });
  it("holds Done until focus leaves but moves immediately for working/blocked", () => {
    expect(agentState(t("t", "idle"), undefined, true)).toBe("done");
    expect(agentState(t("t", "working"), undefined, true)).toBe("working");
    expect(agentState(t("t", "error"), undefined, true)).toBe("blocked");
    expect(agentState(t("sub", "done"), undefined, false, true)).toBe("idle");
  });
  it("promotes a parent for blocked children and keeps pinned rows unique", () => {
    const spaces = nativeLayout(document, "").spaces;
    const records = [
      t("t1", "idle"),
      t("t2", "working", { labels: { "herdr.pinned": "1" } }),
      t("t3", "done", { turn: 2, labels: { "herdr.seen": "1" } }),
      t("child", "error", { parent: "t1" }),
    ];
    const rows = agents(records, spaces, new Map(), "");
    expect(rows[0].effective).toBe("blocked");
    expect(rows[0].children).toHaveLength(1);
    expect(agentGroups(rows, false).map(([g]) => g)).toEqual([
      "Pinned",
      "Needs you",
      "Done",
    ]);
    expect(agentGroups(rows, true)[0][0]).toBe("Pinned");
    expect(agentGroups(rows, false).flatMap(([, r]) => r)).toHaveLength(3);
  });
  it("keeps terminal lifecycle state when turn events carry the agent word", () => {
    const store = new TerminalStore();
    store.reset({ seq: 1, terminals: [t("t", "done")] });
    store.apply({
      method: "event",
      params: {
        seq: 2,
        type: "turn",
        terminal: "t",
        data: { turn: 4, state: "done" },
      },
    });
    expect(store.list()[0]).toMatchObject({ state: "live", turn: 4 });
  });
});


describe("space names from Core paths", () => {
  const space = { ...nativeLayout(document, "box").spaces[0], name: "" };
  const records = [t("box/t1", undefined, { cwd: "/old", foreground: { cwd: "/projects/herdr/src" } }), t("box/t2", undefined, { cwd: "/other" })];
  it("prefers the checkout root and keeps explicit names", () => {
    expect(spaceName(space, records, "/projects/herdr")).toBe("herdr");
    expect(spaceName({ ...space, name: "Custom" }, records, "/projects/herdr")).toBe("Custom");
    expect(spaceName(space, records, "/worktrees/feature")).toBe("feature");
  });
  it("falls back to the first terminal foreground path, record path, then space folder", () => {
    expect(spaceName(space, records)).toBe("src");
    expect(spaceName(space, [t("box/t1", undefined, { cwd: "/projects/docs" })])).toBe("docs");
    expect(spaceName(space, [])).toBe("same");
    expect(spaceName({ ...space, folder: "" }, [])).toBe("~");
  });
  it("handles Windows paths and Unicode names", () => {
    expect(spaceName(space, records, "C:\\projects\\项目\\")).toBe("项目");
  });
});
