import { describe, expect, it } from "vitest";
import {
  fitKinds,
  highlightFields,
  highlightPassage,
  highlightKinds,
  highlightType,
  isDate,
  isDatetime,
  mapHighlight,
  mapReaderHighlight,
  mapReaderSource,
  mapSource,
  readwisePassageLimit,
  sourceKinds,
  sourceType,
  urlValue,
} from "../src/readwise.js";

const picture =
  "![](https://readwise-assets.s3.amazonaws.com/media/picture.png)";
function reader(content: string, extra: Record<string, unknown> = {}) {
  return {
    id: "hi",
    category: "highlight",
    parent_id: "doc",
    content,
    notes: "",
    tags: null,
    ...extra,
  };
}

describe("highlight passage", () => {
  it("writes the whole passage to text and names the highlight nothing", () => {
    const exported = mapHighlight("one", 7, {
      id: 42,
      text: "# 9:06 PM\n\nJesse asks",
      note: "n",
    });
    expect(exported.properties).toMatchObject({
      text: "# 9:06 PM\n\nJesse asks",
      note: "n",
    });
    expect(exported.properties).not.toHaveProperty("title");
    expect(exported.properties).not.toHaveProperty("body");
    expect(
      mapHighlight("one", 7, { id: 43, text: picture }).properties,
    ).toMatchObject({
      text: picture,
    });
  });
  it("takes the export Markdown whole, and Reader's passage when Readwise cut the export", () => {
    const markdown = 'Joan Didion: *"I write"*';
    const marked = mapReaderHighlight("one", reader('Joan Didion: "I write"'), {
      properties: { readwise_text: markdown, reader_managed: true },
    }).entry.properties;
    expect(marked["text"]).toBe(markdown);
    expect(marked).not.toHaveProperty("title");
    expect(marked).not.toHaveProperty("body");
    const whole = `${"word ".repeat(1_300)}end`;
    const cut = whole.slice(0, readwisePassageLimit);
    expect(
      mapReaderHighlight("one", reader(whole), {
        properties: { readwise_text: cut, reader_managed: true },
      }).entry.properties["text"],
    ).toBe(whole);
    expect(highlightPassage("", picture)).toBe(picture);
    expect(highlightPassage("Plain", "  ")).toBe("Plain");
  });
  it("keeps a picture-only passage, which Reader holds as no words", () => {
    const mapped = mapReaderHighlight("one", reader(""), {
      properties: { readwise_text: picture, reader_managed: true },
    });
    expect(mapped.entry.properties["text"]).toBe(picture);
    expect(mapped.entry.properties).not.toHaveProperty("title");
  });
  it("writes the same passage from the export's and Reader's mappings", () => {
    const text = "**Strategy** is a coherent response\nto a challenge";
    const exported = mapHighlight("one", 7, { id: 42, text, note: "n" });
    const read = mapReaderHighlight(
      "one",
      reader("Strategy is a coherent response\nto a challenge"),
      { properties: { readwise_text: text, reader_managed: true } },
    );
    expect(read.entry.properties["text"]).toBe(exported.properties["text"]);
  });
  it("drops a title and body an earlier release wrote when Reader maps the row", () => {
    const mapped = mapReaderHighlight("one", reader("Words"), {
      properties: {
        reader_managed: true,
        title: "Old title",
        body: "Old body",
        text: "Words",
      },
    });
    expect(mapped.entry.properties).not.toHaveProperty("title");
    expect(mapped.entry.properties).not.toHaveProperty("body");
  });
  it("keeps the whole passage in a text file when it exceeds a property", () => {
    const passage = `Opening line\n\n${"x".repeat(100_001)}`;
    const mapped = mapReaderHighlight("one", reader(passage));
    expect(mapped.entry.properties["text"]).toBe(
      "Complete text is preserved in the attached text file.",
    );
    expect(mapped.entry.properties).not.toHaveProperty("body");
    expect(mapped.textFiles.map(({ field, text }) => [field, text])).toEqual([
      ["text", passage],
    ]);
  });
  it("inherits core.highlight's display hints and still declares the fields it published", () => {
    expect(highlightType.display_hints).toBeUndefined();
    expect(highlightType.fields["title"]?.type).toBe("string");
    expect(highlightType.fields["body"]?.type).toBe("string");
    expect(highlightFields).not.toContain("title");
    expect(highlightFields).not.toContain("body");
  });
});

describe("field kinds", () => {
  it("declares every date, time and address field with its kind", () => {
    const kinds = new Set(["url", "datetime", "date"]);
    const formats = (fields: typeof sourceType.fields) =>
      Object.fromEntries(
        Object.entries(fields)
          .filter(([, field]) => kinds.has(field.type))
          .map(([name, field]) => [name, field.type]),
      );
    expect(formats(sourceType.fields)).toMatchObject({
      source_url: "url",
      cover_image_url: "url",
      unique_url: "url",
      readwise_url: "url",
      reader_url: "url",
      reader_source_url: "url",
      reader_image_url: "url",
      reader_created_at: "datetime",
      reader_updated_at: "datetime",
      reader_first_opened_at: "datetime",
      reader_last_opened_at: "datetime",
      reader_saved_at: "datetime",
      reader_last_moved_at: "datetime",
      reader_published_date: "date",
    });
    expect(formats(highlightType.fields)).toMatchObject({
      url: "url",
      readwise_url: "url",
      highlighted_at: "datetime",
      readwise_created_at: "datetime",
      readwise_updated_at: "datetime",
      reader_published_date: "date",
    });
    for (const fields of [sourceType.fields, highlightType.fields])
      for (const [name, field] of Object.entries(fields))
        if (/_(at|url)$/.test(name))
          expect(kinds.has(field.type), name).toBe(true);
  });
  it("judges values as the server does", () => {
    expect(isDatetime("2025-08-18T14:18:02.485953+00:00")).toBe(true);
    expect(isDatetime("2025-08-18")).toBe(true);
    expect(isDatetime("2025-08-18T14:18Z")).toBe(true);
    expect(isDatetime("2025-08-18T14:18:02")).toBe(false);
    expect(isDatetime("2025-08-18t14:18:02z")).toBe(false);
    expect(isDatetime("2025-02-30T00:00:00Z")).toBe(false);
    expect(isDatetime("2025-08-18T24:00:00Z")).toBe(false);
    expect(isDate("2024-02-29")).toBe(true);
    expect(isDate("2025-02-29")).toBe(false);
    expect(isDate("2025-08-18T00:00:00Z")).toBe(false);
    expect(urlValue(" https://exa\tmple.com/a\n ")).toBe(
      "https://example.com/a",
    );
    expect(urlValue("private://read/01k2")).toBe("private://read/01k2");
    expect(urlValue("mailto:reader-forwarded-email/abc")).toBe(
      "mailto:reader-forwarded-email/abc",
    );
    expect(urlValue("")).toBeUndefined();
    expect(urlValue("not a url")).toBeUndefined();
  });
  it("leaves a blank value out and keeps a refused one under original_values", () => {
    const values: Record<string, unknown> = {
      reader_image_url: "",
      reader_url: " https://read.readwise.io/read/x ",
      reader_published_date: "2025-13-01",
      reader_saved_at: "2025-08-18T14:18:02.114000+00:00",
      original_values: { reader_url: "stale", readwise_url: "kept" },
    };
    fitKinds(values, sourceKinds);
    expect(values).toEqual({
      reader_url: "https://read.readwise.io/read/x",
      reader_saved_at: "2025-08-18T14:18:02.114000+00:00",
      original_values: {
        reader_published_date: "2025-13-01",
        readwise_url: "kept",
      },
    });
    const clean: Record<string, unknown> = { highlighted_at: "2025-08-18" };
    fitKinds(clean, highlightKinds);
    expect(clean).toEqual({ highlighted_at: "2025-08-18" });
  });
  it("writes a Reader row whose values a kind refuses", () => {
    const source = mapReaderSource("one", {
      id: "doc",
      category: "article",
      title: "Doc",
      image_url: "",
      published_date: "2025-08-18",
      saved_at: "yesterday",
      url: "https://read.readwise.io/read/doc",
    });
    expect(source.entry.properties).toMatchObject({
      reader_published_date: "2025-08-18",
      reader_url: "https://read.readwise.io/read/doc",
      original_values: { reader_saved_at: "yesterday" },
    });
    expect(source.entry.properties).not.toHaveProperty("reader_image_url");
    expect(source.entry.properties).not.toHaveProperty("reader_saved_at");
    const repaired = mapReaderSource(
      "one",
      { id: "doc", category: "article", saved_at: "2025-08-18T14:18:02Z" },
      { properties: source.entry.properties },
    );
    expect(repaired.entry.properties).not.toHaveProperty("original_values");
    expect(repaired.entry.properties["reader_saved_at"]).toBe(
      "2025-08-18T14:18:02Z",
    );
  });
  it("writes an export row whose values a kind refuses", () => {
    const source = mapSource("one", {
      user_book_id: 7,
      title: "Book",
      highlights: [],
      source_url: "",
      readwise_url: "https://readwise.io/bookreview/7",
      cover_image_url: "cover.png",
    });
    expect(source.properties).toMatchObject({
      readwise_url: "https://readwise.io/bookreview/7",
      original_values: { cover_image_url: "cover.png" },
    });
    expect(source.properties).not.toHaveProperty("source_url");
    const highlight = mapHighlight("one", 7, {
      id: 42,
      text: "Passage",
      highlighted_at: "2025-08-18 14:18",
    });
    expect(highlight.properties).toMatchObject({
      original_values: { highlighted_at: "2025-08-18 14:18" },
    });
    expect(highlight.occurred_at).toBeUndefined();
  });
});
