const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const MAX_FRAME = 16 * 1024 * 1024;
export type Frame = { channel: number; kind: number; payload: Uint8Array };

export function encodeFrame(
  channel: number,
  kind: number,
  payload: Uint8Array,
): Uint8Array {
  if (payload.length > MAX_FRAME) throw new Error("Frame exceeds limit");
  const b = new Uint8Array(9 + payload.length),
    v = new DataView(b.buffer);
  v.setUint32(0, channel, true);
  b[4] = kind;
  v.setUint32(5, payload.length, true);
  b.set(payload, 9);
  return b;
}

// Allocate each payload once, even when a 16 MiB frame arrives one byte at a time.
export class FrameDecoder {
  private header = new Uint8Array(9);
  private headerUsed = 0;
  private frame: Frame | null = null;
  private used = 0;
  feed(data: Uint8Array, onFrame: (f: Frame) => void) {
    let at = 0;
    while (at < data.length) {
      if (!this.frame) {
        const n = Math.min(9 - this.headerUsed, data.length - at);
        this.header.set(data.subarray(at, at + n), this.headerUsed);
        this.headerUsed += n;
        at += n;
        if (this.headerUsed < 9) return;
        const v = new DataView(this.header.buffer),
          length = v.getUint32(5, true),
          kind = this.header[4];
        if (
          length > MAX_FRAME ||
          kind > 5 ||
          ((kind === 1 || kind === 3) && length !== 4) ||
          (kind === 4 && length !== 1)
        )
          throw new Error("Invalid core frame");
        this.frame = {
          channel: v.getUint32(0, true),
          kind,
          payload: new Uint8Array(length),
        };
        this.used = 0;
      }
      const n = Math.min(
        this.frame.payload.length - this.used,
        data.length - at,
      );
      this.frame.payload.set(data.subarray(at, at + n), this.used);
      this.used += n;
      at += n;
      if (this.used === this.frame.payload.length) {
        const complete = this.frame;
        this.frame = null;
        this.headerUsed = 0;
        onFrame(complete);
      }
    }
  }
}

// Event DATA is a stream of JSON lines, not necessarily one JSON object per frame.
export class JSONLines {
  private buffer = new Uint8Array(1024);
  private size = 0;
  feed(bytes: Uint8Array, onValue: (v: unknown) => void) {
    let start = 0;
    while (start < bytes.length) {
      const nl = bytes.indexOf(10, start);
      const end = nl < 0 ? bytes.length : nl;
      const part = bytes.subarray(start, end);
      const size = this.size + part.length;
      if (size > MAX_FRAME) throw new Error("Event line exceeds limit");
      if (size > this.buffer.length) {
        const next = new Uint8Array(
          Math.min(MAX_FRAME, Math.max(size, this.buffer.length * 2)),
        );
        next.set(this.buffer.subarray(0, this.size));
        this.buffer = next;
      }
      this.buffer.set(part, this.size);
      this.size = size;
      if (nl < 0) return;
      const line = this.buffer.subarray(0, this.size);
      this.size = 0;
      start = nl + 1;
      if (line.length) onValue(JSON.parse(decoder.decode(line)));
    }
  }
}

type RPC = {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { message: string };
  method?: string;
  params?: unknown;
};
type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onResult?: (v: unknown) => void;
};
export type TerminalRecord = {
  address: string;
  title?: string;
  state: string;
  status?: unknown;
  records?: unknown;
  cols: number;
  rows: number;
  [key: string]: unknown;
};
export type Snapshot = {
  channel: number;
  terminals: TerminalRecord[];
  seq: number;
};
export type CoreEvent = {
  method: string;
  params: {
    seq: number;
    type?: string;
    terminal?: string;
    data?: Record<string, unknown>;
    terminals?: TerminalRecord[];
  };
};

export class TerminalStore {
  private seq = -1;
  private records = new Map<string, TerminalRecord>();
  reset(snapshot: { seq: number; terminals: TerminalRecord[] }) {
    this.seq = snapshot.seq;
    this.records = new Map(snapshot.terminals.map((t) => [t.address, t]));
  }
  apply(event: CoreEvent): boolean {
    const p = event.params;
    if (!p || typeof p.seq !== "number") return false;
    if (event.method === "missed" && p.terminals) {
      this.reset({ seq: p.seq, terminals: p.terminals });
      return true;
    }
    if (event.method !== "event" || p.seq <= this.seq) return false;
    this.seq = p.seq;
    if (!p.terminal) return false;
    const data = p.data || {},
      old = this.records.get(p.terminal);
    if (p.type === "removed") this.records.delete(p.terminal);
    else if (p.type === "created" || p.type === "restarted")
      this.records.set(p.terminal, {
        ...data,
        address: p.terminal,
      } as TerminalRecord);
    else if (p.type === "labels" && data.record)
      this.records.set(p.terminal, data.record as TerminalRecord);
    else if (old) {
      const next = { ...old };
      if (p.type === "foreground") next.foreground = p.data;
      else {
        Object.assign(next, data);
        if (p.type === "finished") next.state = "finished";
        if (p.type === "lost" || p.type === "finished") {
          next.pid = null;
          next.foreground = null;
        }
      }
      this.records.set(p.terminal, next);
    }
    return true;
  }
  list() {
    return [...this.records.values()].filter((t) => t.state === "live");
  }
}

export class CoreClient {
  private socket: WebSocket | null = null;
  private framed = false;
  private plain = new Uint8Array(0);
  private parser = new FrameDecoder();
  private nextID = 1;
  private pending = new Map<number, Pending>();
  private streams = new Map<number, (f: Frame) => void>();
  private disposed = false;
  onEvent: ((event: CoreEvent) => void) | null = null;
  onDisconnect: ((reason: string) => void) | null = null;

  async connect(bridgeID: string) {
    if (this.socket || this.disposed)
      throw new Error("Create a fresh core client for each connection");
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/v1/bridges/${encodeURIComponent(bridgeID)}`,
    );
    this.socket = ws;
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("连接超时"));
      }, 15000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("连接失败"));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error("连接已关闭"));
        this.fail("连接已断开；未确认的操作结果未知，请刷新实际列表。");
      };
      ws.onmessage = (e) => {
        try {
          if (!(e.data instanceof ArrayBuffer))
            throw new Error("Invalid websocket data");
          this.receive(new Uint8Array(e.data));
        } catch {
          this.fail("协议错误");
          ws.close();
        }
      };
    });
    await this.call<{ framed: boolean; generation: number }>(
      "hello",
      { framed: true, generation: 1, features: ["resize_notifications"] },
      (r) => {
        if (!r.framed || r.generation !== 1)
          throw new Error("Unsupported core generation");
        this.framed = true;
      },
    );
  }
  private send(b: Uint8Array) {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.disposed
    )
      throw new Error("未连接；操作没有发送");
    if (this.socket.bufferedAmount + b.length > 4 * 1024 * 1024) {
      this.socket.close();
      throw new Error("发送队列已满；操作结果未知");
    }
    // A message is always below the server's minimum negotiated message limit (1024 bytes).
    for (let n = 0; n < b.length; n += 1000)
      this.socket.send(b.slice(n, n + 1000));
  }
  private receive(b: Uint8Array) {
    if (this.framed) {
      this.parser.feed(b, (f) => this.frame(f));
      return;
    }
    const all = new Uint8Array(this.plain.length + b.length);
    all.set(this.plain);
    all.set(b, this.plain.length);
    const nl = all.indexOf(10);
    if (nl < 0) {
      if (all.length > 65536) throw new Error("Hello too large");
      this.plain = all;
      return;
    }
    if (nl > 65536) throw new Error("Hello too large");
    this.rpc(JSON.parse(decoder.decode(all.slice(0, nl))) as RPC);
    this.plain = new Uint8Array(0);
    if (!this.framed) throw new Error("Hello did not negotiate framed mode");
    if (all.length > nl + 1)
      this.parser.feed(all.slice(nl + 1), (f) => this.frame(f));
  }
  private frame(f: Frame) {
    if (f.channel === 0) {
      if (f.kind !== 0) throw new Error("Invalid control channel");
      this.rpc(JSON.parse(decoder.decode(f.payload)) as RPC);
      return;
    }
    const fn = this.streams.get(f.channel);
    if (!fn) throw new Error("Unknown core channel");
    fn(f);
    if (f.kind === 2) this.streams.delete(f.channel);
  }
  private rpc(msg: RPC) {
    if (msg.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC envelope");
    if (msg.id === undefined) {
      this.onEvent?.(msg as CoreEvent);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(new Error(msg.error.message));
      return;
    }
    try {
      p.onResult?.(msg.result);
      p.resolve(msg.result);
    } catch (e) {
      p.reject(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }
  call<T = unknown>(
    method: string,
    params: unknown = {},
    onResult?: (v: T) => void,
  ): Promise<T> {
    if (this.pending.size >= 128)
      return Promise.reject(new Error("Too many pending RPCs"));
    const id = this.nextID++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`${method} 响应超时；结果未知，请刷新列表，不会自动重试。`),
        );
        // A late attach response would create an unknown live channel. Reconnect cleanly.
        if (
          method === "terminal.attach" ||
          method === "events.subscribe" ||
          method === "hello"
        )
          this.socket?.close();
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
        onResult: onResult as ((v: unknown) => void) | undefined,
      });
      try {
        const raw = encoder.encode(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) +
            (this.framed ? "" : "\n"),
        );
        this.send(this.framed ? encodeFrame(0, 0, raw) : raw);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  subscribe(onSnapshot?: (snapshot: Snapshot) => void) {
    return this.call<Snapshot>("events.subscribe", {}, (result) => {
      this.validateChannel(result.channel);
      const lines = new JSONLines();
      this.streams.set(result.channel, (f) => {
        if (f.kind === 0) {
          lines.feed(f.payload, (v) => this.onEvent?.(v as CoreEvent));
          this.credit(f.channel, f.payload.length);
        } else if (f.kind === 2) this.socket?.close(); // Resubscribe to a fresh authoritative snapshot.
      });
      onSnapshot?.(result);
    });
  }
  attach(
    terminal: string,
    cols: number,
    rows: number,
    observe: boolean,
    onFrame: (f: Frame) => void,
  ) {
    return this.call<{
      channel: number;
      terminal: TerminalRecord;
      resize_notifications?: boolean;
    }>(
      "terminal.attach",
      {
        terminal,
        cols,
        rows,
        observe,
        resize_notifications: observe,
        resumed: true,
        history: 1000,
      },
      (r) => {
        this.validateChannel(r.channel);
        this.streams.set(r.channel, onFrame);
      },
    );
  }
  private validateChannel(channel: number) {
    if (
      !Number.isInteger(channel) ||
      channel < 1 ||
      channel > 0xffffffff ||
      this.streams.has(channel)
    )
      throw new Error("Invalid core channel");
  }
  frameSend(channel: number, kind: number, payload: Uint8Array) {
    this.send(encodeFrame(channel, kind, payload));
  }
  input(channel: number, text: string) {
    this.frameSend(channel, 0, encoder.encode(text));
  }
  credit(channel: number, n: number) {
    if (!this.streams.has(channel)) return;
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    this.frameSend(channel, 1, b);
  }
  resize(channel: number, cols: number, rows: number) {
    const b = new Uint8Array(4),
      v = new DataView(b.buffer);
    v.setUint16(0, cols, true);
    v.setUint16(2, rows, true);
    this.frameSend(channel, 3, b);
  }
  focus(channel: number, gained: boolean) {
    this.frameSend(channel, 4, new Uint8Array([gained ? 1 : 0]));
  }
  detach(channel: number) {
    if (this.streams.has(channel)) this.frameSend(channel, 2, new Uint8Array());
  }
  private fail(reason: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.streams.clear();
    if (!this.disposed) this.onDisconnect?.(reason);
  }
  dispose() {
    this.disposed = true;
    this.fail("连接关闭；未确认的操作结果未知");
    this.socket?.close();
    this.socket = null;
    this.onEvent = null;
    this.onDisconnect = null;
  }
}
