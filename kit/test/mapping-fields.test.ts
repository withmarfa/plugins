import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Entry, TypeDefinition } from "../src/define.js";
import { previewOf, type ResolvedType } from "../src/mapping.js";
import { templateCharacters } from "../src/template.js";
import {
  Harness,
  linkedType,
  testFields,
  vendor,
  type Vendor,
} from "./harness.js";

/** The kind's own type: a status field with no `canceled` word. */
const ownType: TypeDefinition = {
  ...linkedType,
  fields: {
    ...linkedType.fields,
    status: {
      type: "status",
      status_values: [
        { value: "open", group: "not_started" },
        { value: "doing", group: "in_progress" },
        { value: "waiting", group: "in_progress" },
        { value: "done", group: "completed" },
      ],
    },
  },
};
const kindFields = [...testFields, "status"];

/** The target: no `completed` word, and no link field of its own. */
const target = "common.ticket.task";
const targetType = {
  id: target,
  label: "Task",
  fields: {
    title: { type: "string" },
    summary: { type: "string" },
    label: { type: "string" },
    status: {
      type: "status",
      status_values: [
        { value: "not_started", group: "not_started" },
        { value: "backlog", group: "not_started" },
        { value: "in_progress", group: "in_progress" },
        { value: "blocked", group: "in_progress" },
        { value: "canceled", group: "canceled" },
      ],
    },
  },
  display_hints: { title_field: "title" },
};

type FieldSource = { from: string } | { fixed: unknown } | { template: string };

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
  harness.server.types.set(ownType.id, { ...ownType });
  harness.server.installType({ ...targetType });
});
afterEach(async () => {
  await harness.close();
});

function mapFields(
  fields: Record<string, FieldSource>,
  options: {
    overrides?: Record<string, string>;
    version?: number;
    type?: string;
  } = {},
): void {
  harness.server.mapping.version = options.version ?? 1;
  harness.server.mapping.kinds["entry"] = {
    enabled: true,
    target_type: options.type ?? target,
    tier: "feed",
    status_overrides: options.overrides ?? {},
    fields,
  };
}

const standard: Record<string, FieldSource> = {
  title: { template: "{{ title }} ({{ vendor_id }})" },
  summary: { from: "note" },
  status: { from: "status" },
  label: { fixed: "imported" },
};

const one: Entry = {
  source_id: "a:1",
  properties: {
    title: "One",
    note: "first",
    link: "https://vendor.test/1",
    vendor_id: "v1",
    status: "waiting",
  },
};

function held(entries: Entry[] = [one]): Vendor {
  return { ...vendor(entries), kindType: ownType, kindFields };
}

async function quiet(given: Vendor): Promise<number> {
  given.changes.length = 0;
  return harness.twoWay(given);
}

function creates(): Record<string, unknown>[] {
  return harness.server
    .requestsTo("POST", "/items/bulk")
    .flatMap(
      (request) => (request.body as { items: Record<string, unknown>[] }).items,
    );
}

describe("a kind's fields mapped onto the target's", () => {
  it("renders a template from the entry's fields, writes a fixed value, fills a field from another and lands a status word in its group", async () => {
    mapFields(standard);
    expect(await harness.twoWay(held()), harness.lines.join("\n")).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.type).toBe(target);
    expect(row.properties).toEqual({
      title: "One (v1)",
      summary: "first",
      label: "imported",
      status: "in_progress",
      vendor_id: "v1",
    });
  });

  it("names as left out only a field neither a template nor a field's from reads", async () => {
    mapFields(standard);
    expect(await harness.twoWay(held())).toBe(0);
    const warning = harness.problems()["mapping-fields:entry"];
    expect(warning).toContain("without link,");
    expect(warning).not.toMatch(/without[^,]*\btitle\b/);

    mapFields({ ...standard, title: { from: "note" } }, { version: 2 });
    expect(await quiet(held())).toBe(0);
    expect(harness.problems()["mapping-fields:entry"]).toContain(
      "without title, link,",
    );
  });

  it("counts no update for a row the first run after the mapping sends again and Marfa finds unchanged", async () => {
    const doing: Entry = {
      ...one,
      properties: { ...one.properties, status: "doing" },
    };
    expect(await harness.twoWay(held([doing]))).toBe(0);
    const { version, updated_at } = harness.server.row("a:1");
    mapFields(standard);
    expect(await quiet(held([doing])), harness.lines.join("\n")).toBe(0);
    expect(
      harness.server.requestsTo(
        "PATCH",
        "/items/" + harness.server.row("a:1").id,
      ),
    ).toHaveLength(1);
    const after = harness.server.row("a:1");
    expect([after.version, after.updated_at]).toEqual([version, updated_at]);
    expect(harness.lastRun().summary).toMatch(/updated 0\b/);
    expect(harness.lastRun().summary).toMatch(/unchanged 1\b/);
  });

  it("lands a status word on the word its override names", async () => {
    mapFields(standard, { overrides: { waiting: "blocked" } });
    expect(await harness.twoWay(held())).toBe(0);
    expect(harness.server.row("a:1").properties["status"]).toBe("blocked");
  });

  it("leaves a field whose template names a value the entry does not hold unwritten, with a condition, and writes the rest", async () => {
    mapFields({ ...standard, title: { template: "{{ nope }}" } });
    expect(await harness.twoWay(held()), harness.lines.join("\n")).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.properties).not.toHaveProperty("title");
    expect(row.properties["summary"]).toBe("first");
    expect(harness.problems()["mapping-template:entry:title"]).toContain(
      "undefined value",
    );
  });

  it("reads a field the entry does not hold as nothing, not as an undefined name", async () => {
    mapFields({ ...standard, title: { template: "{{ title }}!{{ link }}" } });
    const given = held([
      { ...one, properties: { title: "One", vendor_id: "v1" } },
    ]);
    expect(await harness.twoWay(given)).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe("One!");
    expect(harness.problems()).not.toHaveProperty(
      "mapping-template:entry:title",
    );
  });

  it("keeps what a row holds in a field whose template stops rendering", async () => {
    mapFields(standard);
    const given = held();
    expect(await harness.twoWay(given)).toBe(0);
    mapFields(
      { ...standard, title: { template: "{{ nope }}" } },
      { version: 2 },
    );
    given.entries = [{ ...one, properties: { ...one.properties, note: "1" } }];
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.properties["title"]).toBe("One (v1)");
    expect(row.properties["summary"]).toBe("1");
    expect(given.changes).toEqual([]);
  });

  it("cuts off a template that loops past the render's bound, leaving that field unwritten and the rest written", async () => {
    mapFields({
      ...standard,
      title: {
        template:
          "{% for i in range(99999) %}{% for j in range(99999) %}x{% endfor %}{% endfor %}",
      },
    });
    expect(await harness.twoWay(held()), harness.lines.join("\n")).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.properties).not.toHaveProperty("title");
    expect(row.properties["label"]).toBe("imported");
    expect(harness.problems()["mapping-template:entry:title"]).toContain(
      "more work than a render may",
    );
  });

  it("cuts off a template whose text grows past the size bound, leaving that field unwritten and the rest written", async () => {
    mapFields({ ...standard, title: { template: "{{ note }}{{ note }}" } });
    const long = "x".repeat(templateCharacters / 2 + 1);
    expect(
      await harness.twoWay(
        held([{ ...one, properties: { ...one.properties, note: long } }]),
      ),
      harness.lines.join("\n"),
    ).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.properties).not.toHaveProperty("title");
    expect(row.properties["summary"]).toBe(long);
    expect(harness.problems()["mapping-template:entry:title"]).toContain(
      "more than 100,000 characters",
    );
  });

  it("carries no change made in Marfa to a templated or fixed field back, and puts it back; a field filled from the kind's carries back", async () => {
    mapFields(standard);
    const given = held();
    expect(await harness.twoWay(given)).toBe(0);
    expect(await quiet(given)).toBe(0);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "By a person", label: "mine" });
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes).toEqual([]);
    expect(harness.server.row("a:1").properties["title"]).toBe("One (v1)");
    expect(harness.server.row("a:1").properties["label"]).toBe("imported");
    expect(harness.problems()[`put-back:${row.id}`]).toBe(
      `title, label on ${row.id} were changed in Marfa and put back from the vendor, whose value is the one kept`,
    );

    // The witness: a field filled from the kind's own carries back, named
    // by the kind's field.
    harness.server.edit(row.id, { summary: "edited in Marfa" });
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes.map((change) => [...change.changed])).toEqual([
      ["note"],
    ]);
    expect(given.changes[0]?.item.properties["note"]).toBe("edited in Marfa");
    expect(given.changes[0]?.item.type).toBe(linkedType.id);
  });

  it("keeps a target field the mapping does not fill, which someone else wrote, through the kit's next write", async () => {
    mapFields({
      title: { template: "{{ title }}!" },
      status: { from: "status" },
    });
    const given = held();
    expect(await harness.twoWay(given)).toBe(0);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { summary: "a note from an app" });
    given.entries = [{ ...one, properties: { ...one.properties, title: "1" } }];
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes).toEqual([]);
    expect(harness.server.row("a:1").properties).toMatchObject({
      title: "1!",
      summary: "a note from an app",
    });
  });
  it("leaves a row written on the kind's own type before the mapping where it is, with no put-back and no write when nothing changed", async () => {
    const given = held();
    expect(await harness.twoWay(given)).toBe(0);
    const before = harness.server.row("a:1");
    expect(before.type).toBe(ownType.id);
    mapFields(standard);
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    const patches = harness.server.requestsTo("PATCH", `/items/${before.id}`);
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.requestsTo("PATCH", `/items/${before.id}`)).toEqual(
      patches,
    );
    expect(
      Object.keys(harness.problems()).filter((key) =>
        key.startsWith("put-back"),
      ),
    ).toEqual([]);
    const after = harness.server.row("a:1");
    expect(after.type).toBe(ownType.id);
    expect(
      Object.keys(after.properties).some((key) => key.startsWith("@")),
    ).toBe(false);
    expect(given.changes).toEqual([]);
  });
  it("moves a row to the target on a rewrite with its fields as the mapping lands them, clearing the kind's own", async () => {
    const given = held();
    expect(await harness.twoWay(given)).toBe(0);
    const before = harness.server.row("a:1");
    mapFields(standard);
    harness.server.mapping.rewrites = [
      {
        number: 1,
        version: 1,
        kinds: ["entry"],
        requested_at: "2026-11-22T00:00:00.000Z",
      },
    ];
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rewritesDone).toEqual([1]);
    const after = harness.server.row("a:1");
    expect([after.id, after.type]).toEqual([before.id, target]);
    expect(after.properties).toEqual({
      title: "One (v1)",
      summary: "first",
      label: "imported",
      status: "in_progress",
      vendor_id: "v1",
    });
    expect(given.changes).toEqual([]);
  });
});

describe("a rewrite back onto the kind's own type", () => {
  it("leaves the row as the vendor holds it and carries nothing back", async () => {
    const given = held();
    expect(await harness.twoWay(given)).toBe(0);
    const id = harness.server.row("a:1").id;
    mapFields(standard);
    harness.server.mapping.rewrites = [
      {
        number: 1,
        version: 1,
        kinds: ["entry"],
        requested_at: "2026-11-22T00:00:00.000Z",
      },
    ];
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.byId(id).type).toBe(target);
    harness.server.mapping.version = 2;
    harness.server.mapping.kinds["entry"] = {
      enabled: true,
      target_type: ownType.id,
    };
    harness.server.mapping.rewrites = [
      {
        number: 2,
        version: 2,
        kinds: ["entry"],
        requested_at: "2026-11-22T01:00:00.000Z",
      },
    ];
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rewritesDone).toEqual([1, 2]);
    const after = harness.server.byId(id);
    expect(after.type).toBe(ownType.id);
    expect(after.properties).toEqual(one.properties);
    expect(given.changes).toEqual([]);
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes).toEqual([]);
  });
  /** Lands the row on the target with its title carried, and returns its
   *  id. */
  async function landed(given: Vendor): Promise<string> {
    expect(await harness.twoWay(given)).toBe(0);
    const id = harness.server.row("a:1").id;
    mapFields({ ...standard, title: { from: "title" } });
    harness.server.mapping.rewrites = [
      {
        number: 1,
        version: 1,
        kinds: ["entry"],
        requested_at: "2026-11-22T00:00:00.000Z",
      },
    ];
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.byId(id).type).toBe(target);
    return id;
  }

  function mapBack(): void {
    harness.server.mapping.version = 2;
    harness.server.mapping.kinds["entry"] = {
      enabled: true,
      target_type: ownType.id,
    };
    harness.server.mapping.rewrites = [
      {
        number: 2,
        version: 2,
        kinds: ["entry"],
        requested_at: "2026-11-22T01:00:00.000Z",
      },
    ];
  }

  function carried(given: Vendor): unknown[][] {
    return given.changes.map((change) => [
      change.item.properties["title"],
      change.item.properties["status"],
    ]);
  }

  /** Lands the row on the target and carries an edit of its title and
   *  status to the vendor, which then sends nothing it did not change. */
  async function carriedOnTarget(given: Vendor): Promise<string> {
    const id = await landed(given);
    harness.server.edit(id, { title: "One, edited", status: "backlog" });
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(carried(given)).toEqual([["One, edited", "open"]]);
    given.entries = [];
    return id;
  }

  it("keeps a change carried to the vendor while the row was on the target, reading its status word back", async () => {
    const given = held();
    const id = await carriedOnTarget(given);
    mapBack();
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rewritesDone).toEqual([1, 2]);
    const after = harness.server.byId(id);
    expect(after.type).toBe(ownType.id);
    expect(after.properties).toEqual({
      ...one.properties,
      title: "One, edited",
      status: "open",
    });
    expect(harness.problems()).not.toHaveProperty("rewrite:2:older");
    expect(given.changes).toEqual([]);
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes).toEqual([]);
  });

  it("keeps an edit made on the target and not yet carried, and carries it once", async () => {
    const given = held();
    const id = await landed(given);
    harness.server.edit(id, { title: "One, edited" });
    given.entries = [];
    mapBack();
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rewritesDone).toEqual([1, 2]);
    const after = harness.server.byId(id);
    expect(after.type).toBe(ownType.id);
    expect(after.properties["title"]).toBe("One, edited");
    expect(carried(given)).toEqual([["One, edited", "waiting"]]);
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes).toEqual([]);
    expect(harness.server.byId(id).properties["title"]).toBe("One, edited");
  });

  it("agrees a restored status in the vendor's own word, so a later edit in Marfa is carried when the vendor next sends the word unchanged", async () => {
    const given = held();
    const id = await landed(given);
    expect(harness.server.byId(id).properties["status"]).toBe("in_progress");
    given.entries = [];
    mapBack();
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rewritesDone).toEqual([1, 2]);
    expect(harness.server.byId(id).properties["status"]).toBe("waiting");
    expect(given.changes).toEqual([]);
    harness.server.edit(id, { status: "done" });
    given.entries = [
      {
        ...one,
        changed_at: "2099-01-01T00:00:00.000Z",
        properties: { ...one.properties, note: "second" },
      },
    ];
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    const after = harness.server.byId(id);
    expect(after.properties["status"]).toBe("done");
    expect(after.properties["note"]).toBe("second");
    expect(carried(given)).toEqual([["One", "done"]]);
    expect(
      Object.keys(harness.problems()).filter((key) =>
        key.startsWith("conflict-lost"),
      ),
    ).toEqual([]);
  });

  it("keeps an edit made on the target after one that was carried, and carries it once", async () => {
    const given = held();
    const id = await carriedOnTarget(given);
    harness.server.edit(id, { title: "One, edited twice" });
    mapBack();
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rewritesDone).toEqual([1, 2]);
    const after = harness.server.byId(id);
    expect(after.type).toBe(ownType.id);
    expect(after.properties["title"]).toBe("One, edited twice");
    expect(after.properties["status"]).toBe("open");
    expect(carried(given)).toEqual([["One, edited twice", "open"]]);
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes).toEqual([]);
  });

  it("keeps the request open where the move fails, and the next run carries out the move and only the edit not yet carried", async () => {
    const given = held();
    const id = await carriedOnTarget(given);
    harness.server.edit(id, { title: "One, edited twice" });
    mapBack();
    harness.server.refuseNext("PATCH /items/" + id, 503, "unavailable");
    expect(await quiet(given)).not.toBe(0);
    expect(harness.server.byId(id).type).toBe(target);
    expect(harness.server.rewritesDone).toEqual([1]);
    expect(given.changes).toEqual([]);
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rewritesDone).toEqual([1, 2]);
    const after = harness.server.byId(id);
    expect(after.type).toBe(ownType.id);
    expect(after.properties["title"]).toBe("One, edited twice");
    expect(carried(given)).toEqual([["One, edited twice", "open"]]);
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes).toEqual([]);
  });

  it("keeps the request open where Marfa refuses the move, and the next run, under the new mapping, still keeps the edit not yet carried", async () => {
    const given = held();
    const id = await carriedOnTarget(given);
    harness.server.edit(id, { title: "One, edited twice" });
    mapBack();
    harness.server.refuseNext("PATCH /items/" + id, 409, "version_conflict");
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.byId(id).type).toBe(target);
    expect(harness.server.rewritesDone).toEqual([1]);
    expect(harness.problems()["rewrite:2"]).toContain(`${id} was not moved`);
    expect(harness.server.connectorState?.["mapping"]).toMatchObject({
      version: 2,
    });
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rewritesDone).toEqual([1, 2]);
    const after = harness.server.byId(id);
    expect(after.type).toBe(ownType.id);
    expect(after.properties["title"]).toBe("One, edited twice");
    expect(carried(given)).toEqual([["One, edited twice", "open"]]);
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes).toEqual([]);
  });

  it("judges a move tried again as the first try did, so a status word the target holds in another word is not carried", async () => {
    const given = held();
    const id = await landed(given);
    harness.server.edit(id, { title: "One, edited" });
    given.entries = [];
    mapBack();
    harness.server.refuseNext("PATCH /items/" + id, 409, "version_conflict");
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.byId(id).type).toBe(target);
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rewritesDone).toEqual([1, 2]);
    const after = harness.server.byId(id);
    expect(after.properties["title"]).toBe("One, edited");
    expect(after.properties["status"]).toBe("waiting");
    expect(carried(given)).toEqual([["One, edited", "waiting"]]);
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes).toEqual([]);
  });

  it("moves the row with the values the vendor agreed in one write, so a failed write after it leaves nothing stale to carry", async () => {
    const given = held();
    const id = await carriedOnTarget(given);
    mapBack();
    // Any write to the row besides the move itself fails.
    harness.server.refuseWhere(
      "PATCH /items/" + id,
      (request) => (request.body as { retype?: boolean }).retype !== true,
      503,
      "unavailable",
    );
    await quiet(given);
    harness.server.stopRefusing();
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rewritesDone).toEqual([1, 2]);
    const after = harness.server.byId(id);
    expect(after.type).toBe(ownType.id);
    expect(after.properties["title"]).toBe("One, edited");
    expect(given.changes).toEqual([]);
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes).toEqual([]);
  });

  it("names a field no stored value matches what the vendor agreed, where the kit no longer knows the mapping the row was written under, and takes the vendor's value when it next sends the row", async () => {
    const given = held();
    const id = await carriedOnTarget(given);
    const kept = harness.server.connectorState ?? {};
    expect(kept["landedUnder"]).toEqual({
      [ownType.id]: { [target]: harness.server.mapping.kinds["entry"] },
    });
    Reflect.deleteProperty(kept, "landedUnder");
    Reflect.deleteProperty(kept, "mapping");
    mapBack();
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.rewritesDone).toEqual([1, 2]);
    const after = harness.server.byId(id);
    expect(after.properties["title"]).toBe("One, edited");
    expect(after.properties["status"]).toBe("waiting");
    expect(harness.problems()["rewrite:2:older"]).toContain("status on 1 row");
    expect(given.changes).toEqual([]);
    given.entries = [
      { ...one, properties: { ...one.properties, status: "open" } },
    ];
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(harness.server.byId(id).properties["status"]).toBe("open");
    expect(given.changes).toEqual([]);
  });
});

describe("status words carried back", () => {
  it("maps a target word back to the kind's word of its group", async () => {
    mapFields(standard);
    const given = held();
    expect(await harness.twoWay(given)).toBe(0);
    expect(await quiet(given)).toBe(0);
    harness.server.edit(harness.server.row("a:1").id, { status: "backlog" });
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes.map((change) => [...change.changed])).toEqual([
      ["status"],
    ]);
    expect(given.changes[0]?.item.properties["status"]).toBe("open");
  });

  it("maps a word an override lands on back to the word overridden", async () => {
    mapFields(standard, { overrides: { waiting: "blocked" } });
    const given = held([
      { ...one, properties: { ...one.properties, status: "doing" } },
    ]);
    expect(await harness.twoWay(given)).toBe(0);
    expect(harness.server.row("a:1").properties["status"]).toBe("in_progress");
    harness.server.edit(harness.server.row("a:1").id, { status: "blocked" });
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes[0]?.item.properties["status"]).toBe("waiting");
  });

  it("writes nothing for a word whose group the target lacks, with a condition, and the rest of the row", async () => {
    mapFields(standard);
    expect(
      await harness.twoWay(
        held([{ ...one, properties: { ...one.properties, status: "done" } }]),
      ),
      harness.lines.join("\n"),
    ).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.properties).not.toHaveProperty("status");
    expect(row.properties["title"]).toBe("One (v1)");
    expect(harness.problems()["mapping-status:entry:done"]).toContain(
      "holds no word in its group",
    );
  });

  it("carries nothing back for a target word whose group the kind lacks, and raises a condition", async () => {
    mapFields(standard);
    const given = held();
    expect(await harness.twoWay(given)).toBe(0);
    expect(await quiet(given)).toBe(0);
    const id = harness.server.row("a:1").id;
    harness.server.edit(id, { status: "canceled" });
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes).toEqual([]);
    expect(harness.server.row("a:1").properties["status"]).toBe("canceled");
    expect(harness.problems()["mapping-status-back:entry:canceled"]).toContain(
      id,
    );

    // The vendor's next change to the word is written over it.
    given.entries = [
      { ...one, properties: { ...one.properties, status: "open" } },
    ];
    expect(await quiet(given)).toBe(0);
    expect(given.changes).toEqual([]);
    expect(harness.server.row("a:1").properties["status"]).toBe("not_started");
  });
  it("carries nothing back for such a word on a row the vendor does not send again", async () => {
    mapFields(standard);
    const given = held();
    expect(await harness.twoWay(given)).toBe(0);
    expect(await quiet(given)).toBe(0);
    given.entries = [];
    harness.server.edit(harness.server.row("a:1").id, { status: "canceled" });
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes).toEqual([]);

    // The witness: a word of a group the kind holds is carried on that path.
    harness.server.edit(harness.server.row("a:1").id, { status: "backlog" });
    expect(await quiet(given), harness.lines.join("\n")).toBe(0);
    expect(given.changes.map((change) => [...change.changed])).toEqual([
      ["status"],
    ]);
  });
});

describe("a preview of a kind's mapping", () => {
  const own: ResolvedType = {
    id: ownType.id,
    fields: new Set([...Object.keys(ownType.fields)]),
    tables: new Set(),
    link: "vendor_id",
    above: [],
    status: {
      field: "status",
      words: [
        { value: "open", group: "not_started" },
        { value: "doing", group: "in_progress" },
        { value: "waiting", group: "in_progress" },
        { value: "done", group: "completed" },
      ],
    },
  };
  const resolvedTarget: ResolvedType = {
    id: target,
    fields: new Set(Object.keys(targetType.fields)),
    tables: new Set(),
    link: undefined,
    above: [],
    status: {
      field: "status",
      words: targetType.fields.status.status_values.map(({ value, group }) => ({
        value,
        group: group as "not_started",
      })),
    },
    titleField: "title",
  };
  const kind = { name: "entry", type: ownType, fields: kindFields };
  const mapping = {
    enabled: true,
    target_type: target,
    tier: "feed" as const,
    status_overrides: { waiting: "blocked" },
    fields: standard,
  };

  it("answers what an upsert of the same entry writes, with its title", async () => {
    const { result, conditions } = await previewOf({
      kind,
      mapping,
      own,
      target: resolvedTarget,
      from: { entry: one },
    });
    mapFields(standard, { overrides: { waiting: "blocked" } });
    expect(await harness.twoWay(held())).toBe(0);
    const [created] = creates();
    expect(result).toEqual({
      type: target,
      properties: created?.["properties"],
      title: "One (v1)",
      source_item: null,
    });
    expect(conditions.size).toBe(0);
  });

  it("renders from a stored item on the kind's own type, naming it", async () => {
    expect(await harness.twoWay(held())).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.type).toBe(ownType.id);
    const { result } = await previewOf({
      kind,
      mapping,
      own,
      target: resolvedTarget,
      from: {
        item: {
          id: row.id,
          type: row.type,
          source_id: row.source_id,
          properties: row.properties,
        } as never,
      },
    });
    expect(result).toEqual({
      type: target,
      properties: {
        title: "One (v1)",
        summary: "first",
        label: "imported",
        status: "blocked",
        vendor_id: "v1",
      },
      title: "One (v1)",
      source_item: row.id,
    });
  });

  function itemOf(row: ReturnType<typeof harness.server.row>): never {
    return {
      id: row.id,
      type: row.type,
      source_id: row.source_id,
      properties: row.properties,
    } as never;
  }

  it("writes back a stored item already on the target as the mapping read it, keeping its templated field", async () => {
    mapFields(standard, { overrides: { waiting: "blocked" } });
    expect(await harness.twoWay(held())).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.type).toBe(target);
    expect(row.properties["title"]).toBe("One (v1)");
    const { result, conditions } = await previewOf({
      kind,
      mapping,
      own,
      target: resolvedTarget,
      from: { item: itemOf(row) },
    });
    expect(result).toEqual({
      type: target,
      properties: row.properties,
      title: "One (v1)",
      source_item: row.id,
    });
    expect(conditions.size).toBe(0);
  });

  it("names a target word the kind cannot carry back among a stored item's conditions", async () => {
    mapFields(standard, { overrides: { waiting: "blocked" } });
    expect(await harness.twoWay(held())).toBe(0);
    const row = harness.server.edit(harness.server.row("a:1").id, {
      status: "canceled",
    });
    const { result, conditions } = await previewOf({
      kind,
      mapping,
      own,
      target: resolvedTarget,
      from: { item: itemOf(row) },
    });
    expect(result.properties["status"]).toBe("canceled");
    expect([...conditions.keys()]).toEqual([
      "mapping-status-back:entry:canceled",
    ]);
    expect(conditions.get("mapping-status-back:entry:canceled")).toContain(
      row.id,
    );
  });

  it("writes back a stored item on the kind's own type, when that is the target, without rendering it again", async () => {
    const fields: Record<string, FieldSource> = {
      title: { template: "{{ title }} ({{ vendor_id }})" },
      note: { from: "note" },
      link: { from: "link" },
      vendor_id: { from: "vendor_id" },
      status: { from: "status" },
    };
    mapFields(fields, { type: ownType.id });
    expect(await harness.twoWay(held())).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.type).toBe(ownType.id);
    expect(row.properties["title"]).toBe("One (v1)");
    const { result, conditions } = await previewOf({
      kind,
      mapping: {
        enabled: true,
        target_type: ownType.id,
        tier: "feed",
        status_overrides: {},
        fields,
      },
      own,
      target: { ...own, titleField: "title" },
      from: { item: itemOf(row) },
    });
    expect(result).toEqual({
      type: ownType.id,
      properties: row.properties,
      title: "One (v1)",
      source_item: row.id,
    });
    expect(conditions.size).toBe(0);
  });

  it("answers for a mapped item what the next write of the same entry sends", async () => {
    mapFields(standard, { overrides: { waiting: "blocked" } });
    expect(await harness.twoWay(held())).toBe(0);
    const { result } = await previewOf({
      kind,
      mapping,
      own,
      target: resolvedTarget,
      from: { item: itemOf(harness.server.row("a:1")) },
    });
    harness.server.edit(harness.server.row("a:1").id, {
      title: "By a person",
    });
    harness.server.requests.length = 0;
    expect(await harness.twoWay(held()), harness.lines.join("\n")).toBe(0);
    const id = harness.server.row("a:1").id;
    const [written] = harness.server
      .requestsTo("PATCH", `/items/${id}`)
      .map((request) => request.body as Record<string, unknown>);
    expect(written?.["properties"]).toEqual(result.properties);
  });

  it("names a template that fails among its conditions, and leaves the field out", async () => {
    const { result, conditions } = await previewOf({
      kind,
      mapping: {
        ...mapping,
        fields: { ...standard, title: { template: "{{ nope }}" } },
      },
      own,
      target: resolvedTarget,
      from: { entry: one },
    });
    expect(result.properties).not.toHaveProperty("title");
    expect(result).not.toHaveProperty("title");
    expect([...conditions.keys()]).toEqual(["mapping-template:entry:title"]);
  });
});
