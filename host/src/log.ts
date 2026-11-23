import {
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

/** The most a log file holds before it becomes the one older file. */
export const logCap = 4 * 1024 * 1024;

/**
 * A log file of at most `cap` bytes, with one older file beside it as
 * `<name>.1`, which each turn replaces.
 */
export class CappedLog {
  private size: number | undefined;

  constructor(
    readonly path: string,
    private readonly cap = logCap,
  ) {}

  append(text: string | Uint8Array): void {
    const bytes = typeof text === "string" ? Buffer.from(text) : text;
    if (this.size === undefined) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        this.size = statSync(this.path).size;
      } catch {
        this.size = 0;
      }
    }
    if (this.size > 0 && this.size + bytes.byteLength > this.cap) {
      renameSync(this.path, `${this.path}.1`);
      this.size = 0;
    }
    appendFileSync(this.path, bytes, { mode: 0o600 });
    this.size += bytes.byteLength;
  }
}

/** The host's own log: one line each, with the time. */
export type Log = (line: string) => void;

export function hostLog(file: CappedLog, echo?: (line: string) => void): Log {
  return (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    try {
      file.append(`${stamped}\n`);
    } catch {
      // A log that cannot be written stops nothing.
    }
    echo?.(stamped);
  };
}
