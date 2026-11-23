import type {
  Connector,
  Entry,
  Item,
  Kind,
  RunContext,
  ScopedRunContext,
  SettingsDeclaration,
  SettingValues,
} from "./define.js";
import { withoutBodies } from "./exception-text.js";
import { cap, keepSecret, type Logger } from "./log.js";
import {
  fieldMapOf,
  previewOf,
  type KindMapping,
  type Mapping,
  type PreviewResult,
  type ResolvedType,
} from "./mapping.js";
import { Refusal, type Marfa, type Preview } from "./marfa.js";
import { describe } from "./run.js";

/** What Marfa holds of a preview's answer, in bytes of JSON. */
const resultLimit = 65_536;

/** The longest a preview's error may be. */
const errorLimit = 500;

/** The longest the vendor is read for the entries a round of previews needs. */
const probeMs = 60_000;

export interface PreviewWork<E extends SettingsDeclaration> {
  readonly connector: Connector<E>;
  readonly values: SettingValues<E>;
  readonly marfa: Marfa;
  readonly plugin: string;
  readonly logger: Logger;
  readonly signal: AbortSignal;
}

/** Why a preview cannot be rendered, in words for the person who asked. */
class Unrenderable extends Error {}

class Found extends Error {}

function short(logger: Logger, text: string): string {
  const said = cap(withoutBodies(logger.redact(text)).trim(), errorLimit);
  return said === "" ? "the preview could not be rendered" : said;
}

const noTables = {
  created: 0,
  replaced: 0,
  patched: 0,
  unchanged: 0,
  deleted: 0,
  absent: 0,
  refused: [],
  skipped: undefined,
} as const;

/** The entry a person would take for a recent one: the one the vendor
 *  changed last in the first batch it brought, else the first. */
function recent(entries: readonly Entry[]): Entry | undefined {
  let best: Entry | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const at = Date.parse(entry.changed_at ?? entry.occurred_at ?? "");
    const rank = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
    if (best === undefined || rank > bestAt) {
      best = entry;
      bestAt = rank;
    }
  }
  return best;
}

/**
 * Reads the vendor through the connector's own run until it has brought one
 * entry of each type wanted, then stops it. Everything the run would write
 * to Marfa is dropped, and what it asks Marfa for answers as if Marfa held
 * nothing, so nothing is written and the run starts from no saved state.
 */
async function recentEntries<E extends SettingsDeclaration>(
  work: PreviewWork<E>,
  wanted: ReadonlySet<string>,
): Promise<{ found: Map<string, Entry>; problem: string | undefined }> {
  const { connector, values, logger } = work;
  const found = new Map<string, Entry>();
  const stop = new AbortController();
  const signal = AbortSignal.any([
    work.signal,
    stop.signal,
    AbortSignal.timeout(probeMs),
  ]);
  const log: RunContext<E>["log"] = {
    info: (message) => {
      logger.info(`preview: ${message}`);
    },
    warn: (message) => {
      logger.warn(`preview: ${message}`);
    },
    condition: () => undefined,
    unreached: () => undefined,
  };
  const base = {
    env: values,
    signal,
    log,
    secret: (value: string) => {
      keepSecret(logger, value);
    },
    hints: undefined,
    waitUntil: (retryAt: string): Promise<void> =>
      Promise.reject(
        new Error(`the vendor asked the connector to wait until ${retryAt}`),
      ),
    pendingOutbound: () => [],
    upsert: (type: string, entries: readonly Entry[]): Promise<void> => {
      if (!wanted.has(type) || found.has(type)) return Promise.resolve();
      const taken = recent(entries);
      if (taken === undefined) return Promise.resolve();
      found.set(type, taken);
      if (found.size < wanted.size) return Promise.resolve();
      stop.abort();
      return Promise.reject(new Found());
    },
    archive: () => Promise.resolve(),
    derive: () => Promise.resolve(),
    linked: () => Promise.resolve([]),
    linkedEach: (
      _type: string,
      _connection: string,
      targets: { readonly ids: readonly string[] },
    ) =>
      Promise.resolve(
        new Map<string, Item[]>(targets.ids.map((id) => [id, []])),
      ),
    known: () => Promise.resolve(new Set<string>()),
    held: () => Promise.resolve([]),
    inspect: () => Promise.resolve({ items: [], tombstones: [] }),
    written: (type: string): readonly string[] =>
      connector.types.find((kind) => kind.type.id === type)?.fields ?? [],
    tables: {
      put: () => Promise.resolve(noTables),
      patch: () => Promise.resolve(noTables),
      remove: () => Promise.resolve(noTables),
      replace: () => Promise.resolve(noTables),
      read: () => Promise.resolve(undefined),
    },
  };
  const scoped = (): ScopedRunContext<E> => ({
    ...base,
    state: {
      get: () => undefined,
      checkpoint: () => Promise.resolve({ committed: true }),
    },
    refusals: { pending: () => [] },
  });
  const context: RunContext<E> = {
    ...base,
    state: { get: () => undefined, set: () => undefined },
    forScope: scoped,
  };
  let thrown: unknown;
  try {
    await connector.run(context);
  } catch (error) {
    if (!(error instanceof Found)) thrown = error;
  }
  if (found.size === wanted.size) return { found, problem: undefined };
  if (work.signal.aborted) return { found, problem: "the connector stopped" };
  return {
    found,
    problem:
      thrown === undefined
        ? undefined
        : `the vendor could not be read for a recent entry: ${describe(thrown)}`,
  };
}

/** What a read of an item or type says, in the words of a preview's error. */
function unreachable(error: unknown, what: string): unknown {
  if (
    error instanceof Refusal &&
    (error.status === 403 || error.status === 404)
  )
    return new Unrenderable(`${what} is out of this connector's reach`);
  return error;
}

/**
 * Answers every mapping preview waiting on the connector: renders the kind
 * named, under the draft mapping the preview holds or the mapping in force,
 * on the item it names or a recent entry from the vendor, and answers with
 * the item as it would land, or why it cannot. Writes nothing to Marfa or
 * the vendor but the answers. One preview that fails never stops another.
 */
export async function answerPreviews<E extends SettingsDeclaration>(
  work: PreviewWork<E>,
): Promise<void> {
  const { connector, marfa, plugin, logger, signal } = work;
  let waiting: Preview[];
  try {
    waiting = await marfa.pendingPreviews(plugin, signal);
  } catch (error) {
    if (!signal.aborted)
      logger.warn(`the pending previews could not be read: ${describe(error)}`);
    return;
  }
  if (waiting.length === 0) return;

  const kindOf = (name: string): Kind | undefined =>
    connector.types.find((kind) => kind.name === name);
  const types = new Map<string, Promise<ResolvedType | undefined>>();
  const typeOf = async (id: string): Promise<ResolvedType> => {
    let held = types.get(id);
    if (held === undefined) {
      held = marfa.resolvedType(id);
      types.set(id, held);
    }
    const type = await held.catch((error: unknown) => {
      types.delete(id);
      throw error;
    });
    if (type === undefined)
      throw new Unrenderable(`Marfa holds no type ${id} to render it as`);
    return type;
  };
  let inForce: Promise<Mapping> | undefined;
  const mappingInForce = (): Promise<Mapping> => {
    inForce ??= marfa.mapping(plugin, signal);
    return inForce;
  };

  const needing = new Set(
    waiting
      .filter((one) => one.item_id === null)
      .flatMap((one) => {
        const kind = kindOf(one.kind);
        return kind === undefined ? [] : [kind.type.id];
      }),
  );
  let entries:
    | Promise<{ found: Map<string, Entry>; problem: string | undefined }>
    | undefined;
  const entryOf = async (kind: Kind): Promise<Entry> => {
    entries ??= recentEntries(work, needing);
    const { found, problem } = await entries;
    const entry = found.get(kind.type.id);
    if (entry !== undefined) return entry;
    throw new Unrenderable(
      problem ?? `the vendor brought no entry of the kind ${kind.name ?? ""}`,
    );
  };

  const itemOf = async (id: string): Promise<Item> => {
    let item: Item | undefined;
    try {
      item = await marfa.item(id);
    } catch (error) {
      throw unreachable(error, "the item");
    }
    if (item === undefined)
      throw new Unrenderable("the item is gone, or is in the bin");
    if (item.source !== connector.source)
      throw new Unrenderable("the item is not one this connector wrote");
    return item;
  };

  const render = async (preview: Preview): Promise<PreviewResult> => {
    const kind = kindOf(preview.kind);
    if (kind === undefined)
      throw new Unrenderable(`this connector has no kind ${preview.kind}`);
    const own = await typeOf(kind.type.id);
    const mapping = await mappingInForce();
    const held: KindMapping = mapping.kinds[preview.kind] ?? {};
    const chosen: KindMapping = preview.mapping ?? held;
    const target = await typeOf(chosen.target_type ?? own.id);
    const item =
      preview.item_id === null ? undefined : await itemOf(preview.item_id);
    let from: Parameters<typeof previewOf>[0]["from"];
    let named: string | null = null;
    if (item === undefined) from = { entry: await entryOf(kind) };
    else if (preview.mapping === null) {
      const heldTarget = held.target_type ?? own.id;
      if (item.type !== own.id && item.type !== heldTarget)
        throw new Unrenderable(
          `the item is held as ${item.type}, which is neither ${own.id} nor ${heldTarget}`,
        );
      from = { item };
    } else {
      // A draft is applied to what the item holds read back through the
      // mapping in force, as an entry the kind would bring.
      const heldTarget = held.target_type ?? own.id;
      named = item.id;
      if (item.type === heldTarget) {
        const map = fieldMapOf({
          kind,
          mapping: held,
          own,
          target: await typeOf(heldTarget),
        });
        from = {
          entry: {
            source_id: item.source_id ?? item.id,
            properties: map.read(item.properties, undefined, item.id),
          },
        };
      } else if (item.type === own.id) {
        from = {
          entry: {
            source_id: item.source_id ?? item.id,
            properties: { ...item.properties },
          },
        };
      } else {
        throw new Unrenderable(
          `the item is held as ${item.type}, which is neither ${own.id} nor ${heldTarget}`,
        );
      }
    }
    const { result, conditions } = await previewOf({
      kind,
      mapping: chosen,
      own,
      target,
      from,
    });
    const faults = [...conditions]
      .filter(([key]) => key.startsWith("mapping-template:"))
      .map(([, message]) => message);
    if (faults.length > 0) throw new Unrenderable(faults.join("; "));
    const rendered: PreviewResult =
      named === null ? result : { ...result, source_item: named };
    const bytes = Buffer.byteLength(JSON.stringify(rendered));
    if (bytes > resultLimit)
      throw new Unrenderable(
        `the item as it would land is ${String(bytes)} bytes, over the ${String(resultLimit)} a preview may hold`,
      );
    return rendered;
  };

  // Read through a call, since the signal can abort while a request waits.
  const over = (): boolean => signal.aborted;
  for (const preview of waiting) {
    if (over()) return;
    let answer: { result: PreviewResult } | { error: string };
    try {
      answer = { result: await render(preview) };
    } catch (error) {
      if (over()) return;
      answer = {
        error: short(
          logger,
          error instanceof Unrenderable ? error.message : describe(error),
        ),
      };
    }
    try {
      await marfa.answerPreview(plugin, preview.id, answer, signal);
    } catch (error) {
      // Answered meanwhile, or expired: nothing is left to answer.
      if (
        error instanceof Refusal &&
        (error.status === 409 || error.status === 404)
      )
        continue;
      if (!over())
        logger.warn(
          `a preview could not be answered: ${short(logger, describe(error))}`,
        );
    }
  }
}
