import type { TerminalRecord } from "../core";
import { obj, str, panes, spaceName, type Space } from "./model";
export type State = "blocked" | "done" | "working" | "idle";
export const priority: Record<State, number> = {
  blocked: 4,
  done: 3,
  working: 2,
  idle: 1,
};
export const stateLabel: Record<State, string> = {
  blocked: "Needs you",
  done: "Done",
  working: "Working",
  idle: "Idle",
};
export function counter(v: unknown): bigint | null {
  if (typeof v === "number")
    return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  return typeof v === "string" &&
    /^\d+$/.test(v) &&
    BigInt(v) <= 18446744073709551615n
    ? BigInt(v)
    : null;
}
export type Attention = {
  word: string;
  seen: boolean;
  seq: number;
  since: number;
};
export function updateAttention(
  previous: Map<string, Attention>,
  records: TerminalRecord[],
  looking: Set<string>,
): Map<string, Attention> {
  const next = new Map<string, Attention>();
  let seq = Math.max(0, ...Array.from(previous.values(), (x) => x.seq));
  for (const t of records) {
    const word = str(obj(t.status).state);
    const old = previous.get(t.address);
    if (!word) {
      if (old) next.set(t.address, { ...old, word: "" });
      continue;
    }
    const normalized =
      word === "error" ? "blocked" : word === "done" ? "idle" : word;
    const changed = old?.word !== normalized;
    const seen =
      looking.has(t.address) || ["working", "blocked"].includes(normalized)
        ? true
        : changed && old && ["working", "blocked"].includes(old.word)
          ? false
          : (old?.seen ?? true);
    next.set(t.address, {
      word: normalized,
      seen,
      seq: changed ? ++seq : old.seq,
      since: changed ? (old ? Date.now() : t.status_ms || 0) : old.since,
    });
  }
  return next;
}
export function agentState(
  t: TerminalRecord,
  a?: Attention,
  held = false,
  child = false,
): State | null {
  const word = str(obj(t.status).state);
  if (!word) return null;
  if (word === "blocked" || word === "error") return "blocked";
  if (word === "working") return "working";
  if (child) return "idle";
  const seen = counter(obj(t.labels)["herdr.seen"]),
    turn = counter(t.turn);
  return held ||
    (seen !== null && turn !== null ? turn > seen : a?.seen === false)
    ? "done"
    : "idle";
}
export type AgentRow = {
  record: TerminalRecord;
  state: State;
  effective: State;
  pinned: boolean;
  space: Space;
  tab: string;
  pane: string;
  title: string;
  detail: string;
  children: AgentRow[];
  seq: number;
  since: number;
};
export function agents(
  records: TerminalRecord[],
  spaces: Space[],
  attention: Map<string, Attention>,
  held: string,
): AgentRow[] {
  const index = new Map(records.map((t) => [t.address, t]));
  const owned = new Set(
    spaces.flatMap((s) =>
      s.tabs.flatMap((t) => panes(t.root).map((p) => p.terminal)),
    ),
  );
  let budget = 2000;
  function row(
    t: TerminalRecord,
    space: Space,
    tab: string,
    pane: string,
    path: Set<string>,
    depth: number,
    child = false,
  ): AgentRow | null {
    if (budget-- <= 0 || depth > 40 || path.has(t.address)) return null;
    const state = agentState(
      t,
      attention.get(t.address),
      held === t.address,
      child,
    );
    if (!state) return null;
    const next = new Set(path).add(t.address);
    const children = records
      .filter((c) => c.parent === t.address && !owned.has(c.address))
      .map((c) => row(c, space, tab, pane, next, depth + 1, true))
      .filter((c): c is AgentRow => !!c);
    const effective = children.reduce(
      (s, c) => (priority[c.effective] > priority[s] ? c.effective : s),
      state,
    );
    return {
      record: t,
      state,
      effective,
      pinned: !!str(obj(t.labels)["herdr.pinned"]),
      space,
      tab,
      pane,
      title:
        str(t.name) ||
        str(obj(t.status).title) ||
        str(t.title) ||
        str(obj(t.status).app) ||
        t.address,
      detail: `${spaceName(space, records)}${space.machine ? " · " + space.machine : ""}`,
      children,
      seq: attention.get(t.address)?.seq || 0,
      since: attention.get(t.address)?.since || 0,
    };
  }
  const result: AgentRow[] = [];
  const seen = new Set<string>();
  for (const space of spaces)
    for (const tab of space.tabs)
      for (const pane of panes(tab.root)) {
        const t = index.get(pane.terminal);
        if (!t || seen.has(t.address)) continue;
        seen.add(t.address);
        const r = row(t, space, tab.id, pane.id, new Set(), 0);
        if (r) result.push(r);
      }
  return result;
}
export function agentGroups(
  rows: AgentRow[],
  grouped: boolean,
): [string, AgentRow[]][] {
  const sorted = [...rows].sort(
    (a, b) =>
      priority[b.effective] - priority[a.effective] ||
      b.since - a.since ||
      b.seq - a.seq ||
      a.record.address.localeCompare(b.record.address),
  );
  const result: [string, AgentRow[]][] = [];
  const pinned = sorted.filter((r) => r.pinned);
  if (pinned.length) result.push(["Pinned", pinned]);
  if (grouped) {
    const groups = new Map<string, AgentRow[]>();
    for (const r of rows.filter((r) => !r.pinned)) {
      const key = r.space.id;
      groups.set(key, [...(groups.get(key) || []), r]);
    }
    for (const [key, rs] of groups) result.push([key, rs]);
  } else
    for (const state of ["blocked", "done", "working", "idle"] as const) {
      const rs = sorted.filter((r) => !r.pinned && r.effective === state);
      if (rs.length) result.push([stateLabel[state], rs]);
    }
  return result;
}
