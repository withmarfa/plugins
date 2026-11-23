import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { readIfThere } from "./files.js";

/** Whether a process with this ID is alive. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The process that holds the lock at `path`, if one does and is alive. */
export function holder(path: string): number | undefined {
  const pid = Number.parseInt(readIfThere(path) ?? "", 10);
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
}

/**
 * Takes the lock at `path` for this process, so two `run` processes never
 * share one folder. A lock left by a process that is gone is taken over.
 * Answers the ID of the process that holds it, when another does.
 */
export function takeLock(path: string): { release: () => void } | number {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release: () => {
          if (readIfThere(path) === String(process.pid))
            rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const pid = holder(path);
    if (pid !== undefined) return pid;
    rmSync(path, { force: true });
  }
  const pid = holder(path);
  if (pid !== undefined) return pid;
  throw new Error(`could not take the lock ${path}`);
}
