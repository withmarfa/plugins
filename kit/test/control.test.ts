import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exitCode } from "../src/exit.js";
import { start } from "./installed.js";
import { Harness, testConnector, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const minute = 60_000;
const entry = { source_id: "a:1", properties: { title: "One" } };
const asked = "2026-09-25T08:59:00.000Z";

/** Waits until a condition holds, letting the connector's own work go on. */
async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 2000 && !done(); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done()).toBe(true);
}

describe("a connector the owner paused", () => {
  it("does not run, reports nothing and exits 0 saying so; resumed, it runs", async () => {
    const held = vendor([entry]);
    harness.server.control.paused = true;
    const code = await harness.once(held);
    expect(code).toBe(exitCode.stopped);
    expect(held.runs).toBe(0);
    expect(harness.server.rows).toEqual([]);
    expect(harness.server.runs).toEqual([]);
    expect(harness.lines.join("\n")).toContain("owner paused this connector");

    harness.server.control.paused = false;
    expect(await harness.once(held)).toBe(exitCode.stopped);
    expect(held.runs).toBe(1);
    expect(harness.server.rows).toHaveLength(1);
    expect(harness.lastRun().outcome).toBe("succeeded");
  });

  it("skips each scheduled run while paused, and runs again the interval after it is resumed", async () => {
    const held = vendor([entry]);
    harness.server.control.paused = true;
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(0);
    harness.server.control.paused = false;
    await harness.clock.wake(15 * minute);
    await until(() => held.runs === 1);
    harness.stop();
    expect(await exit).toBe(exitCode.stopped);
    expect(harness.server.runs.map((run) => run.outcome)).toEqual([
      "succeeded",
    ]);
  });
});

describe("run now", () => {
  it("wakes the schedule at once, and the run's report names the request it acted on, which clears it", async () => {
    const held = vendor([entry]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(1);
    expect(harness.server.runs[0]?.run_requested_at).toBeUndefined();

    harness.server.control.run_requested_at = asked;
    harness.wake();
    await until(() => held.runs === 2);
    await until(() => harness.server.runs.length === 2);
    expect(harness.server.runs[1]?.run_requested_at).toBe(asked);
    expect(harness.server.control.run_requested_at).toBeNull();
    harness.stop();
    expect(await exit).toBe(exitCode.stopped);
  });

  it("names a request a scheduled run found set, and a run that found none names none", async () => {
    const held = vendor([entry]);
    harness.server.control.run_requested_at = asked;
    expect(await harness.once(held)).toBe(exitCode.stopped);
    expect(harness.lastRun().run_requested_at).toBe(asked);
    expect(harness.server.control.run_requested_at).toBeNull();

    expect(await harness.once(held)).toBe(exitCode.stopped);
    expect(harness.lastRun()).not.toHaveProperty("run_requested_at");
  });

  it("never names a request made after the run read the owner's choices", async () => {
    const held = vendor();
    held.read = async () => {
      harness.server.control.run_requested_at = asked;
      await Promise.resolve();
    };
    expect(await harness.once(held)).toBe(exitCode.stopped);
    expect(harness.lastRun()).not.toHaveProperty("run_requested_at");
    expect(harness.server.control.run_requested_at).toBe(asked);
  });

  it("runs once more, not twice, for requests that arrive during a run", async () => {
    const held = vendor([entry]);
    let release = (): void => undefined;
    held.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await until(() => held.runs === 1);
    harness.wake();
    harness.wake();
    harness.wake();
    release();
    await until(() => held.runs === 2);
    await harness.clock.sleeping(15 * minute);
    // Nothing more is waiting: the connector is asleep again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held.runs).toBe(2);
    harness.stop();
    expect(await exit).toBe(exitCode.stopped);
  });
});

describe("the owner's choices that cannot be read", () => {
  it("runs as scheduled, saying so once however many runs it makes", async () => {
    const held = vendor([entry]);
    harness.server.controlRefusal = { status: 500, code: "internal_error" };
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    await harness.clock.wake(15 * minute);
    await until(() => held.runs === 2);
    harness.stop();
    expect(await exit).toBe(exitCode.stopped);
    const said = harness.lines.filter((line) =>
      line.includes("could not be read, so it runs as scheduled"),
    );
    expect(said).toHaveLength(1);
    expect(harness.server.controlReads).toBe(2);
  });

  it("reads the door no more once Marfa says no plugin's connector holds the key", async () => {
    const held = vendor([entry]);
    harness.server.controlRefusal = {
      status: 403,
      code: "forbidden",
    };
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    await harness.clock.wake(15 * minute);
    await until(() => held.runs === 2);
    harness.stop();
    expect(await exit).toBe(exitCode.stopped);
    expect(harness.server.controlReads).toBe(1);
    expect(harness.lines.join("\n")).not.toContain("runs as scheduled");
  });
});
