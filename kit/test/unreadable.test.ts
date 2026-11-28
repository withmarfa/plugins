import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mark } from "../src/agreement.js";
import { Harness, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = {
  source_id: "a:1",
  properties: { title: "One", note: "first", vendor_id: "v1" },
  occurred_at: "2026-09-01T10:00:00.000Z",
};

const bare = (field: string, value: unknown): boolean =>
  field === "note" && value === "bare";

async function made() {
  const held = vendor([one]);
  await harness.twoWay(held);
  const row = harness.server.row("a:1");
  held.unreadable = bare;
  held.changes.length = 0;
  return { held, row };
}

describe("a stored value the kind says it cannot read", () => {
  it("is put back from the vendor's value, and not carried, when it was changed in Marfa", async () => {
    const { held, row } = await made();
    harness.server.edit(row.id, { note: "bare" });
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.server.row("a:1").properties["note"]).toBe("first");
  });

  it("is put back, and not carried, when it was changed in Marfa and the vendor sent nothing", async () => {
    const { held, row } = await made();
    held.entries = [];
    harness.server.edit(row.id, { note: "bare" });
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.server.row("a:1").properties["note"]).toBe("first");
    expect(harness.problems()[`put-back:${row.id}`]).toContain(
      "changed in Marfa and put back",
    );
  });

  it("is carried when the kind does not flag it", async () => {
    const { held, row } = await made();
    Reflect.deleteProperty(held, "unreadable");
    held.entries = [];
    harness.server.edit(row.id, { note: "bare" });
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => [...change.changed])).toEqual([
      ["note"],
    ]);
  });

  it("is replaced by the vendor's value, and not carried, when the vendor changed", async () => {
    const { held, row } = await made();
    harness.server.edit(row.id, { note: "bare" });
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, note: "second" },
        changed_at: "2099-01-01T00:00:00.000Z",
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.server.row("a:1").properties["note"]).toBe("second");
  });

  it("is rewritten from the vendor's value on the next read when neither side changed, and not carried", async () => {
    const { held, row } = await made();
    harness.server.edit(row.id, { note: "bare" });
    const record = harness.agreement(row.id) as {
      marfa: Record<string, string>;
    };
    harness.server.agreements.set(row.id, {
      waiting: false,
      updated_at: row.updated_at,
      record: {
        ...record,
        marfa: { ...record.marfa, note: mark("bare") },
      },
    });
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.server.row("a:1").properties["note"]).toBe("first");
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.server.row("a:1").properties["note"]).toBe("first");
  });
});
