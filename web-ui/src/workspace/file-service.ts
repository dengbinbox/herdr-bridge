import { CoreClient } from "../core";
export type Context = { cwd: string; machine: string };
type ExecResult = {
  code: number;
  timed_out: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
};
const pools = new WeakMap<
  CoreClient,
  { active: number; queue: (() => void)[] }
>();
export async function limited<T>(
  core: CoreClient,
  work: () => Promise<T>,
): Promise<T> {
  let p = pools.get(core);
  if (!p) {
    p = { active: 0, queue: [] };
    pools.set(core, p);
  }
  if (p.queue.length >= 32) throw new Error("读取请求过多，请稍后刷新");
  if (p.active >= 4)
    await new Promise<void>((resolve) => p!.queue.push(resolve));
  else p.active++;
  try {
    return await work();
  } finally {
    const next = p.queue.shift();
    if (next) next();
    else p.active--;
  }
}
export function decode64(s: string) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  );
}
export async function exec(
  core: CoreClient,
  ctx: Context,
  argv: string[],
  allowFailure = false,
) {
  if (!core.methods.includes("machine.exec"))
    throw new Error("此 Core 不支持目录和 Git 读取");
  return limited(core, async () => {
    const r = await core.call<ExecResult>("machine.exec", {
      argv,
      cwd: ctx.cwd,
      on: ctx.machine || undefined,
      timeout: 10,
    });
    if (r.timed_out) throw new Error("机器读取超时");
    if (r.truncated) throw new Error("机器输出超出限制，结果已截断");
    const out = {
      ...r,
      stdout: decode64(r.stdout),
      stderr: decode64(r.stderr),
    };
    if (r.code !== 0 && !allowFailure)
      throw new Error(out.stderr || `命令退出：${r.code}`);
    return out;
  });
}
export type Entry = { name: string; directory: boolean };
export function parseDirectory(text: string): Entry[] {
  const parts = text.split("\0");
  const entries: Entry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === "x" || !parts[i + 1] || parts[i + 1] === ".git") continue;
    entries.push({ name: parts[i + 1], directory: parts[i] === "d" });
  }
  return entries.sort(
    (a, b) =>
      Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
  );
}
const unix =
  'cd -- "$1" || exit; n=0; for p in .[!.]* ..?* *; do [ -e "$p" ] || [ -L "$p" ] || continue; [ "$p" = .git ] && continue; n=$((n+1)); [ "$n" -gt 500 ] && { printf "x\\000__LIMIT__\\000"; break; }; if [ -d "$p" ] && [ ! -L "$p" ]; then printf "d\\000%s\\000" "$p"; else printf "f\\000%s\\000" "$p"; fi; done';
const windows =
  "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $items=@(Get-ChildItem -Force -LiteralPath $env:HERDR_READ_PATH | Where-Object {$_.Name -ne '.git'} | Select-Object -First 501 | ForEach-Object {@{name=$_.Name;directory=($_.PSIsContainer -and -not $_.LinkType)}}); ConvertTo-Json -Compress -InputObject $items";
export async function listDirectory(
  core: CoreClient,
  ctx: Context,
  path: string,
): Promise<{ entries: Entry[]; truncated: boolean }> {
  // Probe the target's interpreter, never the browser OS. Paths are argv/env data, never source.
  let entries: Entry[],
    limitedOutput = false;
  try {
    const r = await exec(core, ctx, ["sh", "-c", unix, "herdr-files", path]);
    entries = parseDirectory(r.stdout);
    limitedOutput = r.stdout.endsWith("x\0__LIMIT__\0");
  } catch (unixError) {
    try {
      const r = await limited(core, () =>
        core.call<ExecResult>("machine.exec", {
          argv: [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            windows,
          ],
          env: { HERDR_READ_PATH: path },
          cwd: ctx.cwd,
          on: ctx.machine || undefined,
          timeout: 10,
        }),
      );
      if (r.code !== 0 || r.timed_out || r.truncated)
        throw new Error(decode64(r.stderr) || "PowerShell 读取失败");
      entries = JSON.parse(decode64(r.stdout)) as Entry[];
    } catch {
      throw new Error(
        `目录不可用（需要目标机器的 sh 或 PowerShell）：${String(unixError)}`,
      );
    }
  }
  const truncated = entries.length > 500 || limitedOutput;
  return {
    entries: entries
      .slice(0, 500)
      .sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name),
      ),
    truncated,
  };
}
export function joinPath(parent: string, name: string) {
  return (
    parent.replace(/[\\/]$/, "") + (parent.includes("\\") ? "\\" : "/") + name
  );
}
export async function readFile(core: CoreClient, ctx: Context, path: string) {
  if (!core.methods.includes("file.read"))
    throw new Error("此 Core 不支持文件预览");
  const r = await limited(core, () =>
    core.call<{ text: string; first: number; last: number; lines: number }>(
      "file.read",
      {
        path,
        cwd: ctx.cwd,
        on: ctx.machine || undefined,
        offset: 1,
        limit: 1500,
      },
    ),
  );
  if (r.text.includes("\0")) throw new Error("二进制文件不支持文本预览");
  return {
    text: r.text.slice(0, 400000),
    truncated:
      r.text.length > 400000 ||
      r.last < r.lines ||
      r.text.split("\n").some((l) => l.length > 4000),
  };
}
