import type { TypeDefinition } from "@withmarfa/connector";
import source from "./readwise.source.json" with { type: "json" };
import highlight from "./readwise.highlight.json" with { type: "json" };
export const sourceType = source as TypeDefinition;
export const highlightType = highlight as TypeDefinition;
export const sourceFields = [
  "title",
  "author",
  "description",
  "language",
  "published_at",
  "notes",
  "url",
  "image_url",
  "language",
  "published_at",
  ...Object.keys(source.fields),
];
/**
 * Fields the type still declares, since a published plugin never narrows, that
 * the connector no longer writes. The `retired` entry that clears them from
 * existing rows stays for as long as the type declares them.
 */
export const retiredHighlightFields = ["title", "body"];
export const highlightFields = [
  "text",
  "note",
  "color",
  "locator_type",
  "start_location",
  "end_location",
  ...Object.keys(highlight.fields).filter(
    (field) => !retiredHighlightFields.includes(field),
  ),
];
