import type { Archiving, Entry, Item, RowPolicy } from "@withmarfa/connector";
import { exportPolicy } from "./managed.js";
import { readerPolicy } from "./reader/policy.js";
import { highlightFields, sourceFields } from "./readwise.js";

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
 * their fields mirrors the export.
 */
export function rowPolicy(
  type: string,
  config: PolicyConfig | undefined,
  item: Item | undefined,
  entry?: Entry,
  archiving?: Archiving,
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
  const fields = type === "readwise.source" ? sourceFields : highlightFields;
  return {
    ...policy,
    fields: Object.fromEntries(fields.map((field) => [field, "mirror"])),
  };
}
