import type { Entry, OutboundIntent } from "@withmarfa/connector";

/**
 * The rows with a Reader write not yet settled while Reader may not be
 * written. The kit keeps each such row as it is and refuses a read's write
 * to it, so a read leaves it pending rather than stop at it.
 */
export interface Held {
  key(key: string | undefined): boolean;
  entry(entry: Entry): boolean;
}

export const nothingHeld: Held = { key: () => false, entry: () => false };

export function heldRows(
  intents: readonly OutboundIntent[],
  writable: boolean,
): Held {
  if (writable || intents.length === 0) return nothingHeld;
  const keys = new Set<string>();
  for (const { change } of intents) {
    keys.add(change.item.id);
    if (change.item.source_id) keys.add(change.item.source_id);
    const link = change.item.properties["canonical_key"];
    if (typeof link === "string") keys.add(link);
  }
  const key = (value: string | undefined) =>
    value !== undefined && keys.has(value);
  return {
    key,
    entry: (entry) =>
      key(entry.source_id) ||
      (typeof entry.properties["canonical_key"] === "string" &&
        key(entry.properties["canonical_key"])),
  };
}
