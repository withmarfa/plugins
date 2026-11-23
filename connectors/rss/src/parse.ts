import type { Feed, Read } from "./feeds.js";
import {
  decodeFeed,
  maxResultChars,
  readFeed,
  TooManyAttributes,
  TooManyElements,
  TooManyEntries,
} from "./feeds.js";

export class TooBig extends Error {
  override name = "TooBig";
}

export class Unreadable extends Error {
  override name = "Unreadable";
}

export interface ParseInput {
  feed: Pick<Feed, "url" | "key">;
  bytes: Uint8Array;
  contentType: string | null;
  documentUrl: string;
}

/** Whether a read comes to no more than `maxResultChars` once serialized,
 *  counted entry by entry so a value every entry shares is paid for once per
 *  entry and never copied out past the cap. */
function withinCap(read: Read): boolean {
  const { entries, ...rest } = read;
  let length = JSON.stringify(rest).length;
  for (const entry of entries) {
    length += JSON.stringify(entry).length + 1;
    if (length > maxResultChars) return false;
  }
  return true;
}

/**
 * Decodes and reads a feed. What bounds it is its size, which the fetch
 * limits, the counts `readFeed` refuses past (elements, attributes and
 * entries) and the cap on what it reads to; the process's heap limit
 * (`scripts/permission-flags.ts`) stands above all of them.
 */
export function readDocument(input: ParseInput, signal: AbortSignal): Read {
  signal.throwIfAborted();
  let read: Read;
  try {
    read = readFeed(
      input.feed,
      decodeFeed(input.bytes, input.contentType),
      input.documentUrl,
    );
  } catch (error) {
    if (
      error instanceof TooManyEntries ||
      error instanceof TooManyElements ||
      error instanceof TooManyAttributes
    ) {
      throw error;
    }
    throw new Unreadable();
  }
  if (!withinCap(read)) throw new TooBig();
  return read;
}
