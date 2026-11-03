import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { CoreClient, type Frame, type TerminalRecord } from "./core";
import styles from "./app.module.css";

type Props = {
  core: CoreClient;
  id: string;
  observe: boolean;
  grid?: TerminalRecord;
  onDetach: () => void;
  onKill: () => void;
};
export function TerminalPane({
  core,
  id,
  observe,
  grid,
  onDetach,
  onKill,
}: Props) {
  const el = useRef<HTMLDivElement>(null),
    view = useRef<{ terminal: Terminal; orderedResize: boolean } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!el.current) return;
    let channel: number | undefined,
      disposed = false,
      win32 = false,
      draining = false,
      queuedBytes = 0;
    const queue: Frame[] = [];
    const terminal = new Terminal({
      cursorBlink: !observe,
      disableStdin: observe,
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      fontSize: 14,
      scrollback: 5000,
      theme: { background: "#141821" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(el.current);
    fit.fit();
    view.current = { terminal, orderedResize: false };
    const safe = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    };
    const drain = () => {
      if (disposed || draining) return;
      while (queue.length) {
        const f = queue.shift()!;
        queuedBytes -= f.payload.length;
        if (f.kind === 0) {
          draining = true;
          terminal.write(f.payload, () => {
            draining = false;
            if (!disposed) {
              safe(() => core.credit(f.channel, f.payload.length));
              drain();
            }
          });
          return;
        }
        if (f.kind === 3) {
          const v = new DataView(f.payload.buffer, f.payload.byteOffset),
            cols = v.getUint16(0, true),
            rows = v.getUint16(2, true);
          if (cols && rows) terminal.resize(cols, rows);
        } else if (f.kind === 2)
          setError("终端流已结束；程序重启时会重新附着。");
      }
    };
    const ro = new ResizeObserver(() => {
      if (!observe) {
        fit.fit();
        if (channel !== undefined)
          safe(() => core.resize(channel!, terminal.cols, terminal.rows));
      }
    });
    ro.observe(el.current);
    const input = terminal.onData((text) => {
      if (channel === undefined || observe) return;
      // IME composition and paste do not carry physical key events. Emit Unicode records in ConPTY mode.
      safe(() =>
        core.input(
          channel!,
          win32
            ? text
                .split("")
                .map((ch) => `\x1b[0;0;${ch.charCodeAt(0)};1;0;1_`)
                .join("")
            : text,
        ),
      );
    });
    const mode = terminal.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        if (params.includes(9001)) {
          win32 = true;
          return true;
        }
        return false;
      },
    );
    const reset = terminal.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        if (params.includes(9001)) {
          win32 = false;
          return true;
        }
        return false;
      },
    );
    terminal.attachCustomKeyEventHandler((e) => {
      if (!win32 || observe || e.isComposing || channel === undefined)
        return true;
      if (e.type !== "keydown" && e.type !== "keyup") return false;
      // Browser APIs do not expose hardware scan codes; Windows accepts zero with a VK/Unicode record.
      const control =
          (e.altKey ? 2 : 0) | (e.ctrlKey ? 8 : 0) | (e.shiftKey ? 16 : 0),
        unicode = e.key.length === 1 ? e.key.charCodeAt(0) : 0;
      safe(() =>
        core.input(
          channel!,
          `\x1b[${e.keyCode};0;${unicode};${e.type === "keydown" ? 1 : 0};${control};1_`,
        ),
      );
      return false;
    });
    core
      .attach(id, terminal.cols, terminal.rows, observe, (f) => {
        if (disposed) return;
        if (
          queuedBytes + f.payload.length > 4 * 1024 * 1024 ||
          queue.length >= 4096
        ) {
          safe(() => core.detach(f.channel));
          setError("终端渲染队列已满，请重新附着。");
          return;
        }
        queue.push(f);
        queuedBytes += f.payload.length;
        drain();
      })
      .then((r) => {
        channel = r.channel;
        if (disposed) {
          safe(() => core.detach(r.channel));
          return;
        }
        view.current!.orderedResize = !!r.resize_notifications;
        if (!observe) {
          fit.fit();
          safe(() => core.resize(r.channel, terminal.cols, terminal.rows));
        } else if (
          !r.resize_notifications &&
          r.terminal.cols &&
          r.terminal.rows
        )
          terminal.resize(r.terminal.cols, r.terminal.rows);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    const focus = () => {
      if (channel !== undefined && !observe)
        safe(() => core.focus(channel!, true));
    };
    const blur = () => {
      if (channel !== undefined && !observe)
        safe(() => core.focus(channel!, false));
    };
    const node = el.current;
    node.addEventListener("focusin", focus);
    node.addEventListener("focusout", blur);
    return () => {
      disposed = true;
      view.current = null;
      ro.disconnect();
      input.dispose();
      mode.dispose();
      reset.dispose();
      node.removeEventListener("focusin", focus);
      node.removeEventListener("focusout", blur);
      if (channel !== undefined) safe(() => core.detach(channel!));
      terminal.dispose();
    };
  }, [core, id, observe]);
  useEffect(() => {
    if (
      observe &&
      view.current &&
      !view.current.orderedResize &&
      grid?.cols &&
      grid.rows
    )
      view.current.terminal.resize(grid.cols, grid.rows);
  }, [observe, grid?.cols, grid?.rows]);
  return (
    <section className={styles.pane} data-observe={observe}>
      <header>
        <strong>{id}</strong>
        <span>{observe ? "只读观察" : "共享输入 · 多窗口可能共同控制"}</span>
        <button onClick={onDetach}>分离</button>
        <button className={styles.danger} onClick={onKill}>
          结束终端
        </button>
      </header>
      {error && <p role="status">{error}</p>}
      <div className={styles.terminal} ref={el} />
    </section>
  );
}
