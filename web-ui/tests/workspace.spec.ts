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
async function fixture(page: Page) {
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
              result: { framed: true, generation: 1 },
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
            result = { channel: 2, seq: 1, terminals: [record] };
          if (rpc.method === "terminal.list") result = { terminals: [record] };
          if (rpc.method === "terminal.attach")
            result = {
              channel: nextChannel,
              terminal: record,
              resize_notifications: !!rpc.params.observe,
            };
          ws.send(
            frame(
              0,
              0,
              Buffer.from(
                JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
              ),
            ),
          );
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
