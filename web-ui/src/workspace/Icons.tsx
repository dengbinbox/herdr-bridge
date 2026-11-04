import type { CSSProperties } from "react";
import type { TerminalRecord } from "../core";
import { basename, obj, str } from "./model";
import { stateLabel, type State } from "./agent-state";
import programs from "./icons/programs.json";
import styles from "./workspace.module.css";
const images = import.meta.glob<string>("./icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});
export type IconName =
  | "menu"
  | "folder"
  | "file"
  | "branch"
  | "pin"
  | "pin-off"
  | "close"
  | "chevron-right"
  | "chevron-down"
  | "terminal"
  | "agents"
  | "changes"
  | "plus";
const paths: Record<IconName, string[]> = {
  menu: ["M4 6h16M4 12h16M4 18h16"],
  folder: [
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  ],
  file: [
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z",
    "M14 2v6h6",
  ],
  branch: [
    "M6 7.5v9M18 9.5c0 4.5-6.5 3.5-11 7.5",
    "M8 5.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0M8 18.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0M20 7.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  ],
  pin: [
    "M12 17v5",
    "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  ],
  "pin-off": ["M2 2l20 20M12 17v5M9 9v2l-4 3v3h12M15 10V7l2-2V2H7"],
  close: ["M6 6l12 12M18 6 6 18"],
  "chevron-right": ["m9 5 7 7-7 7"],
  "chevron-down": ["m5 9 7 7 7-7"],
  terminal: ["m5 7 5 5-5 5M13 17h6"],
  agents: ["M9 18h6M9 22h6M9 14v-3M15 14v-3", "M8 18a7 7 0 1 1 8 0"],
  changes: ["M8 3H5v18h3M16 3h3v18h-3M10 8h5M12.5 5.5v5M10 16h5"],
  plus: ["M12 5v14M5 12h14"],
};
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className={styles.icon}
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
export function programIdentity(t: TerminalRecord) {
  const normalize = (value: unknown) => basename(str(value).replace(/\\/g, "/"))
    .toLowerCase().replace(/^-+/, "").replace(/\.exe$/, "");
  const match = (value: unknown) => {
    const candidate = normalize(value);
    for (const [id, p] of Object.entries(programs))
      if (p.match.includes(candidate)) return { id, ...p };
  };
  const reported = str(obj(t.report).app) || str(obj(t.status).app);
  if (reported) return match(reported) || { id: "agent", ...programs.agent };
  // Foreground data describes the current process; launch argv may be stale.
  const foreground = obj(t.foreground);
  const argv = Array.isArray(foreground.argv) && foreground.argv.length
    ? foreground.argv
    : foreground.name ? [] : Array.isArray(t.argv) ? t.argv : [];
  const candidates = [foreground.name, ...argv];
  for (const candidate of candidates) {
    const program = match(candidate);
    if (program) return program;
  }
  if (str(obj(t.status).state)) return { id: "agent", ...programs.agent };
  const name = normalize(foreground.name || argv[0]);
  const shell = !name || ["zsh", "bash", "fish", "sh", "dash", "nu", "pwsh", "powershell", "cmd", "elvish", "xonsh", "tcsh", "csh", "ksh", "ion"].includes(name);
  return { id: shell ? "shell" : "terminal", name: shell ? "Shell" : name, tint: true };
}
export function ProgramIcon({ record }: { record: TerminalRecord }) {
  const p = programIdentity(record),
    url = images[`./icons/${p.id}.svg`];
  if (p.id === "shell" || p.id === "terminal")
    return <span role="img" aria-label={p.name} className={styles.programIcon}><Icon name="terminal" size={18} /></span>;
  return p.tint ? (
    <span
      role="img"
      aria-label={p.name}
      className={styles.programIcon}
      style={
        {
          maskImage: `url("${url}")`,
          WebkitMaskImage: `url("${url}")`,
          backgroundColor: "currentColor",
        } as CSSProperties
      }
    />
  ) : (
    <img className={styles.programIcon} src={url} alt={p.name} />
  );
}
export function AgentStatus({ state }: { state: State }) {
  return (
    <span
      className={styles.agentStatus}
      data-state={state}
      role="img"
      aria-label={stateLabel[state]}
      title={stateLabel[state]}
    >
      {state === "working" ? (
        <svg
          className={styles.spinner}
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.2"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="9.4" opacity=".24" />
          <path d="M12 2.6a9.4 9.4 0 0 1 9.4 9.4" />
        </svg>
      ) : state === "blocked" ? (
        <span className={styles.blockedMark}>!</span>
      ) : (
        <span
          className={state === "idle" ? styles.idleMark : styles.doneMark}
        />
      )}
    </span>
  );
}
