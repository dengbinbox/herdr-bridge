import { it, expect, vi } from "vitest";
import { CoreClient } from "../core";
import {
  parseDirectory,
  decode64,
  listDirectory,
  exec,
  readFile,
  limited,
} from "./file-service";
import {
  parseStatus,
  applyNumstat,
  diffLines,
  gitStatus,
  gitDiff,
  isLinkedWorktree,
} from "./git-service";
const ctx = { machine: "remote", cwd: "/project" };
function client(handler: (method: string, params: any) => unknown) {
  const c = new CoreClient();
  c.methods = ["machine.exec", "file.read"];
  vi.spyOn(c, "call").mockImplementation(
    async (m, p) => handler(m, p) as never,
  );
  return c;
}
const result = (stdout: string, code = 0, stderr = "") => ({
  code,
  stdout: btoa(unescape(encodeURIComponent(stdout))),
  stderr: btoa(stderr),
  timed_out: false,
  truncated: false,
});
it("decodes base64 UTF8 and NUL entries including whitespace and literal limit filenames", () => {
  expect(decode64("5Lit5paH")).toBe("中文");
  const names = ["a b", "中\n文", 'quote\"', "tab\t", "__LIMIT__"];
  const entries = parseDirectory(
    "d\0folder\0" + names.map((n) => `f\0${n}\0`).join("") + "d\0.git\0",
  );
  expect(entries[0].directory).toBe(true);
  expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(names));
  expect(entries).toHaveLength(6);
});
it("passes untrusted paths as argv data and targets the selected machine", async () => {
  const c = client(() => result("f\0hello\0"));
  const path = '/project/$(touch hacked)\n\"';
  await listDirectory(c, ctx, path);
  expect(c.call).toHaveBeenCalledWith(
    "machine.exec",
    expect.objectContaining({
      on: "remote",
      timeout: 10,
      argv: expect.arrayContaining([path]),
    }),
  );
  const params = vi.mocked(c.call).mock.calls[0][1] as { argv: string[] };
  expect(params.argv[2]).not.toContain(path);
});
it("reports truncated and failed exec instead of presenting partial content", async () => {
  const c = client(() => ({ ...result(""), truncated: true }));
  await expect(exec(c, ctx, ["git", "status"])).rejects.toThrow("截断");
});
it("treats file.read as text and rejects NUL binaries", async () => {
  const c = client(() => ({ text: "中文", first: 1, last: 1, lines: 1 }));
  expect(await readFile(c, ctx, "a")).toEqual({
    text: "中文",
    truncated: false,
  });
  expect(c.call).toHaveBeenCalledWith(
    "file.read",
    expect.objectContaining({ on: "remote", path: "a", limit: 1500 }),
  );
  const binary = client(() => ({ text: "a\0b" }));
  await expect(readFile(binary, ctx, "b")).rejects.toThrow("二进制");
});
it("caps background RPC concurrency at four", async () => {
  const c = new CoreClient();
  let active = 0,
    max = 0;
  const resolvers: (() => void)[] = [];
  const jobs = Array.from({ length: 7 }, () =>
    limited(c, async () => {
      active++;
      max = Math.max(max, active);
      await new Promise<void>((r) => resolvers.push(r));
      active--;
      return 1;
    }),
  );
  expect(resolvers).toHaveLength(4);
  while (resolvers.length) {
    resolvers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  }
  await Promise.all(jobs);
  expect(max).toBe(4);
});
it("parses NUL Git status and rename source entries without splitting unusual paths", () => {
  const c = parseStatus(
    " M a b\0R  new\nname\0old\tname\0?? 中文\0UU conflict\0",
  );
  expect(c.map((c) => c.path)).toEqual([
    "a b",
    "new\nname",
    "中文",
    "conflict",
  ]);
  applyNumstat(c, "3\t1\ta b\0-\t-\t中文\0");
  expect(c[0]).toMatchObject({ added: "3", removed: "1" });
  expect(c[2].added).toBe("-");
});
it("does not count diff metadata as added/deleted content", () => {
  const d = diffLines(
    "--- a/x\n+++ b/x\n@@ -7,2 +8,2 @@\n-old\n+new\n context\n\\ No newline at end of file",
  );
  expect(d.lines[0].kind).toBe("meta");
  expect(d.lines[3]).toMatchObject({ kind: "remove", old: 7 });
  expect(d.lines[4]).toMatchObject({ kind: "add", next: 8 });
  expect(d.lines[6].kind).toBe("meta");
  expect(diffLines("a\n".repeat(2000)).truncated).toBe(true);
});
it("distinguishes absent Git, non-repositories, and clean unborn repositories", async () => {
  const missing = client(() => result("", 127, "git: not found"));
  await expect(gitStatus(missing, ctx)).rejects.toThrow("not found");
  const absent = client(() => result("", 128, "fatal: not a git repository"));
  expect(await gitStatus(absent, ctx)).toBeNull();
  const empty = client((_m, p) =>
    p.argv.includes("--show-toplevel")
      ? result("/project\n")
      : p.argv.includes("--verify")
        ? result("", 128)
        : result(""),
  );
  expect(await gitStatus(empty, ctx)).toMatchObject({
    hasHead: false,
    changes: [],
  });
});
it("isolates diff paths and disables external diff and textconv", async () => {
  const c = client(() => result(""));
  await gitDiff(
    c,
    ctx,
    { path: "--danger\nfile", status: " M", added: "", removed: "" },
    true,
  );
  const p = vi.mocked(c.call).mock.calls[0][1] as { argv: string[] };
  expect(p.argv).toEqual(
    expect.arrayContaining(["--no-ext-diff", "--no-textconv", "--no-color"]),
  );
  expect(p.argv.slice(-2)).toEqual(["--", "--danger\nfile"]);
});

it("keeps content beginning with plus/minus signs inside a hunk as content", () => {
  const parsed = diffLines("@@ -1 +1 @@\n--- old content\n+++ new content");
  expect(parsed.lines[1]).toMatchObject({ kind: "remove", old: 1 });
  expect(parsed.lines[2]).toMatchObject({ kind: "add", next: 1 });
});

it("distinguishes main checkouts from linked worktrees, including Windows paths", () => {
  expect(isLinkedWorktree({ folder: "/repo", common: "/repo/.git" })).toBe(false);
  expect(isLinkedWorktree({ folder: "/feature", common: "/repo/.git" })).toBe(true);
  expect(isLinkedWorktree({ folder: "C:\\repo", common: "C:/repo/.git" })).toBe(false);
});
