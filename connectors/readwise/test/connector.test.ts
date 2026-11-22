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

async function fixture(settings: Record<string, unknown> = {}) {
  const marfa = await new ScriptedServer("readwise", {
    types: ["readwise.source", "readwise.highlight", "readwise.file"],
    edges: ["excerpt-of", "references", "attached-to"],
  }).start();
  const vendor = await readwiseVendor();
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
    expect(passage?.properties["text"]).toBe("Reader passage");
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
