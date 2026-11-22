import type { RunContext } from "@withmarfa/connector";
import { pictureListing } from "./readwise.js";
import { heldRows } from "./held.js";
import { settings } from "./settings.js";
import { parseConfig } from "./reader/config.js";
import { sync as exportSync, type ReadContext } from "./export-sync.js";
import { sync as readerSync, type ReaderContext } from "./reader/sync.js";

type Context = RunContext<typeof settings> & ReadContext & ReaderContext;

/**
 * Reads the export, then, with Reader on, Reader's documents. Reader reads
 * even when the export fails, since the two answer from separate APIs, and
 * the first failure is the run's. `fromReader` gains the source ID of each
 * export entry from Reader, whose row Reader takes over.
 */
export async function sync(
  context: Context,
  fromReader?: Set<string>,
): Promise<void> {
  const config = parseConfig(context.env);
  fromReader?.clear();
  const held = heldRows(
    context.pendingOutbound(),
    config.reader && !config.inboundOnly,
  );
  if (!config.reader) {
    await exportSync(context, { held });
    return;
  }
  const pictures =
    config.pictures === "addresses"
      ? undefined
      : pictureListing(
          context.forScope("reader-pictures").state,
          config.pictures,
        );
  let failure: { error: unknown } | undefined;
  try {
    await exportSync(context, {
      readerListing: true,
      held,
      ...(fromReader !== undefined && { fromReader }),
      ...(pictures !== undefined && { pictures }),
    });
  } catch (error) {
    context.signal.throwIfAborted();
    failure = { error };
  }
  try {
    await readerSync(context);
  } catch (error) {
    throw failure === undefined ? error : failure.error;
  }
  if (failure !== undefined) throw failure.error;
}
