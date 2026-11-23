import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { holder, takeLock, thisBoot } from "../src/lock.js";
import { scratch, until } from "./helpers.js";

/** The lock as a `run` of another time wrote it. */
function lockOf(pid: number, boot: string | number): string {
  return `${JSON.stringify({ pid, boot })}\n`;
}

function held(taken: ReturnType<typeof takeLock>): boolean {
  return "lock" in taken;
}

/**
 * A process that waits for `go`, tries the lock at `lock` once, writes its
 * process ID into `won` when it took it, and holds it until `done`.
 */
const contender = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [lockModule, lock, go, won, done] = process.argv.slice(1);
// Spins, so every contender reaches the lock in the same moment.
const { takeLock } = await import(lockModule);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
while (!existsSync(go));
const taken = takeLock(lock);
if ("lock" in taken) writeFileSync(join(won, String(process.pid)), "");
writeFileSync(join(won, "tried-" + String(process.pid)), "");
while (!existsSync(done)) await wait(10);
`;

const builtLock = resolve(import.meta.dirname, "../dist/lock.js");

describe("the connector host's run lock", () => {
  it("is held by one process only when many start at once", async () => {
    const rounds = 80;
    const contenders = 16;
    const winners: number[] = [];
    for (let round = 0; round < rounds; round++) {
      const folder = scratch();
      const lock = join(folder, "home", "run.lock");
      const go = join(folder, "go");
      const won = join(folder, "won");
      const done = join(folder, "done");
      mkdirSync(won);
      const children = Array.from({ length: contenders }, () =>
        spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            contender,
            builtLock,
            lock,
            go,
            won,
            done,
          ],
          { stdio: "ignore" },
        ),
      );
      const exited = children.map(
        (child) => new Promise((done) => child.once("exit", done)),
      );
      writeFileSync(go, "");
      await until(
        () =>
          readdirSync(won).filter((name) => name.startsWith("tried-"))
            .length === contenders,
        "not every contender tried the lock",
      );
      winners.push(
        readdirSync(won).filter((name) => !name.startsWith("tried-")).length,
      );
      writeFileSync(done, "");
      await Promise.all(exited);
    }
    expect(winners).toEqual(Array.from({ length: rounds }, () => 1));
  }, 120_000);

  it("takes over a lock whose process is gone", () => {
    const path = join(scratch(), "run.lock");
    writeFileSync(path, lockOf(999_999_999, thisBoot()));
    expect(holder(path)).toBeUndefined();
    const taken = takeLock(path);
    expect(held(taken)).toBe(true);
    expect(holder(path)).toBe(process.pid);
  });

  it("takes over a lock written in another boot, though a live process now has its ID", () => {
    const path = join(scratch(), "run.lock");
    const boot = thisBoot();
    const before = typeof boot === "number" ? boot - 3_600_000 : "another-boot";
    // This test's own process stands for the process that reused the ID.
    writeFileSync(path, lockOf(process.pid, before));
    expect(holder(path)).toBeUndefined();
    expect(held(takeLock(path))).toBe(true);
    // The witness: the same live process, written in this boot, holds it.
    const other = join(scratch(), "run.lock");
    writeFileSync(other, lockOf(process.pid, boot));
    expect(holder(other)).toBe(process.pid);
    expect(takeLock(other)).toEqual({ holder: process.pid });
  });

  it("stays held by a live process of this boot when the wall clock is stepped by minutes", () => {
    const path = join(scratch(), "run.lock");
    const taken = takeLock(path);
    if (!("lock" in taken)) throw new Error("not taken");
    for (const step of [-30 * 60_000, -2 * 60_000, 2 * 60_000, 30 * 60_000]) {
      const stepped = (): number => Date.now() + step;
      expect([step, holder(path, stepped)]).toEqual([step, process.pid]);
      expect([step, takeLock(path, stepped)]).toEqual([
        step,
        { holder: process.pid },
      ]);
    }
    taken.lock.release();
  });

  it("treats an empty or partial lock as held for a few seconds, then takes it over", () => {
    for (const text of ["", '{"pid":'])
      for (const age of [0, 60]) {
        const path = join(scratch(), "run.lock");
        writeFileSync(path, text);
        const at = new Date(Date.now() - age * 1000);
        utimesSync(path, at, at);
        const taken = takeLock(path);
        expect([text, age, held(taken)]).toEqual([text, age, age > 0]);
        if (!held(taken)) expect(taken).toEqual({ holder: undefined });
      }
  });

  it("releases only its own lock", () => {
    const path = join(scratch(), "run.lock");
    const taken = takeLock(path);
    if (!("lock" in taken)) throw new Error("not taken");
    writeFileSync(path, lockOf(process.pid + 1, thisBoot()));
    taken.lock.release();
    expect(existsSync(path)).toBe(true);
    // The witness: its own lock it releases.
    const again = join(scratch(), "run.lock");
    const mine = takeLock(again);
    if (!("lock" in mine)) throw new Error("not taken");
    mine.lock.release();
    expect(existsSync(again)).toBe(false);
  });
});
