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

async function fixture(settings: Record<string, string> = {}) {
  const marfa = await new ScriptedServer("readwise", {
    types: ["readwise.source", "readwise.highlight", "readwise.file"],
    edges: ["excerpt-of", "references", "attached-to"],
  }).start();
  marfa.grants = { metadata_permissions: { types: "write" } };
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
  const once = async () => {
    await exec("node", [built, "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_API_URL: marfa.url,
        MARFA_API_KEY: marfa.key,
        READWISE_ACCOUNT: "primary",
        READWISE_ACCESS_TOKEN: "reader-fixture-token",
        READWISE_API_URL: `${vendor.base}/v2/`,
        READWISE_READER_API_URL: `${vendor.base}/v3/`,
        ...settings,
      },
    });
  };
  const rows = (type: string) => marfa.rows.filter((row) => row.type === type);
  return { marfa, vendor, once, rows };
}

const readerOn = { READWISE_READER: "true" };

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
  const adopted = async (settings: Record<string, string> = {}) => {
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
      READWISE_READER_PROPAGATE_PURGE: "true",
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
  const values = (settings: Record<string, string | undefined>) =>
    ({
      readwise_account: "primary",
      readwise_access_token: "token",
      ...settings,
    }) as Parameters<NonNullable<ReturnType<typeof connector>["carries"]>>[0];

  it("is nothing unless Reader is on and may be written", () => {
    const carries = connector().carries;
    expect(carries?.(values({}))).toEqual([]);
    expect(carries?.(values({ readwise_reader: "false" }))).toEqual([]);
    expect(
      carries?.(
        values({
          readwise_reader: "true",
          readwise_reader_inbound_only: "true",
        }),
      ),
    ).toEqual([]);
    expect(carries?.(values({ readwise_reader: "true" }))).toEqual([
      "readwise.source",
      "readwise.highlight",
    ]);
  });
});
