import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "./installed.js";
import type { Setting, SettingsDeclaration } from "../src/define.js";
import {
  Harness,
  linkedType,
  testConnector,
  testSettings,
  twoWayConnector,
  vendor,
} from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = {
  source_id: "a:1",
  properties: { title: "One", vendor_id: "v1" },
};

async function until(holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("the look between runs, for a connector that carries changes back", () => {
  it("carries an edit made in Marfa within a look, not at the next schedule", async () => {
    const held = vendor([one]);
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    harness.server.edit(harness.server.row("a:1").id, { title: "Edited" });
    await harness.clock.wake(10_000);
    await until(() => held.changes.length === 1);
    expect(held.runs).toBe(2);
    expect(held.changes[0]?.item.properties["title"]).toBe("Edited");
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("takes a run when the look finds a type of the connector's gone, so the connector starts again and stops on the plugin not installed", async () => {
    const held = vendor([one]);
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    harness.server.types.delete("test.entry");
    await harness.clock.wake(10_000);
    expect(await exit).toBe(1);
    expect(harness.lastRun().error).toContain("the type test.entry");
    expect(harness.lastRun().error).toContain("marfa plugins install test");
    expect(harness.server.requestsTo("POST", "/types")).toEqual([]);
  });

  it("starts no run for the connector's own writes", async () => {
    const held = vendor([one]);
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    for (let look = 0; look < 3; look += 1) {
      await harness.clock.wake(10_000);
      await harness.clock.sleeping(10_000);
    }
    expect(held.runs).toBe(1);
    harness.server.edit(harness.server.row("a:1").id, { title: "Edited" });
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("starts no run for the purge of a row the vendor was never told about", async () => {
    const held = vendor([one]);
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    harness.server.trash(theirs.id);
    harness.server.purgeById(theirs.id);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("starts no run for a trash another row's trash made, nor for its purge", async () => {
    const held = vendor([one]);
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    const row = harness.server.row("a:1");
    harness.server.cascadeTrash(row.id, "root-1");
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    harness.server.purgeById(row.id);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    held.entries = [];
    harness.server.insert(
      "a:2",
      { title: "Two", vendor_id: "v2" },
      "test.entry",
    );
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    harness.server.trash(harness.server.row("a:2").id);
    harness.server.purge("a:2");
    await harness.clock.wake(10_000);
    await until(() => held.runs === 3);
    harness.stop();
    expect(await exit).toBe(0);
  });
});

describe("the look between runs, for what Marfa mirrors", () => {
  it("puts back an edit to a kind that only reads within a look, and names it", async () => {
    const held = vendor([one]);
    const exit = harness.inbound(held, [
      "--every",
      "1h",
      "--look-every",
      "10s",
    ]);
    await harness.clock.sleeping(10_000);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "Edited" });
    await harness.clock.wake(10_000);
    await until(() => harness.server.runs.length === 2);
    expect(harness.server.row("a:1").properties["title"]).toBe("One");
    expect(harness.lastRun().summary).toContain(
      `title on ${row.id} was changed in Marfa and put back`,
    );
    for (let look = 0; look < 3; look += 1) {
      await harness.clock.sleeping(10_000);
      await harness.clock.wake(10_000);
    }
    await harness.clock.sleeping(10_000);
    expect(harness.server.runs.length).toBe(2);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("puts back an edit to a read-only field of a two-way kind within a look", async () => {
    const held = vendor([one]);
    held.readOnly = ["title"];
    const exit = harness.twoWayRunning(held, ["--every", "1h"]);
    await harness.clock.sleeping(10_000);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "Edited" });
    await harness.clock.wake(10_000);
    await until(() => harness.server.runs.length === 2);
    expect(harness.server.row("a:1").properties["title"]).toBe("One");
    expect(harness.lastRun().summary).toContain(
      `title on ${row.id} was changed in Marfa and put back`,
    );
    expect(held.changes).toEqual([]);
    harness.stop();
    expect(await exit).toBe(0);
  });
});

describe("the look, for connections", () => {
  const blocks = {
    id: "test.blocks",
    cardinality: "many-to-many" as const,
    from_type_constraints: ["test.entry"],
    to_type_constraints: ["test.entry"],
  };

  function blocking(
    cardinality: "many-to-many" | "many-to-one" = "many-to-many",
  ): ReturnType<typeof vendor> {
    const held = vendor([
      {
        source_id: "a:1",
        properties: { title: "One", vendor_id: "v1" },
        connections: { "test.blocks": [{ type: "test.entry", id: "v2" }] },
      },
      { source_id: "a:2", properties: { title: "Two", vendor_id: "v2" } },
    ]);
    held.connections = [{ ...blocks, cardinality }];
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
    };
    return held;
  }

  it("starts no run for its own edge frame whose target was purged since", async () => {
    const held = blocking();
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    const two = harness.server.row("a:2");
    harness.server.cascadeTrash(two.id, "root-1");
    harness.server.purgeById(two.id);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    harness.server.insert(
      "a:3",
      { title: "Three", vendor_id: "v3" },
      "test.entry",
    );
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await harness.clock.sleeping(10_000);
    harness.server.drawEdge(
      harness.server.row("a:1").id,
      harness.server.row("a:3").id,
      "test.blocks",
    );
    await harness.clock.wake(10_000);
    await until(() => held.runs === 3);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("starts no run for its own writes to a row waiting on a target Marfa lacks", async () => {
    const held = vendor([
      {
        source_id: "a:1",
        properties: { title: "One", vendor_id: "v1" },
        connections: { "test.blocks": [{ type: "test.entry", id: "v3" }] },
      },
    ]);
    held.connections = [blocks];
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
    };
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    for (let look = 0; look < 3; look += 1) {
      await harness.clock.wake(10_000);
      await harness.clock.sleeping(10_000);
    }
    expect(held.runs).toBe(1);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("starts no run for a person's connection to a row of their own, and one for a connection to the connector's", async () => {
    const held = vendor([
      {
        source_id: "a:1",
        properties: { title: "One", vendor_id: "v1" },
        connections: { "attached-to": [] },
      },
      {
        source_id: "a:2",
        properties: { title: "Two", vendor_id: "v2" },
        connections: { "attached-to": [] },
      },
    ]);
    held.connections = [
      {
        id: "attached-to",
        cardinality: "many-to-many",
        cascade_on_delete: "with-hosts",
        from_type_constraints: ["test.entry"],
        to_type_constraints: ["test.entry"],
      },
    ];
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "attached-to": "write" },
    };
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    const one = harness.server.row("a:1");
    const note = harness.server.insert(
      undefined,
      { body: "mine" },
      "core.note",
      "person",
    );
    harness.server.drawEdge(one.id, note.id, "attached-to");
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    harness.server.drawEdge(
      one.id,
      harness.server.row("a:2").id,
      "attached-to",
    );
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("starts no run for a change to an edge's properties, and one for its move to another row", async () => {
    // Only the end that stays holding one edge of the type lets the other move.
    const held = blocking("many-to-one");
    held.entries.push({
      source_id: "a:3",
      properties: { title: "Three", vendor_id: "v3" },
    });
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    const edge = harness.server.edges[0];
    if (edge === undefined) throw new Error("no edge");
    harness.server.updateEdge(edge.id, { properties: { note: "by a person" } });
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    harness.server.updateEdge(edge.id, {
      to_id: harness.server.row("a:3").id,
    });
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await until(() => held.changes.length === 1);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("reads nothing for connections a purge took", async () => {
    const held = blocking();
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    const two = harness.server.row("a:2");
    harness.server.cascadeTrash(two.id, "root-1");
    harness.server.purgeById(two.id);
    const reads = harness.server.requestsTo("POST", "/items/lookup").length;
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    expect(harness.server.requestsTo("POST", "/items/lookup").length).toBe(
      reads,
    );
    harness.stop();
    expect(await exit).toBe(0);
  });
});

describe("--look-every", () => {
  it("is refused for a connector that neither receives webhooks nor carries changes back", async () => {
    harness.server.installs = false;
    expect(
      await start(
        testConnector(vendor([])),
        harness.runtime(["--every", "15m", "--look-every", "30s"]),
      ),
    ).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "--look-every is for a connector that receives webhooks or carries changes back",
    );
    expect(harness.server.requests).toEqual([]);
    harness.server.installs = true;
    const held = vendor([]);
    const exit = harness.twoWayRunning(held, [
      "--every",
      "15m",
      "--look-every",
      "30s",
    ]);
    await harness.clock.sleeping(30_000);
    harness.stop();
    expect(await exit).toBe(0);
  });
});

describe("--look-every, for a connector whose carry-back depends on a setting", () => {
  const args = ["--every", "15m", "--look-every", "30s"];

  /** The two-way connector, carrying back only where `carry` is on. */
  function carryingOn(setting: Setting, carried: (value: unknown) => boolean) {
    return (values: Record<string, unknown>) => ({
      ...twoWayConnector(vendor([])),
      settings: [...testSettings, setting] as SettingsDeclaration,
      carries: () => (carried(values[setting.name]) ? [linkedType.id] : []),
    });
  }

  async function started(
    definition: ReturnType<typeof carryingOn>,
    widest: Record<string, unknown> = {},
  ): Promise<number> {
    const exit = start(
      definition as never,
      harness.runtime(args),
      widest as never,
    );
    const early = await Promise.race([
      exit,
      harness.clock.sleeping(30_000).then(() => undefined),
    ]);
    if (early !== undefined) return early;
    harness.stop();
    return exit;
  }

  const refusal =
    "--look-every is for a connector that receives webhooks or carries changes back";
  const flag = (extra: Partial<Setting>): Setting => ({
    name: "carry",
    label: "Carry",
    kind: "boolean",
    ...extra,
  });

  it("accepts a connector whose default turns the carry-back on, though its widest does not name the setting", async () => {
    const exit = await started(
      carryingOn(flag({ default: true }), (value) => value === true),
    );
    expect(exit, harness.lines.join("\n")).toBe(0);
  });

  it("refuses the same connector with the default off, as the witness", async () => {
    const exit = await started(
      carryingOn(flag({ default: false }), (value) => value === true),
    );
    expect(exit).toBe(2);
    expect(harness.lines.join("\n")).toContain(refusal);
  });

  it("refuses a connector whose setting has no default and whose widest does not name it", async () => {
    const exit = await started(carryingOn(flag({}), (value) => value === true));
    expect(exit).toBe(2);
    expect(harness.lines.join("\n")).toContain(refusal);
  });

  it("lets the widest settings win over the default", async () => {
    const definition = carryingOn(
      flag({ default: false }),
      (value) => value === true,
    );
    harness.server.settings = { ...harness.server.settings, carry: true };
    expect(
      await started(definition, { carry: true }),
      harness.lines.join("\n"),
    ).toBe(0);
  });

  it("reads a choice setting's default as a run does", async () => {
    const choice = (value: string): Setting => ({
      name: "mode",
      label: "Mode",
      kind: "choice",
      choices: ["read", "both"],
      default: value,
    });
    expect(
      await started(carryingOn(choice("both"), (value) => value === "both")),
      harness.lines.join("\n"),
    ).toBe(0);
    harness.lines.length = 0;
    expect(
      await started(carryingOn(choice("read"), (value) => value === "both")),
    ).toBe(2);
    expect(harness.lines.join("\n")).toContain(refusal);
  });
});
