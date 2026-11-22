import type { Archiving, Entry, Item, RowPolicy } from "@withmarfa/connector";
import { exportPolicy } from "./managed.js";
import { readerPolicy } from "./reader/policy.js";
import {
  highlightFields,
  readerMutableHighlightFields,
  readerMutableSourceFields,
  sourceFields,
} from "./readwise.js";

export interface PolicyConfig {
  account: string;
  reader: boolean;
  inboundOnly: boolean;
}

/**
 * With Reader off, nothing is carried. A row Reader does not manage is the
 * export's. With Reader on, Reader owns its verified rows and explicit
 * creates; the export still writes the rest, but only while writing or
 * archiving one, so none of them is ever carried to Reader, and each of
 * their fields mirrors the export. The exception is a row whose export entry
 * came from Reader (`fromReader`), which Reader takes over: its fields Reader
 * can edit keep a change made in Marfa, so Reader's takeover keeps it too.
 */
export function rowPolicy(
  type: string,
  config: PolicyConfig | undefined,
  item: Item | undefined,
  entry?: Entry,
  archiving?: Archiving,
  fromReader?: ReadonlySet<string>,
): RowPolicy {
  if (config === undefined) return { owned: false };
  if (!config.reader) return exportPolicy(type, item, entry);
  const reader = readerPolicy(
    type,
    config.account,
    item,
    entry,
    config.inboundOnly,
  );
  if (reader.owned !== false) return reader;
  if (entry === undefined && archiving === undefined) return { owned: false };
  const policy = exportPolicy(type, item, entry);
  if (policy.owned === false || policy.fields !== undefined) return policy;
  const source = type === "readwise.source";
  const fields = source ? sourceFields : highlightFields;
  const kept: readonly string[] =
    entry !== undefined && fromReader?.has(entry.source_id) === true
      ? source
        ? readerMutableSourceFields
        : readerMutableHighlightFields
      : [];
  return {
    ...policy,
    fields: Object.fromEntries(
      fields.map((field) => [
        field,
        kept.includes(field) ? "observe" : "mirror",
      ]),
    ),
  };
}
