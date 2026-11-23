import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionDefinition, Entry } from "../src/define.js";
import { start } from "./installed.js";
import {
  Harness,
  linkedType,
  testConnector,
  testType,
  vendor,
  type Vendor,
} from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
  harness.server.types.set(linkedType.id, { ...linkedType });
  // A target type the owner holds, as the Tickets plugin installs one: no
  // link field of its own, and no `link` field.
  harness.server.installType({
    id: "common.ticket",
    label: "Ticket",
    fields: { title: { type: "string" }, note: { type: "string" } },
  });
  harness.server.installType({
    id: "common.ticket.task",
    label: "Task",
    parent: "common.ticket",
    fields: {},
  });
});
afterEach(async () => {
  await harness.close();
});

const target = "common.ticket.task";

function mapTo(
  type: string,
  options: { version?: number; tier?: "feed" | "library" } = {},
): void {
  harness.server.mapping.version = options.version ?? 1;
  harness.server.mapping.kinds["entry"] = {
    enabled: true,
    target_type: type,
    tier: options.tier ?? "feed",
  };
}

function turnOff(version = 2): void {
  harness.server.mapping.version = version;
  harness.server.mapping.kinds["entry"] = { enabled: false };
}

const one: Entry = {
  source_id: "a:1",
  properties: {
    title: "One",
    note: "first",
    link: "https://vendor.test/1",
    vendor_id: "v1",
  },
};
const two: Entry = {
  source_id: "a:2",
  properties: { title: "Two", vendor_id: "v2" },
};

function creates(): Record<string, unknown>[] {
  return harness.server
    .requestsTo("POST", "/items/bulk")
    .flatMap(
      (request) => (request.body as { items: Record<string, unknown>[] }).items,
    );
}

async function quiet(held: Vendor): Promise<number> {
  held.changes.length = 0;
  return harness.twoWay(held);
}

describe("a kind mapped onto another type", () => {
  it("is written as that type under the connector's source, and found again by the next run, not made twice", async () => {
    mapTo(target);
    const held = vendor([one, two]);
    expect(await harness.twoWay(held), harness.lines.join("\n")).toBe(0);
    const first = harness.server.row("a:1");
    expect(first.type).toBe(target);
    expect(first.source).toBe("test");
    // The link is kept as a property; a field the target lacks is left out.
    expect(first.properties).toEqual({
      title: "One",
      note: "first",
      vendor_id: "v1",
    });
    expect(harness.lastRun().summary).toContain(
      `the kind entry lands on ${target} without link`,
    );

    held.entries = [{ ...one, properties: { ...one.properties, title: "1" } }];
    expect(await quiet(held)).toBe(0);
    expect(harness.server.rows).toHaveLength(2);
    expect(harness.server.row("a:1").properties["title"]).toBe("1");
    expect(harness.server.row("a:1").id).toBe(first.id);
    // The log is followed on the target, and on the kind's own type, which
    // keeps what it wrote before the mapping until a rewrite moves it.
    for (const request of harness.server.requestsTo("GET", "/events"))
      expect(request.query.get("type")).toBe(`${target},${linkedType.id}`);
  });

  it("keeps writing a row it wrote before the mapping where it is, and makes no twin of it on the target", async () => {
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    const before = harness.server.row("a:1");
    mapTo(target);
    held.entries = [
      { ...one, properties: { ...one.properties, title: "1" } },
      two,
    ];
    expect(await quiet(held), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rows).toHaveLength(2);
    const after = harness.server.row("a:1");
    expect([after.id, after.type, after.properties["title"]]).toEqual([
      before.id,
      linkedType.id,
      "1",
    ]);
    expect(harness.server.row("a:2").type).toBe(target);
  });

  it("carries a change made in Marfa back, named by the connector's own type with its link", async () => {
    mapTo(target);
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(await quiet(held)).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.type).toBe(target);
    harness.server.edit(row.id, { title: "One, by a person" });
    expect(await quiet(held), harness.lines.join("\n")).toBe(0);
    expect(held.changes).toHaveLength(1);
    const [change] = held.changes;
    expect(change?.kind).toBe("updated");
    expect(change?.item.type).toBe(linkedType.id);
    expect(change?.item.properties["vendor_id"]).toBe("v1");
    expect([...(change?.changed ?? [])]).toEqual(["title"]);
  });

  it("settles a purge in Marfa by the natural key, never by the link", async () => {
    mapTo(target);
    const held = vendor([one]);
    held.answer = (change) =>
      change.kind === "purged"
        ? {
            source_id: "a:1",
            properties: {},
            changed_at: "2026-09-26T00:00:00.000Z",
          }
        : undefined;
    expect(await harness.twoWay(held)).toBe(0);
    expect(await quiet(held)).toBe(0);
    harness.server.purge("a:1");
    held.entries = [];
    expect(await quiet(held), harness.lines.join("\n")).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["purged"]);
    const settled = harness.server
      .requestsTo("POST", "/items/tombstones")
      .map((request) => request.body as Record<string, unknown>);
    const onTarget = settled.filter((body) => body["type"] === target);
    expect(onTarget.length).toBeGreaterThan(0);
    for (const body of onTarget) {
      expect(body).not.toHaveProperty("links");
      expect(body["source_ids"]).toEqual(["a:1"]);
    }
  });

  it("names no tier on a create, and the server gives the tier the mapping chose", async () => {
    mapTo(target, { tier: "library" });
    expect(await harness.twoWay(vendor([one]))).toBe(0);
    expect(harness.server.row("a:1").tier).toBe("library");
    expect(creates().length).toBeGreaterThan(0);
    for (const item of creates()) expect(item).not.toHaveProperty("tier");
  });

  it("stops the kind alone, with a condition, where the target type is gone", async () => {
    mapTo("common.gone");
    expect(await harness.twoWay(vendor([one]))).toBe(0);
    expect(harness.server.rows).toEqual([]);
    expect(harness.problems()["mapping-target:entry"]).toContain(
      "common.gone, which the instance does not hold",
    );
  });
});

describe("a kind turned off", () => {
  it("writes nothing and leaves its rows alone, then takes up again once on", async () => {
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    const before = structuredClone(harness.server.row("a:1"));
    turnOff();
    held.entries = [{ ...one, properties: { ...one.properties, title: "1" } }];
    held.archived = ["v1"];
    const writes = (): number =>
      harness.server.requestsTo("POST", "/items/bulk").length +
      harness.server.requests.filter((request) => request.method === "PATCH")
        .length;
    const sent = writes();
    expect(await quiet(held), harness.lines.join("\n")).toBe(0);
    expect(writes()).toBe(sent);
    expect(harness.server.row("a:1")).toEqual(before);

    harness.server.mapping.version = 3;
    delete harness.server.mapping.kinds["entry"];
    held.archived = [];
    expect(await quiet(held)).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe("1");
  });

  it("keeps a change made in Marfa while it is off, and carries it once it is on again", async () => {
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(await quiet(held)).toBe(0);
    turnOff();
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });
    expect(await quiet(held)).toBe(0);
    expect(held.changes).toEqual([]);

    harness.server.mapping.version = 3;
    delete harness.server.mapping.kinds["entry"];
    expect(await quiet(held), harness.lines.join("\n")).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
    expect(held.changes[0]?.item.properties["title"]).toBe("One, by a person");
  });
});

describe("a rewrite the owner asks for", () => {
  it("moves the kind's rows to its target and is cleared by number, and one left unfinished is not cleared", async () => {
    const held = vendor([one, two]);
    expect(await harness.twoWay(held)).toBe(0);
    const [a, b] = [harness.server.row("a:1"), harness.server.row("a:2")];
    mapTo(target);
    harness.server.mapping.rewrites = [
      {
        number: 3,
        version: 1,
        kinds: ["entry"],
        requested_at: "2026-09-25T09:00:00.000Z",
      },
    ];
    harness.server.refuseWhere(
      "PATCH /items/" + b.id,
      () => true,
      400,
      "invalid_properties",
    );
    held.entries = [];
    expect(await quiet(held)).toBe(0);
    expect(harness.server.byId(a.id).type).toBe(target);
    expect(harness.server.byId(a.id).properties).not.toHaveProperty("link");
    expect(harness.server.byId(b.id).type).toBe(linkedType.id);
    expect(harness.server.rewritesDone).toEqual([]);
    expect(harness.problems()["rewrite:3"]).toContain(b.id);

    harness.server.stopRefusing();
    expect(await quiet(held)).toBe(0);
    expect(harness.server.byId(b.id).type).toBe(target);
    expect(harness.server.rewritesDone).toEqual([3]);
    expect(harness.problems()).not.toHaveProperty("rewrite:3");
  });
  it("is not cleared while a kind it names is turned off, and is carried out once the kind is on again", async () => {
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    const a = harness.server.row("a:1");
    turnOff(1);
    harness.server.mapping.rewrites = [
      {
        number: 4,
        version: 1,
        kinds: ["entry"],
        requested_at: "2026-09-25T09:00:00.000Z",
      },
    ];
    expect(await quiet(held)).toBe(0);
    expect(harness.server.byId(a.id).type).toBe(linkedType.id);
    expect(harness.server.rewritesDone).toEqual([]);
    expect(harness.problems()["rewrite:4"]).toContain("turned off");

    mapTo(target, { version: 2 });
    expect(await quiet(held)).toBe(0);
    expect(harness.server.byId(a.id).type).toBe(target);
    expect(harness.server.rewritesDone).toEqual([4]);
    expect(harness.problems()).not.toHaveProperty("rewrite:4");
  });
});

describe("a rewrite back from a former target", () => {
  /** Both rows written, then mapped onto the target and rewritten there,
   *  then mapped back to the kind's own type with a second rewrite asked. */
  async function mappedBack(held: Vendor): Promise<string[]> {
    expect(await harness.twoWay(held)).toBe(0);
    const ids = [harness.server.row("a:1").id, harness.server.row("a:2").id];
    mapTo(target);
    harness.server.mapping.rewrites = [
      {
        number: 1,
        version: 1,
        kinds: ["entry"],
        requested_at: "2026-09-25T09:00:00.000Z",
      },
    ];
    expect(await quiet(held)).toBe(0);
    for (const id of ids) expect(harness.server.byId(id).type).toBe(target);
    mapTo(linkedType.id, { version: 2 });
    harness.server.mapping.rewrites = [
      {
        number: 2,
        version: 2,
        kinds: ["entry"],
        requested_at: "2026-09-25T10:00:00.000Z",
      },
    ];
    return ids;
  }

  it("keeps the request open and fails the run, naming the kind and the former type, where Marfa does not let the key reach it", async () => {
    const held = vendor([one, two]);
    const ids = await mappedBack(held);
    expect(await quiet(held)).not.toBe(0);
    for (const id of ids) expect(harness.server.byId(id).type).toBe(target);
    expect(harness.server.rewritesDone).toEqual([1]);
    const run = harness.lastRun();
    expect(run.outcome).toBe("failed");
    expect(run.error).toContain(`the kind entry`);
    expect(run.error).toContain(target);
    expect(run.error).toContain("Marfa must let");
    expect(run.error).toContain(
      `the rewrite 2 of entry stays open and this run does not start: the kind entry's rows on ${target} cannot be moved to ${linkedType.id}`,
    );
  });

  it("moves the rows back from the former target and clears the request where Marfa lets the key reach it", async () => {
    const held = vendor([one, two]);
    const ids = await mappedBack(held);
    harness.server.formerReach.add(target);
    expect(await quiet(held), harness.lines.join("\n")).toBe(0);
    for (const id of ids)
      expect(harness.server.byId(id).type).toBe(linkedType.id);
    expect(harness.server.rewritesDone).toEqual([1, 2]);
    expect(harness.lastRun().outcome).toBe("succeeded");
  });

  it("moves the rows onto a third type from every type they were on", async () => {
    harness.server.installType({
      id: "common.ticket.bug",
      label: "Bug",
      parent: "common.ticket",
      fields: {},
    });
    const held = vendor([one, two]);
    const ids = await mappedBack(held);
    mapTo("common.ticket.bug", { version: 2 });
    harness.server.formerReach.add(target);
    expect(await quiet(held), harness.lines.join("\n")).toBe(0);
    for (const id of ids)
      expect(harness.server.byId(id).type).toBe("common.ticket.bug");
    expect(harness.server.rewritesDone).toEqual([1, 2]);
  });

  it("fails a run whose every write is refused because its rows are out of the key's reach", async () => {
    const held = vendor([one, two]);
    await mappedBack(held);
    harness.server.mapping.rewrites = [];
    held.entries = [
      { ...one, properties: { ...one.properties, title: "1" } },
      { ...two, properties: { ...two.properties, title: "2" } },
    ];
    expect(await quiet(held)).not.toBe(0);
    expect(harness.lastRun().outcome).toBe("failed");
  });
});

describe("the mapping's read", () => {
  it("falls back to the mapping the last run kept, and says so, where Marfa does not answer it", async () => {
    mapTo(target);
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    harness.server.refuseNext(
      "GET /plugins/test/connector/mapping",
      503,
      "unavailable",
    );
    held.entries = [two];
    expect(await quiet(held)).toBe(0);
    expect(harness.server.row("a:2").type).toBe(target);
    expect(harness.problems()["mapping-unread"]).toContain(
      "applies version 1, the last one read",
    );
  });

  it("takes every kind to land on its own type where the key is no plugin connector's, which has no mapping", async () => {
    for (const [status, code] of [
      [404, "plugin_not_found"],
      [403, "forbidden"],
    ] as const) {
      harness.server.refuseNext(
        "GET /plugins/test/connector/mapping",
        status,
        code,
      );
      expect(await harness.twoWay(vendor([one]))).toBe(0);
      expect(harness.server.row("a:1").type).toBe(linkedType.id);
      expect(harness.problems()).not.toHaveProperty("mapping-unread");
    }
  });

  it("applies the kept mapping, says so and keeps it, where the read is refused for another reason", async () => {
    mapTo(target);
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    for (const [status, code] of [
      [404, "not_found"],
      [400, "validation_error"],
    ] as const) {
      harness.server.refuseNext(
        "GET /plugins/test/connector/mapping",
        status,
        code,
      );
      held.entries = [one, two];
      expect(await quiet(held)).toBe(0);
      expect(harness.server.row("a:2").type).toBe(target);
      expect(harness.problems()["mapping-unread"]).toContain(
        "applies version 1, the last one read",
      );
    }
  });

  it("stops the run and keeps the mapping where a run kept one and the read now says no plugin holds the key", async () => {
    mapTo(target);
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    for (const [status, code] of [
      [404, "plugin_not_found"],
      [403, "forbidden"],
    ] as const) {
      harness.server.refuseNext(
        "GET /plugins/test/connector/mapping",
        status,
        code,
      );
      held.entries = [one, two];
      expect(await quiet(held)).toBe(1);
      expect(harness.server.rows.map((row) => row.source_id)).toEqual(["a:1"]);
    }
    // The kept mapping still stands for a read Marfa does not answer.
    harness.server.refuseNext(
      "GET /plugins/test/connector/mapping",
      503,
      "unavailable",
    );
    expect(await quiet(held)).toBe(0);
    expect(harness.server.row("a:2").type).toBe(target);
    expect(harness.problems()["mapping-unread"]).toContain(
      "applies version 1, the last one read",
    );
  });

  it("starts no run where Marfa does not answer it and no run kept one", async () => {
    harness.server.refuseNext(
      "GET /plugins/test/connector/mapping",
      503,
      "unavailable",
    );
    expect(await harness.twoWay(vendor([one]))).toBe(1);
    expect(harness.server.rows).toEqual([]);
  });
});

describe("the read-only types", () => {
  it("are registered as the targets, and again when the mapping's version changes", async () => {
    harness.server.types.set(testType.id, { ...testType });
    expect(await harness.once(vendor([one]))).toBe(0);
    expect(harness.server.readOnlyTypes).toEqual(["test.entry"]);
    const registered = harness.server.registrations;
    mapTo(target, { version: 1 });
    expect(await harness.once(vendor([one]))).toBe(0);
    expect(harness.server.readOnlyTypes).toEqual([target]);
    expect(harness.server.registrations).toBeGreaterThan(registered);

    // A process that runs on registers again on a new version, whatever it
    // changed, and not on a run that reads the same one.
    const minute = 60_000;
    const held = vendor([one]);
    const running = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    const runs: number[] = [];
    for (const version of [1, 2, 2]) {
      await harness.clock.sleeping(15 * minute);
      runs.push(harness.server.registrations);
      harness.server.mapping.version = version;
      await harness.clock.wake(15 * minute);
    }
    await harness.clock.sleeping(15 * minute);
    runs.push(harness.server.registrations);
    harness.stop();
    expect(await running).toBe(0);
    // The first run of a process registers its targets; the version moves
    // to 2 before the third.
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe((runs[1] ?? 0) + 1);
    expect(runs[3]).toBe(runs[2]);
  });
});

describe("a connection after a mapping", () => {
  const blocks: ConnectionDefinition = {
    id: "test.blocks",
    cardinality: "many-to-many",
    from_type_constraints: ["test.entry"],
    to_type_constraints: ["test.entry"],
  };

  it("is skipped with one condition naming the edge type and the kind where its ends no longer fit", async () => {
    mapTo(target);
    const held = vendor([
      {
        ...one,
        connections: { "test.blocks": [{ type: "test.entry", id: "v2" }] },
      },
      two,
    ]);
    held.connections = [blocks];
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
    };
    expect(await harness.twoWay(held), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rows).toHaveLength(2);
    expect(harness.server.edges).toEqual([]);
    expect(
      harness.problems()["mapping-connection:entry:test.blocks"],
    ).toContain("which the edge type test.blocks does not take");
  });
});
