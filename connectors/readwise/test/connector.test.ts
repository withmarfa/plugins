import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { readwiseVendor } from "../../../scripts/proof/readwise-vendor.js";
import { connector } from "../src/definition.js";

const exec = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const stopping: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stopping.splice(0)) await stop();
});

async function fixture(
  settings: Record<string, unknown> = {},
  incremental = false,
) {
  const marfa = await new ScriptedServer("readwise", {
    types: ["readwise.source", "readwise.highlight", "readwise.file"],
    edges: ["excerpt-of", "references", "attached-to"],
  }).start();
  const vendor = await readwiseVendor({ incremental });
  stopping.push(async () => {
    await marfa.stop();
    await vendor.close();
  });
  // One document saved in Reader, with one highlight, as both the export and
  // Reader list it, and one book only the export knows.
  vendor.sources.push(
    {
      user_book_id: 1,
      source: "reader",
      external_id: "doc-1",
      title: "Export title",
      highlights: [
        { id: 11, external_id: "hi-1", text: "Export passage", note: "Note" },
      ],
    },
    {
      user_book_id: 2,
      source: "kindle",
      external_id: "book-2",
      title: "Book",
      highlights: [{ id: 21, external_id: "k-21", text: "Kindle passage" }],
    },
  );
  vendor.documents.set("doc-1", {
    id: "doc-1",
    category: "article",
    title: "Reader title",
    location: "new",
    html_content: "<article><p>Retained</p></article>",
  });
  vendor.documents.set("hi-1", {
    id: "hi-1",
    category: "highlight",
    parent_id: "doc-1",
    content: "Reader passage",
    notes: "Note",
  });
  const once = async (extra: Record<string, unknown> = {}) => {
    await exec("node", [built, "--once"], {
      env: marfa.processEnv({
        PATH: process.env["PATH"],
        MARFA_API_URL: marfa.url,
        MARFA_API_KEY: marfa.key,
        readwise_account: "primary",
        readwise_access_token: "reader-fixture-token",
        readwise_api_url: `${vendor.base}/v2/`,
        readwise_reader_api_url: `${vendor.base}/v3/`,
        ...settings,
        ...extra,
      }),
    });
  };
  const rows = (type: string) => marfa.rows.filter((row) => row.type === type);
  return { marfa, vendor, once, rows };
}

const readerOn = { readwise_reader: true };

describe("with Reader off", () => {
  it("brings in the export's sources and highlights and sends nothing to Readwise", async () => {
    const { marfa, vendor, once, rows } = await fixture();
    await once();
    expect(
      rows("readwise.source")
        .map((row) => row.source_id)
        .sort(),
    ).toEqual(["primary:source:1", "primary:source:2"]);
    expect(
      rows("readwise.highlight")
        .map((row) => row.source_id)
        .sort(),
    ).toEqual(["primary:highlight:11", "primary:highlight:21"]);
    marfa.edit(marfa.row("primary:source:1").id, { title: "Marfa title" });
    marfa.edit(marfa.row("primary:highlight:11").id, { note: "Marfa note" });
    marfa.purge("primary:highlight:21");
    await once();
    expect(vendor.writes).toEqual([]);
    expect(
      Object.keys(marfa.problems.get("readwise") ?? {}).filter(
        (key) => !key.startsWith("put-back:"),
      ),
    ).toEqual([]);
    expect(vendor.requests.filter((line) => line.includes(" /v3/"))).toEqual(
      [],
    );
  });
});

describe("highlights written before the passage moved to text", () => {
  const picture =
    "![](https://readwise-assets.s3.amazonaws.com/media/picture.png)";
  /** What the earlier release left on a row: the passage as `body`, a title from it. */
  function aged(
    marfa: Awaited<ReturnType<typeof fixture>>["marfa"],
    sourceId: string,
  ) {
    const row = marfa.row(sourceId);
    row.properties["title"] = "Old title from the passage";
    row.properties["body"] = String(row.properties["text"]);
  }

  it("writes a new highlight with text and no title or body", async () => {
    const { vendor, once, rows } = await fixture();
    const [book] = vendor.sources;
    book?.highlights.push({ id: 12, external_id: "k-12", text: picture });
    await once();
    for (const row of rows("readwise.highlight")) {
      expect(typeof row.properties["text"]).toBe("string");
      expect(row.properties).not.toHaveProperty("title");
      expect(row.properties).not.toHaveProperty("body");
    }
    expect(
      rows("readwise.highlight").map((row) => row.properties["text"]),
    ).toContain(picture);
  });

  it.each([
    ["off", {}],
    ["on", readerOn],
  ])(
    "rewrites an old-shape row on the next run, sends nothing, and keeps the passage, Reader %s",
    async (_, settings) => {
      const { marfa, vendor, once } = await fixture(settings);
      const [book] = vendor.sources;
      book?.highlights.push({ id: 12, external_id: "k-12", text: picture });
      await once();
      await once();
      for (const id of [
        "primary:highlight:11",
        "primary:highlight:21",
        "primary:highlight:12",
      ]) {
        aged(marfa, id);
      }
      const passages = [
        "primary:highlight:11",
        "primary:highlight:21",
        "primary:highlight:12",
      ].map((id) => marfa.row(id).properties["text"]);
      await once();
      for (const id of [
        "primary:highlight:11",
        "primary:highlight:21",
        "primary:highlight:12",
      ]) {
        expect(marfa.row(id).properties).not.toHaveProperty("title");
        expect(marfa.row(id).properties).not.toHaveProperty("body");
      }
      expect(
        [
          "primary:highlight:11",
          "primary:highlight:21",
          "primary:highlight:12",
        ].map((id) => marfa.row(id).properties["text"]),
      ).toEqual(passages);
      expect(marfa.row("primary:highlight:12").properties["text"]).toBe(
        picture,
      );
      expect(vendor.writes).toEqual([]);
      expect(
        Object.keys(marfa.problems.get("readwise") ?? {}).filter(
          (key) => !key.startsWith("put-back:"),
        ),
      ).toEqual([]);
    },
  );

  it("rewrites the other old rows when one highlight cannot be written", async () => {
    const { marfa, vendor, once } = await fixture();
    await once();
    aged(marfa, "primary:highlight:11");
    aged(marfa, "primary:highlight:21");
    vendor.sources[0]?.highlights.push({
      id: 12,
      external_id: "k-12",
      text: picture,
    });
    marfa.entryRefusals.set("primary:highlight:12", {
      status: 400,
      code: "invalid_properties",
      message: "refused for the test",
    });
    await once();
    for (const id of ["primary:highlight:11", "primary:highlight:21"]) {
      expect(marfa.row(id).properties).not.toHaveProperty("body");
      expect(marfa.row(id).properties).not.toHaveProperty("title");
    }
    expect(() => marfa.row("primary:highlight:12")).toThrow();
    expect(vendor.writes).toEqual([]);
  });

  it("still carries a person's edit to a managed highlight's note, and puts back an edit to text without sending it", async () => {
    const { marfa, vendor, once } = await fixture(readerOn);
    await once();
    await once();
    aged(marfa, "primary:highlight:11");
    marfa.edit(marfa.row("primary:highlight:11").id, {
      text: "Rewritten in Marfa",
      note: "Marfa note",
    });
    await once();
    expect(vendor.writes).toEqual([
      {
        method: "PATCH",
        path: "/v3/update/hi-1/",
        body: { notes: "Marfa note" },
      },
    ]);
    expect(vendor.documents.get("hi-1")?.content).toBe("Reader passage");
    const row = marfa.row("primary:highlight:11");
    expect(row.properties["text"]).toBe("Export passage");
    expect(row.properties).not.toHaveProperty("body");
  });
});

describe("highlights as the earlier release wrote them", () => {
  const markdown = "**Bold** opening\n\nSecond paragraph";
  const plain = "Bold opening Second paragraph";
  const whole = `Opening line\n\n${"x".repeat(100_001)}`;
  const placeholder = "Complete text is preserved in the attached text file.";
  const longBody = "Complete passage is preserved in the attached text file.";

  async function earlier(incremental = false, reset = true) {
    const found = await fixture({ ...readerOn }, incremental);
    const { marfa, vendor, once } = found;
    const [book] = vendor.sources;
    const first = book?.highlights[0];
    if (first === undefined) throw new Error("fixture highlight missing");
    first.text = markdown;
    book?.highlights.push({
      id: 13,
      external_id: "hi-big",
      text: whole.slice(0, 8_191),
    });
    const reader = vendor.documents.get("hi-1");
    if (reader === undefined) throw new Error("fixture highlight missing");
    reader.content = plain;
    vendor.documents.set("hi-big", {
      id: "hi-big",
      category: "highlight",
      parent_id: "doc-1",
      content: whole,
    });
    // A Reader highlight the export does not hold.
    vendor.documents.set("doc-r", {
      id: "doc-r",
      category: "article",
      title: "Only in Reader",
      location: "new",
      updated_at: "2020-01-01T00:00:00Z",
    });
    vendor.documents.set("hi-r", {
      id: "hi-r",
      category: "highlight",
      parent_id: "doc-r",
      content: "Reader-only passage",
      updated_at: "2020-01-01T00:00:00Z",
    });
    await once();
    await once();
    const before = {
      files: marfa.row("primary:highlight:13").properties["reader_text_files"],
      fileRows: marfa.rows.filter((row) => row.type === "readwise.file").length,
    };
    // What the code before this change left on each row.
    const old = (sourceId: string, changes: Record<string, unknown>) =>
      Object.assign(marfa.row(sourceId).properties, changes);
    old("primary:highlight:11", {
      text: plain,
      readwise_text: markdown,
      title: "Bold opening",
      body: markdown,
    });
    old("primary:highlight:13", {
      text: placeholder,
      readwise_text: whole.slice(0, 8_191),
      title: "Opening line",
      body: longBody,
    });
    old("primary:reader-highlight:hi-r", {
      title: "Reader-only passage",
      body: "Reader-only passage",
    });
    // The next run is the first one of the new release.
    const state = marfa.connectorState?.["state"] as {
      export: { shape: string };
      listing: { fingerprint: string };
    };
    state.export.shape = "earlier release";
    if (reset) state.listing.fingerprint = "earlier release";
    return { ...found, before };
  }

  it("rewrites each to the new shape on the next run, losing no passage and sending nothing", async () => {
    const { marfa, vendor, once, before } = await earlier();
    expect(before.files).toHaveLength(1);
    await once();
    for (const id of [
      "primary:highlight:11",
      "primary:highlight:13",
      "primary:reader-highlight:hi-r",
    ]) {
      expect(marfa.row(id).properties).not.toHaveProperty("title");
      expect(marfa.row(id).properties).not.toHaveProperty("body");
    }
    expect(marfa.row("primary:highlight:11").properties["text"]).toBe(markdown);
    expect(marfa.row("primary:highlight:13").properties["text"]).toBe(
      placeholder,
    );
    expect(
      marfa.row("primary:highlight:13").properties["reader_text_files"],
    ).toEqual(before.files);
    expect(
      marfa.rows.filter((row) => row.type === "readwise.file"),
    ).toHaveLength(before.fileRows);
    expect(marfa.row("primary:reader-highlight:hi-r").properties["text"]).toBe(
      "Reader-only passage",
    );
    expect(vendor.writes).toEqual([]);
    expect(
      Object.keys(marfa.problems.get("readwise") ?? {}).filter(
        (key) => !key.startsWith("put-back:"),
      ),
    ).toEqual([]);
  });

  it("rewrites a Reader-only highlight on the next run, though Reader lists only what changed", async () => {
    const { marfa, once } = await earlier(true);
    await once();
    expect(
      marfa.row("primary:reader-highlight:hi-r").properties,
    ).not.toHaveProperty("title");
    expect(
      marfa.row("primary:reader-highlight:hi-r").properties,
    ).not.toHaveProperty("body");
  });

  it("leaves a Reader-only highlight to the next full walk when the type has not changed", async () => {
    const { marfa, once } = await earlier(true, false);
    await once();
    expect(
      marfa.row("primary:reader-highlight:hi-r").properties,
    ).toHaveProperty("title");
  });
});

describe("with Reader on", () => {
  const adopted = async (settings: Record<string, unknown> = {}) => {
    const found = await fixture({ ...readerOn, ...settings });
    await found.once();
    await found.once();
    return found;
  };

  it("keeps a Reader document and its export entry as one item", async () => {
    const { rows } = await adopted();
    const sources = rows("readwise.source");
    expect(sources).toHaveLength(2);
    const document = sources.find(
      (row) => row.properties["reader_id"] === "doc-1",
    );
    expect(document?.source_id).toBe("primary:source:1");
    expect(document?.properties["canonical_key"]).toBe(
      "primary:reader-document:doc-1",
    );
    const highlights = rows("readwise.highlight");
    expect(highlights).toHaveLength(2);
    const passage = highlights.find(
      (row) => row.properties["reader_id"] === "hi-1",
    );
    expect(passage?.source_id).toBe("primary:highlight:11");
    expect(passage?.properties["text"]).toBe("Export passage");
    expect(passage?.properties["readwise_text"]).toBe("Export passage");
  });

  it("sends nothing when it takes over a row archived while Reader was off", async () => {
    const { marfa, vendor, once } = await fixture();
    await once();
    marfa.transition(marfa.row("primary:source:1").id, "archived");
    await once();
    await once(readerOn);
    await once(readerOn);
    expect(marfa.row("primary:source:1").properties["reader_id"]).toBe("doc-1");
    expect(marfa.row("primary:source:1").state).toBe("archived");
    expect(vendor.writes).toEqual([]);
  });

  it("keeps what was changed in Marfa before it takes a row over, and sends none of it", async () => {
    const { marfa, vendor, once } = await fixture();
    const [book] = vendor.sources;
    if (book === undefined) throw new Error("fixture source missing");
    book.document_note = "Export note";
    await once();
    marfa.edit(marfa.row("primary:source:1").id, {
      title: "Marfa title",
      notes: null,
    });
    marfa.edit(marfa.row("primary:highlight:11").id, {
      note: "Marfa note",
      tags: ["marfa"],
    });
    marfa.edit(marfa.row("primary:source:2").id, { title: "Marfa book" });
    await once(readerOn);
    await once(readerOn);
    const source = marfa.row("primary:source:1");
    expect(source.properties["reader_id"]).toBe("doc-1");
    expect(source.properties["title"]).toBe("Marfa title");
    expect(source.properties["notes"]).toBeUndefined();
    const passage = marfa.row("primary:highlight:11");
    expect(passage.properties["reader_id"]).toBe("hi-1");
    expect(passage.properties["note"]).toBe("Marfa note");
    expect(passage.properties["tags"]).toEqual(["marfa"]);
    expect(vendor.writes).toEqual([]);
    // A row Reader cannot take keeps mirroring the export.
    expect(marfa.row("primary:source:2").properties["title"]).toBe("Book");
  });

  it.each([
    ["off", { readwise_reader: false }],
    ["inbound only", { readwise_reader_inbound_only: true }],
  ])(
    "keeps an unanswered Reader write while Reader is %s, and sends it once Reader may be written",
    async (_, paused) => {
      const { marfa, vendor, once } = await adopted();
      marfa.edit(marfa.row("primary:source:1").id, { title: "Marfa title" });
      // The answer is lost, and Reader does not hold the write after all.
      vendor.uncertain();
      await once().catch(() => undefined);
      expect(vendor.writes).toHaveLength(1);
      const document = vendor.documents.get("doc-1");
      if (document === undefined) throw new Error("fixture document missing");
      document.title = "Reader title";
      vendor.sources.push({
        user_book_id: 3,
        source: "kindle",
        external_id: "book-3",
        title: "Later book",
        highlights: [],
      });
      await once(paused);
      expect(marfa.row("primary:source:3").properties["title"]).toBe(
        "Later book",
      );
      expect(marfa.row("primary:source:1").properties["title"]).toBe(
        "Marfa title",
      );
      expect(vendor.writes).toHaveLength(1);
      expect(Object.keys(marfa.problems.get("readwise") ?? {})).toContain(
        `outbound-pending:${marfa.row("primary:source:1").id}`,
      );
      await once();
      await once();
      expect(vendor.writes.map((write) => write.body)).toEqual([
        { title: "Marfa title" },
        { title: "Marfa title" },
      ]);
      expect(vendor.documents.get("doc-1")?.title).toBe("Marfa title");
      expect(
        Object.keys(marfa.problems.get("readwise") ?? {}).filter((key) =>
          key.startsWith("outbound-pending:"),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    ["off", { readwise_reader: false }],
    ["inbound only", { readwise_reader_inbound_only: true }],
  ])(
    "says a lost save is why nothing imports while Reader is %s, and settles it once Reader is back",
    async (_, paused) => {
      const { marfa, vendor, once } = await adopted();
      const made = marfa.insert(
        undefined,
        {
          account: "primary",
          title: "Made in Marfa",
          url: "https://example.com/made",
          reader_create: true,
        },
        "readwise.source",
        "person",
      );
      vendor.uncertain();
      await once().catch(() => undefined);
      const saves = () =>
        vendor.writes.filter((write) => write.path === "/v3/save/");
      expect(saves()).toHaveLength(1);
      vendor.sources.push({
        user_book_id: 3,
        source: "kindle",
        external_id: "book-3",
        title: "Later book",
        highlights: [],
      });
      const written = vendor.writes.length;
      const failure = await once(paused).then(
        () => undefined,
        (error: unknown) => String((error as { stderr?: unknown }).stderr),
      );
      expect(failure).toContain("A save to Reader was sent but not confirmed");
      expect(failure).toContain("Turn Reader back on");
      expect(failure).not.toContain("row-refused");
      expect(vendor.writes).toHaveLength(written);
      expect(() => marfa.row("primary:source:3")).toThrow();
      expect(Object.keys(marfa.problems.get("readwise") ?? {})).toContain(
        "readwise:reader-save-unconfirmed",
      );
      await once();
      await once();
      expect(saves()).toHaveLength(1);
      expect(marfa.byId(made.id).properties["canonical_key"]).toBe(
        "primary:reader-document:created",
      );
      expect(marfa.row("primary:source:3").properties["title"]).toBe(
        "Later book",
      );
    },
  );

  it("carries a supported edit back to Reader and leaves an unsupported one", async () => {
    const { marfa, vendor, once } = await adopted();
    marfa.edit(marfa.row("primary:source:1").id, { title: "Marfa title" });
    marfa.edit(marfa.row("primary:highlight:11").id, { text: "Rewritten" });
    await once();
    expect(vendor.writes).toEqual([
      {
        method: "PATCH",
        path: "/v3/update/doc-1/",
        body: { title: "Marfa title" },
      },
    ]);
    expect(vendor.documents.get("hi-1")?.content).toBe("Reader passage");
  });

  it("takes Reader's values when it takes over a row, and carries a later clear", async () => {
    const { marfa, vendor, once } = await fixture();
    vendor.documents.set("hi-1", {
      ...vendor.documents.get("hi-1"),
      id: "hi-1",
      category: "highlight",
      tags: { retained: { name: "retained" } },
    });
    await once();
    await once(readerOn);
    await once(readerOn);
    const passage = marfa.row("primary:highlight:11");
    expect(passage.properties["tags"]).toEqual(["retained"]);
    marfa.edit(passage.id, { note: "", tags: [] });
    await once(readerOn);
    expect(vendor.writes).toEqual([
      {
        method: "PATCH",
        path: "/v3/update/hi-1/",
        body: { notes: "", tags: [] },
      },
    ]);
  });

  it("never carries an edit to a row only the export holds", async () => {
    const { marfa, vendor, once } = await adopted();
    marfa.edit(marfa.row("primary:highlight:21").id, { note: "Marfa note" });
    marfa.edit(marfa.row("primary:source:2").id, { title: "Marfa title" });
    marfa.transition(marfa.row("primary:source:2").id, "archived");
    marfa.purge("primary:highlight:21");
    await once();
    expect(vendor.writes).toEqual([]);
    // The export mirrors its own rows, so it puts the title back, and it
    // refuses no change, since none is ever offered to Reader.
    expect(
      Object.keys(marfa.problems.get("readwise") ?? {}).map(
        (key) => key.split(":")[0],
      ),
    ).toEqual(["put-back"]);
    expect(marfa.row("primary:source:2").properties["title"]).toBe("Book");
  });

  it("deletes a purged row from Reader only when the setting allows it", async () => {
    const kept = await adopted();
    kept.marfa.purge("primary:highlight:11");
    await kept.once();
    expect(kept.vendor.writes).toEqual([]);
    expect(kept.vendor.documents.has("hi-1")).toBe(true);

    const deleted = await adopted({
      readwise_reader_propagate_purge: true,
    });
    deleted.marfa.purge("primary:highlight:11");
    await deleted.once();
    expect(deleted.vendor.writes.map((write) => write.method)).toEqual([
      "DELETE",
    ]);
    expect(deleted.vendor.documents.has("hi-1")).toBe(false);
  });
});

describe("what goes back to Readwise", () => {
  const values = (settings: Record<string, unknown>) =>
    ({
      readwise_account: "primary",
      readwise_access_token: "token",
      ...settings,
    }) as Parameters<NonNullable<ReturnType<typeof connector>["carries"]>>[0];

  it("is nothing unless Reader is on and may be written", () => {
    const carries = connector().carries;
    expect(carries?.(values({}))).toEqual([]);
    expect(carries?.(values({ readwise_reader: false }))).toEqual([]);
    expect(
      carries?.(
        values({
          readwise_reader: true,
          readwise_reader_inbound_only: true,
        }),
      ),
    ).toEqual([]);
    expect(carries?.(values({ readwise_reader: true }))).toEqual([
      "readwise.source",
      "readwise.highlight",
    ]);
  });
});
