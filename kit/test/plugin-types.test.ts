import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "./installed.js";
import {
  Harness,
  linkedType,
  testConnector,
  testFields,
  testType,
  vendor,
  type Vendor,
} from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const minute = 60_000;

const entry = {
  source_id: "a:1",
  properties: { title: "One", note: "From the vendor" },
};

const differ = "the installed plugin's types differ from this build";
const update = "marfa plugins install test";

/** The type as an older build of the plugin held it, before it gained `note`
 *  and `link`. */
function older(more: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...testType,
    fields: {
      title: { type: "string", required: true },
      vendor_id: { type: "string" },
    },
    ...more,
  };
}

/** Every request that would register or change a type or an edge type. */
function registrations(): string[] {
  return harness.server.requests
    .filter(
      ({ method, path }) =>
        (method === "POST" && path === "/types") ||
        (method === "PUT" && path.startsWith("/types/")) ||
        (method !== "GET" && path.startsWith("/edge-types")),
    )
    .map(({ method, path }) => `${method} ${path}`);
}

const blocks = {
  id: "test.blocks",
  cardinality: "many-to-many" as const,
  from_type_constraints: ["test.entry"],
  to_type_constraints: ["test.entry"],
};

function connecting(): Vendor {
  const held = vendor([entry]);
  held.connections = [blocks];
  return held;
}

describe("a start on the types a plugin install holds", () => {
  it("runs on a key holding no metadata entry, and registers nothing", async () => {
    const held = vendor([entry]);
    expect(await harness.once(held)).toBe(0);
    expect(held.runs).toBe(1);
    expect(harness.server.rows[0]?.properties["note"]).toBe("From the vendor");
    expect(harness.lastRun().outcome).toBe("succeeded");
    expect(harness.problems()).toEqual({});
    expect(registrations()).toEqual([]);
    expect(
      harness.server.requestsTo("POST", "/types/normalize").length,
    ).toBeGreaterThan(0);
  });

  it("counts a registration a test sends itself, so none above is a missed one", async () => {
    await fetch(`${harness.server.url}/types`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.server.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(testType),
    });
    expect(registrations()).toEqual(["POST /types"]);
  });

  it("runs with its connection type installed, and registers nothing", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
    };
    const held = connecting();
    expect(await harness.once(held)).toBe(0);
    expect(harness.lastRun().outcome).toBe("succeeded");
    expect(registrations()).toEqual([]);
  });

  it("refuses a key holding a metadata entry for types or edge types, which a connector's key no longer needs", async () => {
    for (const level of [
      { types: "write" },
      { edge_types: "write" },
      { types: "read" },
    ]) {
      harness.server.grants = {
        type_permissions: { "test.entry": "write" },
        metadata_permissions: level,
      };
      const held = vendor([entry]);
      expect(await harness.once(held)).toBe(3);
      const [name = "", value = ""] = Object.entries(level)[0] ?? [];
      expect(harness.lastRun().error).toContain(
        `is refused: metadata ${name}=${value}`,
      );
      expect(held.runs).toBe(0);
    }
    expect(harness.server.rows).toEqual([]);
    expect(registrations()).toEqual([]);
  });
});

describe("a start where the plugin is not installed", () => {
  it("stops with one condition and registers nothing", async () => {
    harness.server.installs = false;
    const held = vendor([entry]);
    expect(await harness.once(held)).toBe(1);
    expect(held.runs).toBe(0);
    const error = harness.lastRun().error ?? "";
    expect(error).toContain(differ);
    expect(error).toContain("test.entry");
    expect(error).toContain(update);
    expect(harness.server.rows).toEqual([]);
    expect(registrations()).toEqual([]);
  });

  it("stops where its connection type is missing, and registers nothing", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
    };
    harness.server.installType({ ...testType });
    harness.server.installs = false;
    expect(await harness.once(connecting())).toBe(1);
    const error = harness.lastRun().error ?? "";
    expect(error).toContain(differ);
    expect(error).toContain("the connection type test.blocks");
    expect(error).toContain(update);
    expect(harness.server.rows).toEqual([]);
    expect(registrations()).toEqual([]);
  });
});

describe("a start on a type narrower than the build", () => {
  it("runs on without the fields it lacks, with one condition, and registers nothing", async () => {
    harness.server.types.set("test.entry", older());
    const held = vendor([entry]);
    expect(await harness.once(held)).toBe(0);
    expect(held.runs).toBe(1);
    expect(harness.server.rows[0]?.properties["title"]).toBe("One");
    expect(harness.server.rows[0]?.properties["note"]).toBeUndefined();
    const run = harness.lastRun();
    expect(run.outcome).toBe("succeeded");
    expect(run.summary).toContain(differ);
    expect(run.summary).toContain("link, note");
    expect(run.summary).toContain(update);
    expect(Object.keys(harness.problems())).toEqual(["plugin-types"]);
    expect(registrations()).toEqual([]);
  });

  it("keeps what rows hold under a field it omits", async () => {
    expect(await harness.once(vendor([entry]))).toBe(0);
    harness.server.types.set("test.entry", older());
    const changed = {
      source_id: "a:1",
      properties: { title: "One again", note: "Changed at the vendor" },
    };
    expect(await harness.once(vendor([changed]))).toBe(0);
    const row = harness.server.rows[0];
    expect(row?.properties["title"]).toBe("One again");
    expect(row?.properties["note"]).toBe("From the vendor");
    expect(registrations()).toEqual([]);
  });

  it("puts the fix first, so the cap on a condition never cuts it", async () => {
    const names = Array.from(
      { length: 80 },
      (_, index) => `field_${String(index)}`,
    );
    const fields = Object.fromEntries(
      names.map((name) => [name, { type: "string" as const }]),
    );
    const connector = testConnector(vendor([]));
    const wide = {
      ...connector,
      types: [
        {
          ...connector.types[0],
          fields: [...testFields, ...names],
          type: { ...testType, fields: { ...testType.fields, ...fields } },
        },
      ],
    };
    harness.server.types.set("test.entry", older());
    expect(await start(wide, harness.runtime(["--once"]))).toBe(0);
    const text = harness.problems()["plugin-types"] ?? "";
    expect(text).toHaveLength(500);
    expect(text).toContain(update);
  });

  it("stops where the type lacks a status word the build declares, naming it and the update, and writes nothing", async () => {
    const open = { value: "open", group: "not_started" as const };
    const words = [open, { value: "closed", group: "completed" as const }];
    const withStatus = (status_values: (typeof words)[number][]) => ({
      ...testType,
      fields: {
        ...testType.fields,
        status: { type: "status" as const, status_values },
      },
    });
    const connector = testConnector(vendor([entry]));
    const worded = {
      ...connector,
      types: [
        {
          ...connector.types[0],
          fields: [...testFields, "status"],
          type: withStatus(words),
        },
      ],
    };
    harness.server.types.set("test.entry", withStatus([open]));
    expect(await start(worded, harness.runtime(["--once"]))).toBe(1);
    const error = harness.lastRun().error ?? "";
    expect(error).toContain(differ);
    expect(error).toContain('"closed"');
    expect(error).toContain(update);
    expect(error).not.toContain("is missing on the server");
    expect(harness.server.rows).toEqual([]);
    expect(registrations()).toEqual([]);
  });

  it("puts the update command first in a refusal, so the cap on the run's error never cuts it", async () => {
    const names = Array.from(
      { length: 120 },
      (_, index) => `field_${String(index)}`,
    );
    const connector = testConnector(vendor([entry]));
    const wide = {
      ...connector,
      types: [
        {
          ...connector.types[0],
          fields: [...testFields, ...names],
          type: {
            ...testType,
            fields: {
              ...testType.fields,
              ...Object.fromEntries(
                names.map((name) => [name, { type: "string" as const }]),
              ),
            },
          },
        },
      ],
    };
    harness.server.types.set("test.entry", {
      ...testType,
      fields: {
        ...testType.fields,
        ...Object.fromEntries(
          names.map((name) => [name, { type: "integer" as const }]),
        ),
      },
    });
    expect(await start(wide, harness.runtime(["--once"]))).toBe(1);
    const error = harness.lastRun().error ?? "";
    expect(error).toHaveLength(2000);
    expect(error.startsWith(`Update the plugin with \`${update}\``)).toBe(true);
    expect(error).toContain(differ);
  });

  it("stops where the type lacks the link field or a file field", async () => {
    harness.server.types.set("test.entry", {
      ...linkedType,
      fields: { title: { type: "string", required: true } },
    });
    const connector = testConnector(vendor([entry]));
    const linked = {
      ...connector,
      types: [{ ...connector.types[0], fields: testFields, type: linkedType }],
    };
    expect(await start(linked, harness.runtime(["--once"]))).toBe(1);
    const error = harness.lastRun().error ?? "";
    expect(error).toContain("vendor_id");
    expect(error).toContain(differ);
    expect(error).toContain(update);

    const filed = {
      ...connector,
      types: [
        {
          ...connector.types[0],
          fields: [
            "title",
            "note",
            "link",
            "vendor_id",
            "blob_ref",
            "mime_type",
          ],
          type: {
            ...testType,
            fields: {
              ...testType.fields,
              blob_ref: { type: "string" as const },
              mime_type: { type: "string" as const },
            },
          },
        },
      ],
    };
    harness.server.types.set("test.entry", testType);
    expect(await start(filed, harness.runtime(["--once"]))).toBe(1);
    expect(harness.lastRun().error).toContain("blob_ref, mime_type");
    expect(harness.server.rows).toEqual([]);
    expect(registrations()).toEqual([]);
  });

  it("stops on every difference but a missing optional field, and rewrites nothing", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      [
        "a changed link",
        { ...testType, link_field: "vendor_id" },
        "link_field",
      ],
      ["a changed parent", { ...testType, parent: "test.base" }, "parent"],
      [
        "a field made required",
        {
          ...testType,
          fields: {
            ...testType.fields,
            note: { type: "string", required: true },
          },
        },
        '"note" is required on the server',
      ],
      [
        "a field required here",
        {
          ...testType,
          fields: { ...testType.fields, title: { type: "string" } },
        },
        '"title" is required here',
      ],
      [
        "a changed shape",
        {
          ...testType,
          fields: { ...testType.fields, note: { type: "integer" } },
        },
        '"note" has type',
      ],
      [
        "a required field the connector does not know",
        {
          ...testType,
          fields: {
            ...testType.fields,
            extra: { type: "string", required: true },
          },
        },
        '"extra" is required on the server',
      ],
      [
        "a required field the server lacks",
        older({
          fields: {
            note: { type: "string" },
            link: { type: "url" },
            vendor_id: { type: "string" },
          },
        }),
        '"title" is required here and missing on the server',
      ],
    ];
    for (const [, served, named] of cases) {
      harness.server.types.set("test.entry", served);
      expect(await harness.once(vendor([entry]))).toBe(1);
      const error = harness.lastRun().error ?? "";
      expect(error).toContain(differ);
      expect(error).toContain(named);
      expect(error).toContain(update);
      expect(harness.server.types.get("test.entry")).toBe(served);
    }
    expect(registrations()).toEqual([]);
    expect(harness.server.rows).toEqual([]);
  });

  it("does not count a label, description or display hints that differ", async () => {
    harness.server.types.set("test.entry", {
      ...testType,
      label: "Another label",
      description: "Another description",
      display_hints: { icon: "other" },
    });
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.problems()).toEqual({});
    expect(registrations()).toEqual([]);
  });
});

describe("a start on a connection type that differs", () => {
  const withKey = (): void => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
    };
  };

  it("stops where its cardinality differs, and registers nothing", async () => {
    withKey();
    harness.server.installConnection({ ...blocks, cardinality: "one-to-one" });
    expect(await harness.once(connecting())).toBe(1);
    const error = harness.lastRun().error ?? "";
    expect(error).toContain(differ);
    expect(error).toContain("the connection type test.blocks");
    expect(error).toContain("cardinality");
    expect(error).toContain(update);
    expect(harness.server.rows).toEqual([]);
    expect(registrations()).toEqual([]);
  });

  it("stops where the endpoints it writes are not among the installed ones", async () => {
    withKey();
    harness.server.installConnection({
      ...blocks,
      from_type_constraints: ["test.other"],
    });
    expect(await harness.once(connecting())).toBe(1);
    expect(harness.lastRun().error).toContain("from_type_constraints");
    expect(registrations()).toEqual([]);
  });

  it("runs where the installed endpoints cover those it writes", async () => {
    withKey();
    harness.server.installConnection({
      ...blocks,
      from_type_constraints: ["test.entry", "test.other"],
      to_type_constraints: ["*"],
    });
    expect(await harness.once(connecting())).toBe(0);
    expect(harness.problems()).toEqual({});
    expect(registrations()).toEqual([]);
  });
});

describe("a connector running under --every on a narrower type", () => {
  it("lifts the omission once the plugin is updated, without a restart", async () => {
    harness.server.types.set("test.entry", older());
    const held = vendor([entry]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(1);
    expect(harness.server.rows[0]?.properties["note"]).toBeUndefined();
    expect(harness.lastRun().summary).toContain(update);

    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(2);
    expect(harness.lastRun().summary).toContain(update);

    harness.server.types.set("test.entry", testType);
    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(3);
    expect(harness.server.rows[0]?.properties["note"]).toBe("From the vendor");
    expect(harness.lastRun().summary).not.toContain(update);
    expect(registrations()).toEqual([]);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("tells the connector the fields it writes, which change when the omission lifts", async () => {
    harness.server.types.set("test.entry", older());
    const seen: string[][] = [];
    const held = vendor([entry]);
    held.read = (context) => {
      seen.push([...context.written("test.entry")]);
      expect(() => context.written("test.other")).toThrow(
        "the connector declares no type test.other",
      );
      expect([...context.forScope("s").written("test.entry")]).toEqual(
        seen.at(-1),
      );
      return Promise.resolve();
    };
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    harness.server.types.set("test.entry", testType);
    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    harness.stop();
    expect(await exit).toBe(0);
    expect(seen).toEqual([["title", "vendor_id", "toString"], testFields]);
  });

  it("goes on without the fields when the check before a scheduled run gets no answer", async () => {
    harness.server.types.set("test.entry", older());
    const held = vendor([entry]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    harness.server.refuseNext("POST /types/normalize", 503, "unavailable");
    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "could not be checked again, so it goes on without the fields it lacked",
    );
    expect(harness.lastRun().summary).toContain(update);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("stops when the check before a scheduled run finds a difference that omitting a field does not answer", async () => {
    harness.server.types.set("test.entry", older());
    const held = vendor([entry]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    harness.server.types.set("test.entry", older({ link_field: "vendor_id" }));
    await harness.clock.wake(15 * minute);
    expect(await exit).toBe(1);
    expect(held.runs).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(harness.lastRun().error).toContain("link_field");
    expect(harness.lastRun().error).toContain(update);
    expect(registrations()).toEqual([]);
  });
});

describe("a refused entry while a type is narrower than the build", () => {
  const bad = {
    source_id: "bad",
    properties: { title: "Bad", note: "From the vendor" },
  };
  const retry = { mode: "replay" as const, context: "a".repeat(64) };

  async function runTwice(): Promise<number[]> {
    harness.server.entryRefusals.set("bad", {
      status: 400,
      code: "invalid_properties",
      message: "Bad title",
    });
    const held = vendor();
    held.read = async (context) => {
      const scope = context.forScope("A", { retry });
      await scope.upsert("test.entry", [bad]);
      await scope.state.checkpoint("page", 1);
    };
    const posts = (): number =>
      harness.server.requestsTo("POST", "/items/bulk").length;
    const counts: number[] = [];
    for (let run = 0; run < 2; run += 1) {
      expect(await harness.once(held)).toBe(0);
      counts.push(posts());
    }
    return counts;
  }

  it("is held for the day against a current type", async () => {
    const [first = 0, second = 0] = await runTwice();
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it("is held for the day while the type lacks a field the connector omits", async () => {
    harness.server.types.set("test.entry", older());
    const [first = 0, second = 0] = await runTwice();
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });
});
