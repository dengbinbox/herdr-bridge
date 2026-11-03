import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
const bridge = "00112233-4455-6677-8899-aabbccddeeff";
const session = {
  id: bridge,
  username: "tester",
  role: "user",
  must_change_password: false,
  csrf_token: "csrf",
};
const record = {
  address: "remote/t1",
  title: "测试 Shell",
  state: "live",
  cols: 80,
  rows: 24,
};
function frame(channel: number, kind: number, payload: Buffer) {
  const b = Buffer.alloc(9 + payload.length);
  b.writeUInt32LE(channel, 0);
  b[4] = kind;
  b.writeUInt32LE(payload.length, 5);
  payload.copy(b, 9);
  return b;
}
async function fixture(page: Page, rich = false) {
  const records = rich
    ? [
        {
          ...record,
          address: "t1",
          title: "Implementation",
          cwd: "/project",
          status: { state: "working", app: "codex" },
          turn: 1,
          labels: {},
        },
        {
          ...record,
          address: "t2",
          title: "Review",
          cwd: "/review",
          status: { state: "error", app: "claude-code" },
          turn: 2,
          labels: { "herdr.pinned": "1" },
        },
      ]
    : [record];
  let seq = 1;
  const document = {
    spaces: [
      {
        id: "s1",
        name: "Project Alpha",
        folder: "/project",
        tabs: [
          {
            id: "tab1",
            name: "Build",
            root: {
              id: "root",
              type: "row",
              children: [
                { id: "p1", type: "block", content: { terminal: "t1" } },
                { id: "p2", type: "block", content: { terminal: "t2" } },
              ],
            },
          },
        ],
      },
      {
        id: "s2",
        name: "Project Beta",
        folder: "/review",
        tabs: [
          {
            id: "tab2",
            name: "Review",
            root: { id: "p3", type: "block", content: { terminal: "t2" } },
          },
        ],
      },
    ],
  };
  const output = (text: string, code = 0) => ({
    code,
    stdout: Buffer.from(text).toString("base64"),
    stderr: "",
    timed_out: false,
    truncated: false,
  });
  let loggedIn = false,
    nextChannel = 10;
  const calls: { method: string; params: Record<string, unknown> }[] = [],
    inputs: Buffer[] = [],
    credits: number[] = [],
    resizes: number[] = [];
  await page.route("http://bridge.test/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/v1/auth/me")
      return loggedIn ? json(session) : json({ error: "unauthorized" }, 401);
    if (path === "/api/v1/auth/login") {
      loggedIn = true;
      return json(session);
    }
    if (path === "/api/v1/auth/logout") {
      loggedIn = false;
      return json({ ok: true });
    }
    if (path === "/api/v1/bridges")
      return json([
        {
          id: bridge,
          name: "隔离测试机器",
          online: true,
          core_available: true,
          os: "linux",
        },
      ]);
    if (path === `/api/v1/layouts/${bridge}`)
      return json({ version: 0, document: null });
    if (path.startsWith("/ui/")) {
      const relative = path.slice(4),
        file = resolve(
          "dist",
          relative.includes(".") ? relative : "index.html",
        );
      const type =
        { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[
          extname(file)
        ] || "application/octet-stream";
      return route.fulfill({ contentType: type, body: await readFile(file) });
    }
    return json({ error: "not_found" }, 404);
  });
  await page.routeWebSocket(`**/ws/v1/bridges/${bridge}`, (ws) => {
    let framed = false,
      bytes = Buffer.alloc(0);
    ws.onMessage((message) => {
      bytes = Buffer.concat([
        bytes,
        Buffer.isBuffer(message) ? message : Buffer.from(message),
      ]);
      if (!framed) {
        const nl = bytes.indexOf(10);
        if (nl < 0) return;
        const hello = JSON.parse(bytes.subarray(0, nl).toString());
        bytes = bytes.subarray(nl + 1);
        framed = true;
        ws.send(
          Buffer.from(
            JSON.stringify({
              jsonrpc: "2.0",
              id: hello.id,
              result: {
                framed: true,
                generation: 1,
                core: { name: "Development" },
                methods: rich
                  ? [
                      "doc.get",
                      "machine.list",
                      "machine.exec",
                      "file.read",
                      "terminal.label",
                    ]
                  : [],
              },
            }) + "\n",
          ),
        );
      }
      while (bytes.length >= 9) {
        const channel = bytes.readUInt32LE(0),
          kind = bytes[4],
          size = bytes.readUInt32LE(5);
        if (bytes.length < 9 + size) return;
        const payload = bytes.subarray(9, 9 + size);
        bytes = bytes.subarray(9 + size);
        if (channel === 0) {
          const rpc = JSON.parse(payload.toString());
          calls.push(rpc);
          let result: unknown = {};
          if (rpc.method === "events.subscribe")
            result = { channel: 2, seq: 1, terminals: records };
          if (rpc.method === "terminal.list") result = { terminals: records };
          if (rpc.method === "terminal.attach")
            result = {
              channel: nextChannel,
              terminal:
                records.find((t) => t.address === rpc.params.terminal) ||
                record,
              resize_notifications: !!rpc.params.observe,
            };
          if (rich) {
            if (rpc.method === "doc.get")
              result = { value: document, version: 1 };
            if (rpc.method === "machine.list") result = { machines: [] };
            if (rpc.method === "file.read")
              result = {
                text: "# Workspace preview\n\nsecond line",
                first: 1,
                last: 2,
                lines: 2,
              };
            if (rpc.method === "machine.exec") {
              const argv = rpc.params.argv as string[];
              if (argv[0] === "sh") result = output("d\0src\0f\0README.md\0");
              else if (argv.includes("--show-toplevel"))
                result = output(rpc.params.cwd + "\n");
              else if (argv.includes("--verify")) result = output("abc123\n");
              else if (argv.includes("status"))
                result = output(
                  argv.includes("--branch") ? "## main\n" : " M README.md\0",
                );
              else if (argv.includes("--numstat"))
                result = output("1\t1\tREADME.md\0");
              else
                result = output(
                  "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old content\n+new content\n",
                );
            }
          }
          ws.send(
            frame(
              0,
              0,
              Buffer.from(
                JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
              ),
            ),
          );
          if (rich && rpc.method === "terminal.label") {
            const t = records.find(
              (t) => t.address === rpc.params.terminal,
            ) as (typeof records)[number] & { labels: Record<string, string> };
            if (t) {
              t.labels = { ...t.labels, ...rpc.params.labels };
              ws.send(
                frame(
                  2,
                  0,
                  Buffer.from(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      method: "event",
                      params: {
                        seq: ++seq,
                        type: "labels",
                        terminal: t.address,
                        data: { labels: t.labels },
                      },
                    }) + "\n",
                  ),
                ),
              );
            }
          }
          if (rpc.method === "terminal.attach") {
            if (rpc.params.observe) {
              const size = Buffer.alloc(4);
              size.writeUInt16LE(80);
              size.writeUInt16LE(24, 2);
              ws.send(frame(nextChannel, 3, size));
            }
            ws.send(frame(nextChannel++, 0, Buffer.from("中文终端就绪\r\n$ ")));
          }
        } else if (kind === 0) {
          inputs.push(payload);
          ws.send(frame(channel, 0, payload));
        } else if (kind === 1) credits.push(payload.readUInt32LE());
        else if (kind === 3) resizes.push(channel);
        else if (kind === 2) ws.send(frame(channel, 2, Buffer.alloc(0)));
      }
    });
  });
  await page.goto("/ui/");
  await page.getByLabel("用户名").fill("tester");
  await page.getByLabel("密码", { exact: true }).fill("test password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("link", { name: /隔离测试机器/ }).click();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  return { calls, inputs, credits, resizes };
}

test("login, attach, UTF-8 paint, keyboard, resize, detach without kill", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "附着", exact: true }).click();
  await expect(page.locator(".xterm-screen")).toBeVisible();
  await expect.poll(() => state.credits.length).toBeGreaterThan(0);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("echo test");
  await page.keyboard.insertText("中文");
  await expect
    .poll(() => Buffer.concat(state.inputs).toString())
    .toContain("echo test");
  await expect
    .poll(() => Buffer.concat(state.inputs).toString())
    .toContain("中文");
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(() => state.resizes.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "分离", exact: true }).click();
  await expect(page.locator(".xterm-screen")).toHaveCount(0);
  expect(state.calls.some((c) => c.method === "terminal.kill")).toBe(false);
});

test("observation never types or resizes; explicit end requires confirmation", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "只读", exact: true }).click();
  await expect
    .poll(
      () => state.calls.filter((c) => c.method === "terminal.attach").length,
    )
    .toBe(1);
  expect(
    state.calls.find((c) => c.method === "terminal.attach")?.params.observe,
  ).toBe(true);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("should-not-send");
  await page.setViewportSize({ width: 1100, height: 750 });
  expect(state.inputs).toHaveLength(0);
  expect(state.resizes).toHaveLength(0);
  await page.getByRole("button", { name: "分离", exact: true }).click();
  await page.getByRole("button", { name: "附着", exact: true }).click();
  await page.getByRole("button", { name: "结束终端", exact: true }).click();
  expect(state.calls.some((c) => c.method === "terminal.kill")).toBe(false);
  await page.getByRole("button", { name: "结束程序", exact: true }).click();
  await expect
    .poll(() => state.calls.filter((c) => c.method === "terminal.kill").length)
    .toBe(1);
});

test("native spaces, agent pins, focused directory, file and diff preview", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const state = await fixture(page, true);
  await expect(
    page.getByRole("button", { name: /空间 Project Alpha/ }),
  ).toBeVisible();
  await expect(page.locator(".xterm-screen")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Pinned/ })).toBeVisible();
  await page.getByRole("button", { name: "Unpin", exact: true }).click();
  await expect(page.getByRole("button", { name: /Pinned/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Needs you/ }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /空间 Project Beta/ }).click();
  await expect(page.locator(".xterm-screen")).toHaveCount(1);
  await expect
    .poll(
      () =>
        state.calls
          .filter(
            (c) =>
              c.method === "machine.exec" &&
              (c.params.argv as string[])[0] === "sh",
          )
          .at(-1)?.params.cwd,
    )
    .toBe("/review");
  await page.getByRole("button", { name: /README.md/ }).click();
  await expect(
    page.getByText("Workspace preview", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  await page.getByRole("button", { name: /README.md/ }).click();
  await expect(page.getByText("+new content", { exact: true })).toBeVisible();
  expect(state.calls.some((c) => c.method === "doc.set")).toBe(false);
  await page.screenshot({ path: "test-results/workspace-1280.png" });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({ path: "test-results/workspace-1920.png" });
  await page.setViewportSize({ width: 640, height: 800 });
  await page
    .getByRole("button", { name: "Files / Changes", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Files", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/workspace-narrow.png" });
});

test("phone keeps a full-width terminal while navigation and files open in a modal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, true);
  await expect(page.locator(".xterm-screen")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Spaces", exact: true }),
  ).toHaveCount(0);
  const attached = state.calls.filter(
    (c) => c.method === "terminal.attach",
  ).length;
  await page.getByRole("button", { name: "选择 Spaces / Agents" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "Codex", exact: true }),
  ).toBeVisible();
  expect(
    state.calls.filter((c) => c.method === "terminal.attach"),
  ).toHaveLength(attached);
  await page.getByRole("button", { name: "Spaces", exact: true }).click();
  await page
    .getByRole("button", { name: "空间 Project Beta", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(
      () =>
        state.calls.filter((c) => c.method === "terminal.attach").at(-1)?.params
          .terminal,
    )
    .toBe("t2");
  await page
    .getByRole("button", { name: "Files / Changes", exact: true })
    .click();
  await page.getByRole("button", { name: /README.md/ }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace preview" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "源码", exact: true }).click();
  await expect(
    page.getByText("# Workspace preview", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/workspace-phone-markdown.png" });
  await page.getByRole("button", { name: "返回终端", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/workspace-phone-terminal.png" });
});
