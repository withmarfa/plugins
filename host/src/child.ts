import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type { CappedLog } from "./log.js";
import { permissionFlags } from "./permission-flags.js";

/** The arguments a connector's process starts with. */
export function childArguments(file: string): string[] {
  return [...permissionFlags(file), file, "--every", "15m"];
}

/**
 * The signal that wakes a connector for a run now. Not `SIGUSR1`: under the
 * permission model Node creates no listener for it, so it never arrives.
 */
export const wakeSignal = "SIGUSR2";

const passed = ["PATH", "HOME", "TZ", "LANG"];

/**
 * The whole environment a connector's process gets. Telemetry settings pass
 * only when the host itself was told where to send them.
 */
export function childEnvironment(
  host: NodeJS.ProcessEnv,
  origin: string,
  key: string,
): Record<string, string> {
  const env: Record<string, string> = {
    MARFA_API_URL: origin,
    MARFA_API_KEY: key,
  };
  const telemetry = (host["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "") !== "";
  for (const [name, value] of Object.entries(host)) {
    if (value === undefined) continue;
    if (
      passed.includes(name) ||
      name.startsWith("LC_") ||
      (telemetry &&
        (name.startsWith("OTEL_") || name.startsWith("MARFA_OTEL_")))
    )
      env[name] = value;
  }
  return env;
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A connector's running process. */
export interface Child {
  readonly pid: number | undefined;
  signal(signal: NodeJS.Signals): void;
  readonly exited: Promise<Exit>;
  /** The last line it wrote to standard error. */
  lastError(): string | undefined;
}

export type Spawn = (
  plugin: string,
  file: string,
  env: Record<string, string>,
) => Child;

/** Starts the connector with Node itself, writing what it says to `log`. */
export function spawnConnector(
  execPath: string,
  logOf: (plugin: string) => CappedLog,
): Spawn {
  return (plugin, file, env) => {
    // The permission model compares real paths, so a link in the folder's
    // path would refuse the file it names.
    const real = realpathSync(file);
    const log = logOf(plugin);
    const write = (chunk: Buffer): void => {
      try {
        log.append(chunk);
      } catch {
        // A log that cannot be written stops nothing.
      }
    };
    const child = spawn(execPath, childArguments(real), {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pending = "";
    let last: string | undefined;
    child.stdout.on("data", write);
    child.stderr.on("data", (chunk: Buffer) => {
      write(chunk);
      const lines = (pending + chunk.toString("utf8")).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") last = line.trim();
      if (pending.length > 4096) pending = pending.slice(-4096);
    });
    const exited = new Promise<Exit>((done) => {
      child.once("error", (error) => {
        last = error.message;
        done({ code: null, signal: null });
      });
      child.once("close", (code, signal) => {
        if (pending.trim() !== "") last = pending.trim();
        done({ code, signal });
      });
    });
    return {
      pid: child.pid,
      signal: (name) => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill(name);
      },
      exited,
      lastError: () => last,
    };
  };
}
