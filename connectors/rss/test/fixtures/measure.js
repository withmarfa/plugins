// Reads one strained document through the built connector's read in a
// process of its own, whose high-water marks start clean, and prints how it
// ended and how much the process grew.
/* global process, TextEncoder, AbortSignal, console */
import { resolve } from "node:path";
import {
  attributeDocument,
  bareAttributesDocument,
  heavyDocument,
  manyElementsDocument,
  nestedElementsDocument,
  sharedDocument,
  unquotedAttributesDocument,
  wideDocument,
} from "./documents.js";

const { readDocument } = await import(
  resolve(import.meta.dirname, "../../dist/parse.js")
);
const text = {
  heavy: heavyDocument,
  shared: sharedDocument,
  attributes: attributeDocument,
  wide: wideDocument,
  bare: bareAttributesDocument,
  unquoted: unquotedAttributesDocument,
  many: manyElementsDocument,
  nested: nestedElementsDocument,
}[process.argv[2]]();
const bytes = new TextEncoder().encode(text);
const rss = process.resourceUsage().maxRSS;
const heap = process.memoryUsage().heapUsed;
let outcome;
let held;
try {
  held = readDocument(
    {
      feed: { url: "https://example.org/rss.xml", key: "k" },
      bytes,
      contentType: null,
      documentUrl: "https://example.org/rss.xml",
    },
    AbortSignal.timeout(60_000),
  );
  outcome = `read ${String(held.entries.length)}`;
} catch (error) {
  outcome = error.name;
}
console.log(
  JSON.stringify({
    outcome,
    heapMiB: (process.memoryUsage().heapUsed - heap) / 1048576,
    rssMiB: (process.resourceUsage().maxRSS - rss) / 1024,
    held: held !== undefined,
  }),
);
