import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoreClient,
  FrameDecoder,
  JSONLines,
  MAX_FRAME,
  TerminalStore,
  encodeFrame,
  type Frame,
  type TerminalRecord,
} from "./core";
import { decodeEnvelope, encodeEnvelope } from "./bridge";
import vectors from "../../contracts/bridge/vectors.json";
const enc = new TextEncoder(),
  dec = new TextDecoder();
const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));
const concat = (...all: Uint8Array[]) => {
  const b = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    b.set(p, at);
    at += p.length;
  }
  return b;
};

describe("wire parsing", () => {
  it.each(vectors)("matches Go vector $name", (v) => {
    expect(encodeEnvelope(v.tunnel_id, bytes(v.payload_hex))).toEqual(
      bytes(v.wire_hex),
    );
    expect(decodeEnvelope(bytes(v.wire_hex))).toEqual({
      id: v.tunnel_id,
      payload: bytes(v.payload_hex),
    });
  });
  it("decodes every possible split and coalesced frames including zero length CLOSE", () => {
    const wire = concat(
      encodeFrame(4, 0, enc.encode("中文\x1b[31m")),
      encodeFrame(4, 2, new Uint8Array()),
    );
    for (let split = 0; split <= wire.length; split++) {
      const parser = new FrameDecoder(),
        frames: Frame[] = [];
      parser.feed(wire.slice(0, split), (f) => frames.push(f));
      parser.feed(wire.slice(split), (f) => frames.push(f));
      expect(frames.map((f) => f.kind)).toEqual([0, 2]);
      expect(dec.decode(frames[0].payload)).toBe("中文\x1b[31m");
    }
  });
  it("bounds allocations before payload and rejects malformed fixed-size frames", () => {
    const oversized = new Uint8Array(9);
    new DataView(oversized.buffer).setUint32(5, MAX_FRAME + 1, true);
    expect(() => new FrameDecoder().feed(oversized, () => {})).toThrow();
    for (const kind of [1, 3, 4, 9])
      expect(() =>
        new FrameDecoder().feed(
          encodeFrame(1, kind, new Uint8Array(3)),
          () => {},
        ),
      ).toThrow();
  });
  it("parses JSON lines split inside UTF-8 and combined across data frames", () => {
    const lines = new JSONLines(),
      values: unknown[] = [],
      raw = enc.encode('{"text":"中文"}\n{"seq":2}\n');
    for (const byte of raw)
      lines.feed(new Uint8Array([byte]), (v) => values.push(v));
    expect(values).toEqual([{ text: "中文" }, { seq: 2 }]);
    expect(() => lines.feed(new Uint8Array(MAX_FRAME + 1), () => {})).toThrow();
  });
});

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "";
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  constructor() {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(b: Uint8Array) {
    this.sent.push(b.slice());
  }
  close() {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  receive(b: Uint8Array) {
    this.onmessage?.({ data: b.slice().buffer });
  }
  reply(id: number, result: unknown) {
    this.receive(
      encodeFrame(
        0,
        0,
        enc.encode(JSON.stringify({ jsonrpc: "2.0", id, result })),
      ),
    );
  }
}
const clients: CoreClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function connected() {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", { protocol: "https:", host: "example.com" });
  const c = new CoreClient();
  clients.push(c);
  const promise = c.connect("00112233-4455-6677-8899-aabbccddeeff");
  await Promise.resolve();
  await Promise.resolve();
  const ws = FakeSocket.last;
  const hello = JSON.parse(dec.decode(ws.sent[0])) as { id: number };
  ws.receive(
    enc.encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: hello.id,
        result: { framed: true, generation: 1 },
      }) + "\n",
    ),
  );
  await promise;
  ws.sent = [];
  return { c, ws };
}
function outgoing(ws: FakeSocket) {
  const frames: Frame[] = [],
    parser = new FrameDecoder();
  for (const b of ws.sent) parser.feed(b, (f) => frames.push(f));
  return frames;
}

describe("core lifecycle", () => {
  it("matches concurrent RPCs out of order", async () => {
    const { c, ws } = await connected();
    const a = c.call("terminal.list"),
      b = c.call("terminal.list");
    const ids = outgoing(ws).map(
      (f) => JSON.parse(dec.decode(f.payload)).id as number,
    );
    ws.reply(ids[1], "second");
    ws.reply(ids[0], "first");
    expect(await a).toBe("first");
    expect(await b).toBe("second");
  });
  it("registers an attach channel before coalesced DATA and credits only after rendering", async () => {
    const { c, ws } = await connected();
    const frames: Frame[] = [];
    const attach = c.attach("remote/t1", 80, 24, false, (f) => frames.push(f));
    const rpc = JSON.parse(dec.decode(outgoing(ws)[0].payload));
    ws.sent = [];
    ws.receive(
      concat(
        encodeFrame(
          0,
          0,
          enc.encode(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { channel: 7 },
            }),
          ),
        ),
        encodeFrame(7, 0, enc.encode("hello")),
      ),
    );
    await attach;
    expect(frames).toHaveLength(1);
    expect(ws.sent).toHaveLength(0);
    c.credit(7, 5);
    expect(outgoing(ws)[0].kind).toBe(1);
    expect(
      new DataView(outgoing(ws)[0].payload.buffer).getUint32(0, true),
    ).toBe(5);
    c.detach(7);
    expect(outgoing(ws).at(-1)?.kind).toBe(2);
    expect(
      outgoing(ws).some((f) => dec.decode(f.payload).includes("terminal.kill")),
    ).toBe(false);
  });
  it("applies snapshot before any coalesced event and parses event lines across frames", async () => {
    const { c, ws } = await connected();
    const observed: unknown[] = [];
    c.onEvent = (e) => observed.push(e.params.seq);
    const subscribe = c.subscribe((s) => observed.push(s.seq));
    const rpc = JSON.parse(dec.decode(outgoing(ws)[0].payload));
    const event = enc.encode(
      '{"jsonrpc":"2.0","method":"event","params":{"seq":3}}\n',
    );
    ws.receive(
      concat(
        encodeFrame(
          0,
          0,
          enc.encode(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { channel: 9, seq: 2, terminals: [] },
            }),
          ),
        ),
        encodeFrame(9, 0, event.slice(0, 10)),
        encodeFrame(9, 0, event.slice(10)),
      ),
    );
    await subscribe;
    expect(observed).toEqual([2, 3]);
    expect(outgoing(ws).filter((f) => f.kind === 1)).toHaveLength(2);
  });
  it("never replays terminal.run after a disconnect", async () => {
    const { c, ws } = await connected();
    const run = c.call("terminal.run", {});
    const rejected = expect(run).rejects.toThrow("结果未知");
    ws.close();
    await rejected;
    expect(outgoing(ws)).toHaveLength(1);
  });
  it("bounds pending RPC count and outbound socket bytes", async () => {
    const { c, ws } = await connected();
    const pending = Array.from({ length: 128 }, () =>
      c.call("terminal.list").catch((e) => e),
    );
    await expect(c.call("terminal.list")).rejects.toThrow("Too many");
    c.dispose();
    await Promise.all(pending);
    const second = await connected();
    second.ws.bufferedAmount = 4 * 1024 * 1024;
    await expect(second.c.call("terminal.run")).rejects.toThrow();
    expect(second.ws.readyState).toBe(3);
  });
  it("times out side effects once without retrying", async () => {
    const { c, ws } = await connected();
    vi.useFakeTimers();
    const call = c.call("terminal.run");
    const rejected = expect(call).rejects.toThrow("结果未知");
    await vi.advanceTimersByTimeAsync(15001);
    await rejected;
    expect(outgoing(ws)).toHaveLength(1);
  });
});

it("uses addresses across remote machines, ignores old events, and accepts missed snapshots", () => {
  const store = new TerminalStore();
  const terminal = {
    address: "a/t1",
    state: "live",
    cols: 80,
    rows: 24,
  } satisfies TerminalRecord;
  store.reset({
    seq: 5,
    terminals: [terminal, { ...terminal, address: "b/t1" }],
  });
  store.apply({
    method: "event",
    params: { seq: 4, type: "removed", terminal: "a/t1" },
  });
  expect(store.list()).toHaveLength(2);
  store.apply({
    method: "event",
    params: { seq: 6, type: "finished", terminal: "a/t1", data: {} },
  });
  expect(store.list().map((t) => t.address)).toEqual(["b/t1"]);
  store.apply({ method: "missed", params: { seq: 7, terminals: [] } });
  expect(store.list()).toEqual([]);
});
