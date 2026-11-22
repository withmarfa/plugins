import type { Entry, OutboundIntent } from "@withmarfa/connector";

/**
 * The rows with a Reader write not yet settled while Reader may not be
 * written. The kit keeps each such row as it is and refuses a read's write
 * to it, so a read leaves it pending rather than stop at it.
 */
export interface Held {
  key(key: string | undefined): boolean;
  entry(entry: Entry): boolean;
  /**
   * A create with no link, whose answer was lost, is held while Reader may not
   * be written. The kit holds every entry of its type for it, so no scope of
   * that type can save progress until it settles.
   */
  unlinkedCreate: boolean;
}

export const nothingHeld: Held = {
  key: () => false,
  entry: () => false,
  unlinkedCreate: false,
};

/** A scope's progress was refused, with the kit's reason. */
export class ProgressNotSaved extends Error {
  constructor(
    what: string,
    readonly reason: string,
  ) {
    super(`${what} was not saved: ${reason}`);
    this.name = "ProgressNotSaved";
  }
}

export const unconfirmedSave =
  "A save to Reader was sent but not confirmed, so Readwise cannot record its progress and imports nothing new. Turn Reader back on with writes allowed, or wait until Reader can be written, and the save settles once; the next run then imports again. Nothing is lost.";

export function heldRows(
  intents: readonly OutboundIntent[],
  writable: boolean,
): Held {
  if (writable || intents.length === 0) return nothingHeld;
  const keys = new Set<string>();
  let unlinkedCreate = false;
  for (const { change } of intents) {
    keys.add(change.item.id);
    if (change.item.source_id) keys.add(change.item.source_id);
    const link = change.item.properties["canonical_key"];
    if (typeof link === "string") keys.add(link);
    else if (change.kind === "created") unlinkedCreate = true;
  }
  const key = (value: string | undefined) =>
    value !== undefined && keys.has(value);
  return {
    key,
    unlinkedCreate,
    entry: (entry) =>
      key(entry.source_id) ||
      (typeof entry.properties["canonical_key"] === "string" &&
        key(entry.properties["canonical_key"])),
  };
}
