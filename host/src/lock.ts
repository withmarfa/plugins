import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { uptime } from "node:os";
import { basename, dirname, join } from "node:path";

/** Whether a process with this ID is alive. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * What tells this boot from another: Linux's boot ID, else the time the
 * system started, in milliseconds. The boot ID is used where there is one,
 * since a step of the wall clock moves the start time worked out from it.
 */
export function thisBoot(): string | number {
  if (process.platform === "linux") {
    try {
      const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (id !== "") return id;
    } catch {
      // No procfs: the start time serves.
    }
  }
  return Math.round(Date.now() - uptime() * 1000);
}

/** Two start times this close are one boot: they differ by rounding and drift. */
const bootTolerance = 10_000;

function sameBoot(a: string | number, b: string | number): boolean {
  if (typeof a === "number" && typeof b === "number")
    return Math.abs(a - b) <= bootTolerance;
  return a === b;
}

/** How long a lock that cannot be read is taken to be one being written. */
const unreadableHeldMs = 5_000;

/** How long a takeover may hold its own lock before another clears it. */
const takeoverHeldMs = 10_000;

interface Written {
  pid: number;
  boot: string | number;
}

function parse(text: string): Written | undefined {
  try {
    const value = JSON.parse(text) as Partial<Written>;
    if (
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      (typeof value.boot === "number" || typeof value.boot === "string")
    )
      return { pid: value.pid, boot: value.boot };
  } catch {
    // Not whole.
  }
  return undefined;
}

type Seen =
  | { kind: "none" }
  | { kind: "live"; pid: number; ino: number }
  | { kind: "starting"; ino: number }
  | { kind: "stale"; ino: number };

function look(path: string, now: number): Seen {
  let text: string;
  let ino: number;
  let mtime: number;
  try {
    const stat = statSync(path);
    ino = stat.ino;
    mtime = stat.mtimeMs;
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "none" };
    throw error;
  }
  const written = parse(text);
  if (written === undefined)
    return now - mtime < unreadableHeldMs
      ? { kind: "starting", ino }
      : { kind: "stale", ino };
  if (sameBoot(written.boot, thisBoot()) && alive(written.pid))
    return { kind: "live", pid: written.pid, ino };
  return { kind: "stale", ino };
}

/** The process that holds the lock at `path`, if one does and is alive. */
export function holder(path: string): number | undefined {
  const seen = look(path, Date.now());
  return seen.kind === "live" ? seen.pid : undefined;
}

/** Puts a file holding `text` at `path`, failing with `EEXIST` when one is
 *  there: written whole beside it first, then linked into place. */
function place(path: string, text: string): boolean {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface Lock {
  release(): void;
}

/**
 * Takes the lock at `path` for this process, so two `run` processes never
 * share one folder. A lock left by a process that is gone, or written in
 * another boot, is taken over; only one process at a time may take one over,
 * under a lock of its own, so none removes a lock another just took. Answers
 * the process that holds it otherwise: `undefined` while its lock is still
 * being written.
 */
export function takeLock(
  path: string,
): { lock: Lock } | { holder: number | undefined } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mine = `${JSON.stringify({ pid: process.pid, boot: thisBoot() })}\n`;
  const lock: Lock = {
    release: () => {
      try {
        if (readFileSync(path, "utf8") === mine) rmSync(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
  const takeover = `${path}.takeover`;
  for (let tries = 0; tries < 200; tries++) {
    if (place(path, mine)) return { lock };
    const seen = look(path, Date.now());
    if (seen.kind === "live") return { holder: seen.pid };
    if (seen.kind === "starting") return { holder: undefined };
    if (seen.kind === "none") continue;
    if (!place(takeover, `${String(process.pid)}\n`)) {
      try {
        if (Date.now() - statSync(takeover).mtimeMs > takeoverHeldMs)
          rmSync(takeover, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      pause(5);
      continue;
    }
    try {
      // Only a takeover removes a lock it did not write, so while this one
      // holds `takeover`, a lock still stale and still the same file is safe
      // to remove.
      const again = look(path, Date.now());
      if (again.kind === "stale" && again.ino === seen.ino)
        rmSync(path, { force: true });
    } finally {
      rmSync(takeover, { force: true });
    }
  }
  throw new Error(`could not take the lock ${path}`);
}
