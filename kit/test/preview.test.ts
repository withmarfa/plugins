import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Entry } from "../src/define.js";
import { exitCode } from "../src/exit.js";
import { Harness, secretToken, vendor, type Vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
  harness.server.installType({
    id: "common.ticket",
    label: "Ticket",
    fields: { title: { type: "string" }, note: { type: "string" } },
    display_hints: { title_field: "title" },
  });
  harness.server.mapping.version = 1;
  harness.server.mapping.kinds["entry"] = {
    enabled: true,
    target_type: "common.ticket",
    tier: "feed",
  };
});
afterEach(async () => {
  await harness.close();
});

const target = "common.ticket";
const one: Entry = {
  source_id: "a:1",
  properties: { title: "One", note: "first" },
};

let sequence = 0;
function ask(
  fields: {
    kind?: string;
    item_id?: string | null;
    mapping?: Record<string, unknown> | null;
  } = {},
) {
  sequence += 1;
  const preview = {
    id: `preview-${String(sequence)}`,
    kind: fields.kind ?? "entry",
    item_id: fields.item_id ?? null,
    mapping: fields.mapping ?? null,
    status: "pending" as const,
    result: null,
    error: null,
  };
  harness.server.previews.push(preview);
  return preview;
}

function answered(id: string) {
  const held = harness.server.previews.find((one) => one.id === id);
  if (held === undefined) throw new Error(`no preview ${id}`);
  return held;
}

/** Every request that changes what Marfa holds of items, other than the
 *  connector's own bookkeeping and the previews' answers. */
function itemWrites(): string[] {
  return harness.server.requests
    .filter(
      (request) =>
        request.method !== "GET" &&
        !request.path.startsWith("/plugins/") &&
        !request.path.startsWith("/connectors/") &&
        request.path !== "/connectors" &&
        request.path !== "/types/normalize" &&
        request.path !== "/items/lookup",
    )
    .map((request) => `${request.method} ${request.path}`);
}

/** A vendor whose first read brings the entries and later reads bring none,
 *  so only a read for a preview can show them. */
function onceOnly(entries: Entry[]): Vendor {
  const held = vendor();
  let reads = 0;
  held.read = async (context) => {
    reads += 1;
    if (reads === 1) await context.upsert("test.entry", entries);
  };
  return held;
}

describe("a mapping preview", () => {
  it("of a named item answers what the mapping would write, the row's own fields", async () => {
    expect(await harness.once(vendor([one]))).toBe(exitCode.stopped);
    const row = harness.server.row("a:1");
    expect(row.type).toBe(target);

    const preview = ask({ item_id: row.id });
    expect(await harness.once(vendor())).toBe(exitCode.stopped);
    const held = answered(preview.id);
    expect(held.status).toBe("ready");
    expect(held.result).toEqual({
      type: target,
      properties: row.properties,
      title: "One",
      source_item: row.id,
    });
  });

  it("of a recent entry from the vendor answers what an upsert of it would write, and writes nothing", async () => {
    expect(await harness.once(vendor([one]))).toBe(exitCode.stopped);
    const written = harness.server.row("a:1").properties;
    const writes = itemWrites();

    const preview = ask();
    expect(await harness.once(onceOnly([one]))).toBe(exitCode.stopped);
    expect(answered(preview.id).result).toEqual({
      type: target,
      properties: written,
      title: "One",
      source_item: null,
    });
    // The read for the preview was the connector's only one that brought the
    // entry, and it left no row and no request beyond the first run's.
    expect(harness.server.rows).toHaveLength(1);
    expect(itemWrites()).toEqual(writes);
  });

  it("with a draft mapping renders by it and never saves it", async () => {
    const mapping = {
      target_type: target,
      fields: {
        title: { template: "Ticket: {{ title }}" },
        note: { from: "note" },
      },
    };
    const before = structuredClone(harness.server.mapping);
    const preview = ask({ mapping });
    expect(await harness.once(vendor([one]))).toBe(exitCode.stopped);
    expect(answered(preview.id).result).toMatchObject({
      type: target,
      properties: { title: "Ticket: One", note: "first" },
    });
    expect(harness.server.mapping).toEqual(before);
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "PUT" && request.path.endsWith("/mapping"),
      ),
    ).toEqual([]);
    // The run itself still wrote by the mapping in force.
    expect(harness.server.row("a:1").properties).not.toHaveProperty(
      "title",
      "Ticket: One",
    );
  });

  it("with a draft applies it to the stored item read back through the mapping in force", async () => {
    expect(await harness.once(vendor([one]))).toBe(exitCode.stopped);
    const row = harness.server.row("a:1");
    const preview = ask({
      item_id: row.id,
      mapping: {
        target_type: target,
        fields: {
          title: { template: "{{ title }}!" },
          note: { from: "title" },
        },
      },
    });
    expect(await harness.once(vendor())).toBe(exitCode.stopped);
    expect(answered(preview.id).result).toMatchObject({
      properties: { title: "One!", note: "One" },
      source_item: row.id,
    });
  });

  it("that fails answers an error and the others are still answered", async () => {
    const unknown = ask({ kind: "nothing" });
    const broken = ask({
      mapping: {
        target_type: target,
        fields: { title: { template: "{{ nothing_here }}" } },
      },
    });
    const gone = ask({ item_id: "no-such-item" });
    const fine = ask();
    expect(await harness.once(vendor([one]))).toBe(exitCode.stopped);
    expect(answered(unknown.id).error).toContain("no kind nothing");
    expect(answered(broken.id).error).toContain("title");
    expect(answered(gone.id).error).toContain("gone");
    expect(answered(fine.id).status).toBe("ready");
    expect(harness.lastRun().outcome).toBe("succeeded");
  });

  it("answers an error naming a target type Marfa does not hold", async () => {
    const preview = ask({ mapping: { target_type: "common.missing" } });
    expect(await harness.once(vendor([one]))).toBe(exitCode.stopped);
    expect(answered(preview.id).error).toContain("common.missing");
  });

  it("answers an error for an item that is not the connector's", async () => {
    expect(await harness.once(vendor([one]))).toBe(exitCode.stopped);
    const row = harness.server.row("a:1");
    const held = harness.server.rows.find((one) => one.id === row.id);
    if (held === undefined) throw new Error("the row is gone");
    held.source = "other";
    const preview = ask({ item_id: row.id });
    expect(await harness.once(vendor())).toBe(exitCode.stopped);
    expect(answered(preview.id).error).toContain("not one this connector");
  });

  it("answers an error when the vendor is down, with no secret in it, and the run still reports", async () => {
    const held = vendor();
    held.fail = new Error(`the vendor refused ${secretToken}`);
    const preview = ask();
    expect(await harness.once(held)).toBe(exitCode.failed);
    const error = answered(preview.id).error ?? "";
    expect(error).toContain("vendor");
    expect(error).not.toContain(secretToken);
    expect(harness.lastRun().outcome).toBe("failed");
  });

  it("answers an error, never a cut item, for a result over 65,536 bytes", async () => {
    const preview = ask();
    const large: Entry = {
      source_id: "a:big",
      properties: { title: "Big", note: "x".repeat(70_000) },
    };
    expect(await harness.once(onceOnly([large]))).toBe(exitCode.stopped);
    const held = answered(preview.id);
    expect(held.status).toBe("failed");
    expect(held.error).toContain("65536");
    expect((held.error ?? "").length).toBeLessThanOrEqual(500);
  });

  it("is left alone while the connector is paused", async () => {
    harness.server.control.paused = true;
    const preview = ask();
    expect(await harness.once(vendor([one]))).toBe(exitCode.stopped);
    expect(answered(preview.id).status).toBe("pending");
    expect(harness.server.previewAnswers).toEqual([]);

    harness.server.control.paused = false;
    expect(await harness.once(vendor([one]))).toBe(exitCode.stopped);
    expect(answered(preview.id).status).toBe("ready");
  });

  it("reads the vendor once for every preview that names no item", async () => {
    let reads = 0;
    const held = vendor();
    held.read = async (context) => {
      reads += 1;
      await context.upsert("test.entry", [one]);
    };
    const previews = [ask(), ask(), ask()];
    expect(await harness.once(held)).toBe(exitCode.stopped);
    for (const preview of previews)
      expect(answered(preview.id).status).toBe("ready");
    // Once for the three previews, and once for the run.
    expect(reads).toBe(2);
  });
});
