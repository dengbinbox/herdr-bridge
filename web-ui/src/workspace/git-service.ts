import type { CoreClient } from "../core";
import { exec, readFile, type Context } from "./file-service";
export type Change = {
  path: string;
  status: string;
  added: string;
  removed: string;
};
const flags = [
  "git",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
];
const diffFlags = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-renames",
];
export function parseStatus(text: string): Change[] {
  const fields = text.split("\0"),
    out: Change[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    const status = f.slice(0, 2),
      path = f.slice(3);
    if (/[RC]/.test(status)) i++;
    out.push({ path, status, added: "", removed: "" });
  }
  return out;
}
export function applyNumstat(changes: Change[], text: string, sum = false) {
  for (const field of text.split("\0")) {
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]+)$/.exec(field);
    if (!match) continue;
    const c = changes.find((c) => c.path === match[3]);
    if (c) {
      c.added =
        sum && c.added && match[1] !== "-" && c.added !== "-"
          ? String(Number(c.added) + Number(match[1]))
          : match[1];
      c.removed =
        sum && c.removed && match[2] !== "-" && c.removed !== "-"
          ? String(Number(c.removed) + Number(match[2]))
          : match[2];
    }
  }
}
export async function gitStatus(core: CoreClient, ctx: Context) {
  const root = await exec(
    core,
    ctx,
    [...flags, "rev-parse", "--show-toplevel"],
    true,
  );
  if (root.code !== 0) {
    if (/not a git repository/i.test(root.stderr)) return null;
    throw new Error(root.stderr || "无法读取 Git 仓库");
  }
  const cwd = root.stdout.replace(/\r?\n$/, "");
  const context = { ...ctx, cwd };
  const head = await exec(
    core,
    context,
    [...flags, "rev-parse", "--verify", "HEAD"],
    true,
  );
  const hasHead = head.code === 0;
  const status = await exec(core, context, [
    ...flags,
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    "--untracked-files=all",
  ]);
  const all = parseStatus(status.stdout),
    changes = all.slice(0, 1000);
  if (hasHead) {
    const stat = await exec(core, context, [
      ...flags,
      "diff",
      "HEAD",
      "--numstat",
      "-z",
      ...diffFlags,
    ]);
    applyNumstat(changes, stat.stdout);
  } else {
    for (const stage of [["--cached"], []]) {
      const stat = await exec(core, context, [
        ...flags,
        "diff",
        ...stage,
        "--numstat",
        "-z",
        ...diffFlags,
      ]);
      applyNumstat(changes, stat.stdout, true);
    }
  }
  return { context, hasHead, changes, truncated: all.length > 1000 };
}
export async function gitDiff(
  core: CoreClient,
  ctx: Context,
  change: Change,
  head: boolean,
) {
  if (change.status === "??" || (!head && !change.status.includes("D"))) {
    const r = await readFile(core, ctx, change.path);
    return {
      text: r.text
        ? `@@ -0,0 +1,${r.text.split("\n").length - Number(r.text.endsWith("\n"))} @@\n` +
          r.text
            .replace(/\n$/, "")
            .split("\n")
            .map((l) => "+" + l)
            .join("\n")
        : "",
      truncated: r.truncated,
    };
  }
  const r = await exec(core, ctx, [
    ...flags,
    "diff",
    ...(head ? ["HEAD"] : []),
    ...diffFlags,
    "--",
    change.path,
  ]);
  return { text: r.stdout, truncated: false };
}
export type DiffLine = {
  text: string;
  kind: "meta" | "add" | "remove" | "context";
  old?: number;
  next?: number;
};
export function diffLines(text: string): {
  lines: DiffLine[];
  truncated: boolean;
} {
  let old = 1,
    next = 1,
    inHunk = false;
  const raw = text.split("\n");
  return {
    truncated: raw.length > 1500 || raw.some((l) => l.length > 4000),
    lines: raw.slice(0, 1500).map((line) => {
      const text = line.slice(0, 4000);
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (h) {
        inHunk = true;
        old = Number(h[1]);
        next = Number(h[2]);
        return { text, kind: "meta" };
      }
      if (line.startsWith("diff --git ")) inHunk = false;
      if (!inHunk || !["+", "-", " "].includes(line[0]))
        return { text, kind: "meta" };
      if (line[0] === "+") return { text, kind: "add", next: next++ };
      if (line[0] === "-") return { text, kind: "remove", old: old++ };
      return { text, kind: "context", old: old++, next: next++ };
    }),
  };
}
export async function repositoryInfo(core: CoreClient, ctx: Context) {
  const root = await exec(
    core,
    ctx,
    [...flags, "rev-parse", "--show-toplevel"],
    true,
  );
  if (root.code !== 0) return null;
  const folder = root.stdout.replace(/\r?\n$/, "");
  const commonResult = await exec(core, ctx, [
    ...flags,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const common = commonResult.stdout.replace(/\r?\n$/, "");
  const branch = await exec(core, ctx, [
    ...flags,
    "status",
    "--porcelain=v1",
    "--branch",
    "--untracked-files=no",
  ]);
  return {
    folder,
    common,
    branch: branch.stdout.split("\n")[0].replace(/^## /, ""),
  };
}
