import type { HeldSettings } from "./settings.js";
import { isDeepStrictEqual } from "node:util";
import {
  pages,
  type components,
  type MarfaClient,
  type operations,
} from "@withmarfa/client";
import type { Item, TypeDefinition } from "./define.js";
import type {
  Mapping,
  ResolvedType,
  Rewrite,
  StatusField,
  TypeMap,
} from "./mapping.js";

export type BulkResult = components["schemas"]["BulkResultEntry"];
/** The schema types a delivery's headers as pairs, but the fetch client's
 *  response type turns every tuple into an array, so a row is read as one. */
export type InboundDeliveryRow = Omit<
  components["schemas"]["InboundDelivery"],
  "headers"
> & { headers: string[][] };
export type InboundEndpoint = components["schemas"]["InboundEndpoint"];
export type InboundOutcome = NonNullable<InboundDeliveryRow["outcome"]>;
type Version = components["schemas"]["Version"];
export type Key = components["schemas"]["ApiKey"];
export type Tombstone = components["schemas"]["Tombstone"];
export type Edge = components["schemas"]["Edge"];

/** The tag Marfa gives the copy it writes when two edits to a
 *  `keep_both_copies` property collide. */
export const conflictedCopyTag = "conflicted-copy";
export type EdgeType = components["schemas"]["EdgeType"];
export type TableRowOperation = components["schemas"]["RowOperation"];
export type TableRowRecord = components["schemas"]["TableRow"];
export type RowBatchResult = components["schemas"]["RowBatchResult"];

/** Edges one bulk request carries, well inside the door's 5000. */
const edgePage = 1000;

/** The server's cap on the keys one lookup names. */
const lookupCap = 500;

/** The server's cap on the rows a page of a listing holds. */
const listingPage = 500;

/** The most rows a page of a table's rows holds. */
const tablePage = 1000;

/** The server's caps on the conditions and the length of a filter. */
const filterConditions = 10;
const filterLength = 2048;

function edgeCondition(inbound: boolean, edgeType: string, id: string): string {
  return `${inbound ? "backref" : "edge"}[${edgeType}] eq ${JSON.stringify(id)}`;
}

/** The ids cut into groups whose conditions, joined by `OR`, one filter
 *  takes. */
function filterGroups(
  ids: readonly string[],
  most: number,
  condition: (id: string) => string,
): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let length = 0;
  for (const id of ids) {
    const added = condition(id).length + (group.length === 0 ? 0 : 4);
    if (
      group.length > 0 &&
      (group.length === most || length + added > filterLength)
    ) {
      groups.push(group);
      group = [];
      length = 0;
    }
    length += condition(id).length + (group.length === 0 ? 0 : 4);
    group.push(id);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}
export type RunReport = NonNullable<
  operations["reportConnectorRun"]["requestBody"]
>["content"]["application/json"];

/** `status` is absent on one entry of a bulk answer, which the page's own
 *  status does not describe. */
export class Refusal extends Error {
  override name = "Refusal";

  constructor(
    readonly status: number | undefined,
    readonly code: string,
    readonly detail: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    /** What a `Retry-After` named, where the answer carried one. */
    readonly retryAfterMs?: number | undefined,
  ) {
    super(
      `${status === undefined ? "" : `${String(status)} `}${code}: ${detail}`,
    );
  }
}

/** A call that got no answer from Marfa: the connection was refused, cut
 *  or timed out, or could not be made. A timeout carries no cause; any
 *  other keeps the transport's, so it reads as the error it replaces. */
export class MarfaUnreachable extends Error {
  override name = "MarfaUnreachable";

  constructor(
    message: string,
    options?: ErrorOptions & {
      timedOut?: boolean;
      fault?: string | undefined;
    },
  ) {
    super(message, options);
    this.timedOut = options?.timedOut === true;
    this.fault = options?.fault;
  }

  /** The request ran out of time, as against being refused or cut. */
  readonly timedOut: boolean;

  /** Says what is wrong with the address where the transport names it: a
   *  host that is not found, or a certificate or TLS handshake refused. It
   *  may mend, so a start exits 1, or tries again under --every, and a
   *  running connector waits it out. */
  readonly fault: string | undefined;
}

/** The key no longer reaches what the connector writes, found on a run:
 *  every later write would be refused too. */
export class KeyNarrowed extends Error {
  override name = "KeyNarrowed";
}

/** What the key may not write of the connector's own types and connections,
 *  each named with its family. */
export function keyNarrowerThanTypes(
  key: Key,
  types: ReadonlySet<string>,
  connections: ReadonlySet<string>,
): string[] {
  return [
    ...[...types]
      .filter((name) => key.type_permissions[name] !== "write")
      .map((name) => `type ${name}`),
    ...[...connections]
      .filter((name) => key.edge_permissions[name] !== "write")
      .map((name) => `edge ${name}`),
  ];
}

/** The address cannot be used whatever Marfa does: it redirects, or is not a
 *  URL. No retry mends it. */
export class MarfaAddress extends Error {
  override name = "MarfaAddress";
}

/** What the transport's code says is wrong with the address, for a code a
 *  start refuses and a running connector waits out. */
const faults = new Map<string, string>([
  ["ENOTFOUND", "the host was not found"],
  ["EPROTO", "the TLS handshake was refused"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "the certificate is not trusted"],
  ["SELF_SIGNED_CERT_IN_CHAIN", "the certificate is not trusted"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "the certificate is not trusted"],
  ["UNABLE_TO_GET_ISSUER_CERT", "the certificate is not trusted"],
  ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "the certificate is not trusted"],
  ["CERT_UNTRUSTED", "the certificate is not trusted"],
  ["CERT_HAS_EXPIRED", "the certificate has expired"],
  ["CERT_NOT_YET_VALID", "the certificate is not yet valid"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "the certificate is for another host"],
  ["HOSTNAME_MISMATCH", "the certificate is for another host"],
]);

function transportError(error: TypeError): Error {
  const cause: unknown = error.cause;
  const code = (value: unknown): unknown =>
    value instanceof Error ? (value as NodeJS.ErrnoException).code : undefined;
  const named = code(cause) ?? code(error);
  // A redirect is the one failure undici gives no code, only this message.
  if (cause instanceof Error && cause.message === "unexpected redirect") {
    return new MarfaAddress("the server redirected the request", { cause });
  }
  if (named === "ERR_INVALID_URL") {
    return new MarfaAddress(`${error.message} (ERR_INVALID_URL)`, { cause });
  }
  return new MarfaUnreachable(error.message, {
    cause,
    fault: typeof named === "string" ? faults.get(named) : undefined,
  });
}

/** How long a call may take: `whole`, `ms` for all of it; `quiet`, `ms`
 *  without a byte of its body sent, and `ms` for the answer after the last,
 *  so a large upload is never cut off for its size. */
export type Timing = "whole" | "quiet";

/** The transport for every call to Marfa: a call that gets no answer fails
 *  as `MarfaUnreachable` or, where the address itself is at fault, as
 *  `MarfaAddress`. A timeout is wrapped whoever's timer it was, and a call
 *  its caller aborted is left as it was. `signal`, where given, ends every
 *  call made through it. */
export function marfaFetch(
  ms: number,
  signal?: AbortSignal,
  timing: Timing = "whole",
): typeof fetch {
  return async (input, init) => {
    try {
      let request = new Request(input, init);
      let timer = AbortSignal.timeout(ms);
      if (timing === "quiet" && request.body !== null) {
        const quiet = new AbortController();
        const expire = setTimeout(() => {
          quiet.abort(new DOMException("no progress", "TimeoutError"));
        }, ms);
        expire.unref();
        const body = request.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              expire.refresh();
              controller.enqueue(chunk);
            },
            flush() {
              expire.refresh();
            },
          }),
        );
        request = new Request(request, { body, duplex: "half" });
        timer = quiet.signal;
      }
      // Handed to fetch as its own option: built into a copy of the request,
      // the timer's signal is collected before it fires.
      return await fetch(request, {
        signal: AbortSignal.any([
          request.signal,
          timer,
          ...(signal === undefined ? [] : [signal]),
        ]),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new MarfaUnreachable(error.message, { timedOut: true });
      }
      if (error instanceof TypeError) throw transportError(error);
      throw error;
    }
  };
}

/** Whose failure an error is, by what it is and never by what it says:
 *  - `marfa`: no answer from Marfa, or one that asks for time (408, 429,
 *    5xx);
 *  - `key`: a key Marfa refuses, or one that no longer reaches the
 *    connector's types;
 *  - `registration`: a connector Marfa no longer holds, or a type of its
 *    own, the only kind the kit names, so registering again mends both;
 *  - `address`: an address that cannot be used;
 *  - `refused`: Marfa answered, and refused or could not be understood;
 *  - `run`: anything else, which is the connector's own run and its vendor. */
export type Cause =
  "marfa" | "refused" | "key" | "registration" | "address" | "run";

export function causeOf(error: unknown): Cause {
  for (
    let at: unknown = error, depth = 0;
    at instanceof Error && depth < 8;
    at = at.cause, depth += 1
  ) {
    if (at instanceof MarfaUnreachable) return "marfa";
    if (at instanceof MarfaAddress) return "address";
    if (at instanceof KeyNarrowed) return "key";
    if (!(at instanceof Refusal)) continue;
    if (at.status === 401) return "key";
    if (
      (at.status === 404 && at.code === "connector_not_found") ||
      at.code === "unknown_type"
    ) {
      return "registration";
    }
    if (
      at.status !== undefined &&
      (at.status >= 500 || at.status === 429 || at.status === 408)
    ) {
      return "marfa";
    }
    return "refused";
  }
  return "run";
}

/** What is wrong with the address, where the transport said, however deep
 *  in the error. */
export function faultOf(error: unknown): string | undefined {
  for (
    let at: unknown = error, depth = 0;
    at instanceof Error && depth < 8;
    at = at.cause, depth += 1
  ) {
    if (at instanceof MarfaUnreachable) return at.fault;
  }
  return undefined;
}

/** The wait a refusal asked for, however deep in the error it sits. */
export function retryAfterOf(error: unknown): number | undefined {
  for (
    let at: unknown = error, depth = 0;
    at instanceof Error && depth < 8;
    at = at.cause, depth += 1
  ) {
    if (at instanceof Refusal) return at.retryAfterMs;
  }
  return undefined;
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  if (header.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const at = Date.parse(header);
  const date = Date.parse(response.headers.get("date") ?? "");
  const from = Number.isFinite(date) ? date : Date.now();
  return Number.isFinite(at) ? Math.max(0, at - from) : undefined;
}

function refusal(response: Response, error: unknown): Refusal {
  const envelope = (
    error as
      | { error?: { code?: unknown; message?: unknown; details?: unknown } }
      | undefined
  )?.error;
  const code = typeof envelope?.code === "string" ? envelope.code : "unknown";
  const message =
    typeof envelope?.message === "string"
      ? envelope.message
      : response.statusText;
  const details =
    typeof envelope?.details === "object" && envelope.details !== null
      ? (envelope.details as Record<string, unknown>)
      : {};
  return new Refusal(
    response.status,
    code,
    message,
    details,
    retryAfter(response),
  );
}

export interface NewRow {
  source_id: string;
  properties: Record<string, unknown>;
  occurred_at?: string;
}

/** The longest a run's report is given to land, which no fence cuts short. */
const reportMs = 15_000;

export class Marfa {
  private readonly client: MarfaClient;
  private readonly uploads: MarfaClient;

  /** `clientFor` makes a client every call of which `signal` ends, which is
   *  how a run's calls are held to its hold: the hold's signal aborts when
   *  the hold can no longer be trusted, so a write sent just before that
   *  cannot land after the hold lapsed. */
  constructor(
    private readonly clientFor: (
      signal?: AbortSignal,
      timing?: Timing,
    ) => MarfaClient,
    private readonly signal?: AbortSignal,
    private readonly root: MarfaClient = clientFor(),
    private readonly types?: TypeMap,
  ) {
    this.client = signal === undefined ? root : clientFor(signal);
    this.uploads = clientFor(signal, "quiet");
  }

  /** This connection, every call of which but the run's report ends with
   *  `signal`. */
  scoped(signal: AbortSignal): Marfa {
    return new Marfa(this.clientFor, signal, this.root, this.types);
  }

  /**
   * This connection, naming each of the connector's types as the mapping
   * writes it: a type sent is the kind's target, and an item answered is
   * named by the kind's own type, so the rest of the kit names rows as the
   * connector does.
   */
  withTypes(types: TypeMap): Marfa {
    return new Marfa(this.clientFor, this.signal, this.root, types);
  }

  private out(type: string): string {
    return this.types?.out(type) ?? type;
  }

  /** An item answered, named by the connector's own type. */
  seen<T extends Item>(item: T): T {
    return this.types?.item(item) ?? item;
  }

  private unmapped: Marfa | undefined;

  /** This connection, naming types as they are given. */
  private get raw(): Marfa {
    return (this.unmapped ??= new Marfa(
      this.clientFor,
      this.signal,
      this.root,
    ));
  }

  /** A lookup on each type a mapped kind's rows are held as: its target, and
   *  its own type, which keeps the rows written before the mapping until a
   *  rewrite moves them. */
  private async lookupMapped(
    type: string,
    by:
      | { links: readonly string[] }
      | { source: string; source_ids: readonly string[] }
      | { ids: readonly string[] },
  ): Promise<{ data: Item[]; tombstones: Tombstone[] }> {
    const reads = this.types?.reads(type) ?? [type];
    const found = { data: [] as Item[], tombstones: [] as Tombstone[] };
    const seen = new Set<string>();
    for (const read of "ids" in by ? reads.slice(0, 1) : reads) {
      const held = this.types?.heldLink(read);
      let answer: { data: Item[]; tombstones: Tombstone[] };
      if (held !== undefined && "links" in by) {
        // The target finds no row by a link it does not name as its own, so
        // the rows are read by id and kept where they hold the link now.
        const ids = await this.linksOf(read, held);
        const named = new Set(by.links);
        const listed = await this.raw.lookup(read, {
          ids: [
            ...new Set(
              by.links.flatMap((link) => {
                const id = ids.get(link);
                return id === undefined ? [] : [id];
              }),
            ),
          ],
        });
        answer = {
          data: listed.data.filter((row) => {
            const link = row.properties[held];
            return typeof link === "string" && named.has(link);
          }),
          tombstones: [],
        };
      } else answer = await this.raw.lookup(read, by);
      for (const row of answer.data) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        found.data.push(this.seen(row));
      }
      found.tombstones.push(...answer.tombstones);
    }
    return found;
  }

  /** For each target whose rows hold their link only as a property, the
   *  ids of the connector's rows by link, read once. */
  private readonly heldLinks = new Map<string, Promise<Map<string, string>>>();

  private linksOf(target: string, field: string): Promise<Map<string, string>> {
    let held = this.heldLinks.get(target);
    if (held === undefined) {
      held = (async () => {
        const ids = new Map<string, string>();
        const walk = pages(async (cursor) => {
          const { data, error, response } = await this.client.GET("/items", {
            params: {
              query: {
                type: target,
                state: "any",
                limit: listingPage,
                ...(cursor !== undefined && { cursor }),
              },
            },
          });
          if (data === undefined) throw refusal(response, error);
          return data;
        });
        for await (const listed of walk) {
          const row = "item" in listed ? listed.item : listed;
          const link = row.properties[field];
          if (row.type === target && typeof link === "string")
            ids.set(link, row.id);
        }
        return ids;
      })();
      held.catch(() => this.heldLinks.delete(target));
      this.heldLinks.set(target, held);
    }
    return held;
  }

  /** Notes the link a row now holds, where its target's rows hold their
   *  link only as a property. */
  private noteLink(item: Item): void {
    const field = this.types?.heldLink(item.type);
    const held = this.heldLinks.get(item.type);
    if (field === undefined || held === undefined) return;
    const link = item.properties[field];
    void held.then((ids) => {
      for (const [value, id] of ids) if (id === item.id) ids.delete(value);
      if (typeof link === "string") ids.set(link, item.id);
    });
  }

  /** The owner's mapping of the connector's kinds, as its own key reads it. */
  async mapping(plugin: string, signal?: AbortSignal): Promise<Mapping> {
    const { data, error, response } = await this.client.GET(
      "/plugins/{name}/connector/mapping",
      {
        params: { path: { name: plugin } },
        ...(signal !== undefined && { signal }),
      },
    );
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  /** Clears a rewrite the connector carried out, answering those that wait. */
  async rewriteDone(plugin: string, number: number): Promise<Rewrite[]> {
    const { data, error, response } = await this.client.POST(
      "/plugins/{name}/connector/mapping/rewrite/done",
      { params: { path: { name: plugin } }, body: { number } },
    );
    if (data === undefined) throw refusal(response, error);
    return data.rewrites;
  }

  /** Moves a row to another type, setting the properties named and clearing
   *  the ones listed, at the version read. Sends the types as named. */
  async retype(
    id: string,
    version: number,
    type: string,
    properties: Record<string, unknown>,
    clear: readonly string[],
  ): Promise<Item> {
    const { data, error, response } = await this.client.PATCH("/items/{id}", {
      params: { path: { id } },
      body: {
        version,
        type,
        retype: true,
        version_match: "exact",
        properties,
        ...(clear.length > 0 && { clear_properties: [...clear] }),
      },
    });
    if (data === undefined) throw refusal(response, error);
    return data.item;
  }

  /** A registered type with every field it inherits, or `undefined` where
   *  the instance holds none by that id, or will not show it. */
  async resolvedType(id: string): Promise<ResolvedType | undefined> {
    const fields = new Set<string>();
    const tables = new Set<string>();
    const above: string[] = [];
    let link: string | undefined;
    let status: StatusField | undefined;
    let titleField: string | undefined;
    let next: string | undefined = id;
    while (next !== undefined) {
      if (next !== id && (above.includes(next) || above.length > 32)) break;
      const asked: string = next;
      const { data, error, response } = await this.client.GET("/types/{id}", {
        params: { path: { id: asked } },
      });
      if (response.status === 404 || response.status === 403) {
        if (next === id) return undefined;
        break;
      }
      if (data === undefined) throw refusal(response, error);
      for (const field of Object.keys(data.fields)) fields.add(field);
      for (const table of Object.keys(data.tables ?? {})) tables.add(table);
      link ??= data.link_field ?? undefined;
      titleField ??= data.display_hints?.title_field ?? undefined;
      if (next === id) {
        // A type read answers every word its chain gives the field.
        for (const [field, definition] of Object.entries(data.fields)) {
          if (definition.type !== "status") continue;
          status = {
            field,
            words: (definition.status_values ?? []).map(({ value, group }) => ({
              value,
              group,
            })),
          };
        }
      } else if (status === undefined) {
        const inherited = Object.entries(data.fields).find(
          ([, definition]) => definition.type === "status",
        );
        if (inherited !== undefined)
          status = { field: inherited[0], words: [] };
      }
      if (next !== id) above.push(next);
      next = data.parent ?? undefined;
    }
    return { id, fields, tables, link, above, status, titleField };
  }

  async register(
    name: string,
    description: string | undefined,
    readOnlyTypes: readonly string[],
  ): Promise<string> {
    const { data, error, response } = await this.client.POST("/connectors", {
      body: {
        name,
        ...(description !== undefined && { description }),
        ...(readOnlyTypes.length > 0 && {
          read_only_types: [...readOnlyTypes],
        }),
      },
    });
    if (data === undefined) throw refusal(response, error);
    return data.id;
  }

  /** The types the connector's registration holds read only. */
  async readOnlyTypes(id: string, signal?: AbortSignal): Promise<string[]> {
    const { data, error, response } = await this.client.GET(
      "/connectors/{id}",
      { params: { path: { id } }, ...(signal !== undefined && { signal }) },
    );
    if (data === undefined) throw refusal(response, error);
    return data.read_only_types;
  }

  /** The types the key's own registration holds read only, where it is
   *  registered. */
  async heldReadOnlyTypes(keyId: string): Promise<string[] | undefined> {
    const { data, error, response } = await this.client.GET("/connectors");
    if (data === undefined) throw refusal(response, error);
    return data.data.find((one) => one.key_id === keyId)?.read_only_types;
  }

  /** The connector's settings, its secrets opened, as its own key reads
   *  them. */
  async settings(id: string, signal?: AbortSignal): Promise<HeldSettings> {
    const { data, error, response } = await this.client.GET(
      "/connectors/{id}/settings",
      { params: { path: { id } }, ...(signal !== undefined && { signal }) },
    );
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  async heartbeat(id: string, signal: AbortSignal): Promise<void> {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/heartbeat",
      { params: { path: { id } }, signal },
    );
    if (data === undefined) throw refusal(response, error);
  }

  /** Sent after a fence too, so it is not held to a run's signal. */
  async report(id: string, run: RunReport): Promise<void> {
    const { data, error, response } = await this.root.POST(
      "/connectors/{id}/runs",
      {
        params: { path: { id } },
        body: run,
        signal: AbortSignal.timeout(reportMs),
      },
    );
    if (data === undefined) throw refusal(response, error);
  }

  async currentKey(): Promise<Key> {
    const { data, error, response } = await this.client.GET("/keys/current");
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  /** What the key, read again now, may not write of these. */
  async narrower(
    types: ReadonlySet<string>,
    connections: ReadonlySet<string>,
  ): Promise<string[]> {
    return keyNarrowerThanTypes(await this.currentKey(), types, connections);
  }

  async source(code: string): Promise<components["schemas"]["Source"]> {
    const { data, error, response } = await this.client.GET(
      "/sources/{source}",
      {
        params: { path: { source: code } },
      },
    );
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  async nameSource(
    code: string,
    body: { name?: string; mark?: string },
  ): Promise<void> {
    const { data, error, response } = await this.client.PATCH(
      "/sources/{source}",
      {
        params: { path: { source: code } },
        body,
      },
    );
    if (data === undefined) throw refusal(response, error);
  }

  async normalizeType(
    type: TypeDefinition,
  ): Promise<components["schemas"]["NormalizedType"]> {
    const { data, error, response } = await this.client.POST(
      "/types/normalize",
      { body: type },
    );
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  /** Every row of one of an item's tables, in the table's own order. */
  async tableRows(id: string, table: string): Promise<TableRowRecord[]> {
    const rows: TableRowRecord[] = [];
    const walk = pages(async (cursor) => {
      const { data, error, response } = await this.client.GET(
        "/items/{id}/tables/{table}/rows",
        {
          params: {
            path: { id, table },
            query: {
              limit: tablePage,
              ...(cursor !== undefined && { cursor }),
            },
          },
        },
      );
      if (data === undefined) throw refusal(response, error);
      return data;
    });
    for await (const row of walk) rows.push(row);
    return rows;
  }

  /** One batch of changes to an item's table, which the server writes whole or
   *  not at all; a batch sent again under its key writes nothing again. */
  async writeTableRows(
    id: string,
    table: string,
    operations: readonly TableRowOperation[],
    idempotencyKey: string,
  ): Promise<RowBatchResult> {
    const { data, error, response } = await this.client.POST(
      "/items/{id}/tables/{table}/rows",
      {
        params: {
          path: { id, table },
          header: { "Idempotency-Key": idempotencyKey },
        },
        body: { operations: [...operations] },
      },
    );
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  /** Every edge type the instance holds, which the door answers in one page. */
  async edgeTypes(): Promise<EdgeType[]> {
    const { data, error, response } = await this.client.GET("/edge-types");
    if (data === undefined) throw refusal(response, error);
    return data.data;
  }

  async edgesFrom(
    type: string,
    ids: readonly string[],
    edgeTypes: ReadonlySet<string>,
  ): Promise<Map<string, { item: Item; edges: Edge[] }>> {
    const found = new Map<string, { item: Item; edges: Edge[] }>();
    for (let at = 0; at < ids.length; at += lookupCap) {
      const { data, error, response } = await this.client.POST(
        "/items/lookup",
        {
          body: {
            type: this.out(type),
            ids: ids.slice(at, at + lookupCap),
            include: ["edges"],
          },
        },
      );
      if (data === undefined) throw refusal(response, error);
      for (const item of data.data) {
        const edges: Edge[] = [];
        for (const [edgeType, page] of Object.entries(item.edges ?? {})) {
          if (!edgeTypes.has(edgeType)) continue;
          edges.push(
            ...page.data,
            ...(page.next_cursor === null
              ? []
              : await this.moreEdges(item.id, edgeType, page.next_cursor)),
          );
        }
        const row: Item = this.seen({ ...item });
        Reflect.deleteProperty(row, "edges");
        found.set(item.id, { item: row, edges });
      }
    }
    return found;
  }

  private async moreEdges(
    id: string,
    edgeType: string,
    from: string,
  ): Promise<Edge[]> {
    const edges: Edge[] = [];
    const walk = pages(async (cursor) => {
      const { data, error, response } = await this.client.GET(
        "/items/{id}/edges",
        {
          params: {
            path: { id },
            query: { edge_type: edgeType, limit: 200, cursor: cursor ?? from },
          },
        },
      );
      if (data === undefined) throw refusal(response, error);
      return data;
    });
    for await (const edge of walk) edges.push(edge);
    return edges;
  }

  /** The edges of one type that point at a row, which a lookup does not
   *  carry. */
  async edgesInto(id: string, edgeType: string): Promise<Edge[]> {
    const edges: Edge[] = [];
    const walk = pages(async (cursor) => {
      const { data, error, response } = await this.client.GET(
        "/items/{id}/backrefs",
        {
          params: {
            path: { id },
            query: {
              edge_type: edgeType,
              limit: 200,
              ...(cursor !== undefined && { cursor }),
            },
          },
        },
      );
      if (data === undefined) throw refusal(response, error);
      return data;
    });
    for await (const edge of walk) edges.push(edge);
    return edges;
  }

  /**
   * Every edge of one type that the key may read, or `undefined` once
   * `budget` pages were read and the listing went on. The server cuts pages
   * of 500 from every edge of the type before it leaves out the ones the key
   * may not read, so a page can be short or empty. It holds edges whatever
   * the type of their ends, so a caller keeps the ones it asked about.
   */
  async edgesOfType(
    edgeType: string,
    budget: number,
  ): Promise<Edge[] | undefined> {
    const edges: Edge[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < budget; page += 1) {
      const { data, error, response } = await this.client.GET("/edges", {
        params: {
          query: {
            edge_type: edgeType,
            limit: 500,
            ...(cursor !== undefined && { cursor }),
          },
        },
      });
      if (data === undefined) throw refusal(response, error);
      edges.push(...data.data);
      if (data.next_cursor === null) return edges;
      cursor = data.next_cursor;
    }
    return undefined;
  }

  async connect(
    edges: readonly {
      from_id: string;
      to_id: string;
      edge_type: string;
    }[],
  ): Promise<BulkResult[]> {
    const results: BulkResult[] = [];
    for (let at = 0; at < edges.length; at += edgePage) {
      const page = edges.slice(at, at + edgePage);
      const { data, error, response } = await this.client.POST("/edges/bulk", {
        body: { edges: [...page], atomic: false },
      });
      if (data === undefined) throw refusal(response, error);
      results.push(
        ...data.results.map((result) => ({
          ...result,
          index: result.index + at,
        })),
      );
    }
    return results;
  }

  async connectExact(item: Item, type: string, target: string): Promise<void> {
    const { data, error, response } = await this.client.POST("/edges", {
      body: { from_id: item.id, to_id: target, edge_type: type },
      querySerializer: () => `from_version=${String(item.version)}`,
    });
    if (data === undefined) {
      const failed = refusal(response, error);
      if (
        failed.code === "edge_constraint_violation" &&
        failed.details["constraint"] === "duplicate"
      )
        return;
      throw failed;
    }
  }

  /** Makes an inbound endpoint, answering its path in full this once. */
  async createEndpoint(
    id: string,
    options: { label?: string; duplicateHeader?: string },
  ): Promise<InboundEndpoint> {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/endpoints",
      {
        params: { path: { id } },
        body: {
          ...(options.label !== undefined && { label: options.label }),
          ...(options.duplicateHeader !== undefined && {
            duplicate_header: options.duplicateHeader,
          }),
        },
      },
    );
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  async retireEndpoint(id: string, endpointId: string): Promise<void> {
    const { data, error, response } = await this.client.DELETE(
      "/connectors/{id}/endpoints/{endpoint_id}",
      { params: { path: { id, endpoint_id: endpointId } } },
    );
    if (data === undefined) throw refusal(response, error);
  }

  async upload(
    bytes: Uint8Array | ReadableStream<Uint8Array>,
    mimeType: string,
  ): Promise<{ hash: string; mime_type: string }> {
    const { data, error, response } = await this.uploads.POST("/blobs", {
      body: bytes,
      // The client labels bytes `application/octet-stream` unless told; the
      // blob keeps the type of its first upload.
      headers: { "Content-Type": mimeType },
    });
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  /** Removes an edge; one already gone is as good. */
  async disconnect(id: string, sourceVersion?: number): Promise<void> {
    const { error, response } = await this.client.DELETE("/edges/{id}", {
      params: { path: { id } },
      ...(sourceVersion !== undefined && {
        querySerializer: () => `from_version=${String(sourceVersion)}`,
      }),
    });
    if (response.ok || response.status === 404) return;
    throw refusal(response, error);
  }

  /** `/items?type=` matches subtypes, so callers filter by exact type. With
   *  `edges`, each row carries its outbound edges (`include=edges`), the
   *  first page of each edge type. */
  async ownRows(
    type: string,
    state: "any" | "active" = "any",
    edges = false,
  ): Promise<Item[]> {
    if (this.types !== undefined) {
      const rows: Item[] = [];
      for (const read of this.types.reads(type))
        for (const row of await this.raw.ownRows(read, state, edges))
          rows.push(this.seen(row));
      return rows;
    }
    const rows: Item[] = [];
    const walk = pages(async (cursor) => {
      const { data, error, response } = await this.client.GET("/items", {
        params: {
          query: {
            type,
            state,
            ...(edges && { include: "edges" }),
            limit: listingPage,
            ...(cursor !== undefined && { cursor }),
          },
        },
      });
      if (data === undefined) throw refusal(response, error);
      return data;
    });
    // A page asked for without `include` carries bare items.
    for await (const row of walk) rows.push("item" in row ? row.item : row);
    return rows;
  }

  /**
   * For each target, the active rows of a type that hold an edge of the type
   * to it, or with `inbound` that it holds one to. A filter names at most
   * ten targets, joined by `OR`, so many targets are first sought in a
   * listing of the edge type, which is given up once it takes as many pages
   * as the filters would take requests: never more than twice the cheaper
   * read. A row's own edges say which of a filter's targets it holds; an
   * inbound filter names one target, since a row's inbound edges are not
   * listed with it.
   */
  async connectedTo(
    type: string,
    edgeType: string,
    targetIds: readonly string[],
    inbound = false,
  ): Promise<Map<string, Item[]>> {
    if (this.types !== undefined) {
      const merged = new Map<string, Item[]>(targetIds.map((id) => [id, []]));
      for (const read of this.types.reads(type)) {
        const found = await this.raw.connectedTo(
          read,
          edgeType,
          targetIds,
          inbound,
        );
        for (const [target, rows] of found)
          merged.get(target)?.push(...rows.map((row) => this.seen(row)));
      }
      return merged;
    }
    const found = new Map<string, Item[]>(targetIds.map((id) => [id, []]));
    if (found.size === 0) return found;
    const groups = filterGroups(
      [...found.keys()],
      inbound ? 1 : filterConditions,
      (id) => edgeCondition(inbound, edgeType, id),
    );
    const listed =
      groups.length < 2
        ? undefined
        : await this.edgesOfType(edgeType, groups.length);
    if (listed !== undefined) {
      const pairs = listed.flatMap((edge) => {
        const [target, row] = inbound
          ? [edge.from_id, edge.to_id]
          : [edge.to_id, edge.from_id];
        return found.has(target) ? [{ target, row }] : [];
      });
      const rows = new Map(
        (
          await this.lookup(type, {
            ids: [...new Set(pairs.map((p) => p.row))],
          })
        ).data
          .filter((row) => row.type === type && row.state === "active")
          .map((row) => [row.id, row] as const),
      );
      for (const { target, row } of pairs) {
        const item = rows.get(row);
        if (item !== undefined) found.get(target)?.push(item);
      }
      return found;
    }
    for (const group of groups) {
      const walk = pages(async (cursor) => {
        const { data, error, response } = await this.client.GET("/items", {
          params: {
            query: {
              type,
              filter: group
                .map((id) => edgeCondition(inbound, edgeType, id))
                .join(" OR "),
              ...(group.length > 1 && { include: "edges" }),
              limit: listingPage,
              ...(cursor !== undefined && { cursor }),
            },
          },
        });
        if (data === undefined) throw refusal(response, error);
        return data;
      });
      for await (const listed of walk) {
        const row: Item = { ...("item" in listed ? listed.item : listed) };
        const block = row.edges?.[edgeType];
        Reflect.deleteProperty(row, "edges");
        const held =
          group.length === 1
            ? group
            : [
                ...(block?.data ?? []),
                ...(block === undefined || block.next_cursor === null
                  ? []
                  : await this.moreEdges(row.id, edgeType, block.next_cursor)),
              ]
                .map((edge) => edge.to_id)
                .filter((target) => group.includes(target));
        for (const target of new Set(held)) found.get(target)?.push(row);
      }
    }
    return found;
  }

  async lookup(
    type: string,
    by:
      | { links: readonly string[] }
      | { source: string; source_ids: readonly string[] }
      | { ids: readonly string[] },
  ): Promise<{ data: Item[]; tombstones: Tombstone[] }> {
    if (this.types !== undefined) return this.lookupMapped(type, by);
    const keys =
      "links" in by ? by.links : "ids" in by ? by.ids : by.source_ids;
    const found: { data: Item[]; tombstones: Tombstone[] } = {
      data: [],
      tombstones: [],
    };
    for (let at = 0; at < keys.length; at += lookupCap) {
      const page = keys.slice(at, at + lookupCap);
      const { data, error, response } = await this.client.POST(
        "/items/lookup",
        {
          body: {
            type,
            ...("links" in by
              ? { links: page }
              : "ids" in by
                ? { ids: page }
                : { source: by.source, source_ids: page }),
          },
        },
      );
      if (data === undefined) throw refusal(response, error);
      found.data.push(...data.data);
      found.tombstones.push(...data.tombstones);
    }
    return found;
  }

  async settleTombstones(
    type: string,
    by:
      | { links: readonly string[] }
      | { source: string; source_ids: readonly string[] },
    at: string,
  ): Promise<void> {
    if (this.types !== undefined) {
      for (const read of this.types.reads(type)) {
        // A link's tombstone names no source, so a target that is not the
        // connector's own type settles none by link: its natural key does.
        if ("links" in by && read !== type) continue;
        await this.raw.settleTombstones(read, by, at);
      }
      return;
    }
    const { data, error, response } = await this.client.POST(
      "/items/tombstones",
      {
        body: {
          type,
          settled_at: at,
          ...("links" in by
            ? { links: [...by.links] }
            : { source: by.source, source_ids: [...by.source_ids] }),
        },
      },
    );
    if (data === undefined) throw refusal(response, error);
  }

  async transition(
    id: string,
    state: "active" | "archived",
    version?: number,
  ): Promise<Item> {
    const { data, error, response } = await this.client.POST(
      "/items/{id}/transition",
      {
        params: { path: { id } },
        body: { state },
        ...(version !== undefined && {
          querySerializer: () => `version=${String(version)}`,
        }),
      },
    );
    if (data === undefined) throw refusal(response, error);
    return this.seen(data.item);
  }

  /** One row as it stands, or `undefined` once purged or in the bin. */
  async item(id: string): Promise<Item | undefined> {
    const { data, error, response } = await this.client.GET("/items/{id}", {
      params: { path: { id } },
    });
    if (response.status === 404) return undefined;
    if (data === undefined) throw refusal(response, error);
    return this.seen(data.item);
  }

  /** A row's tags, or `undefined` once it is purged or in the bin. */
  async tags(id: string): Promise<string[] | undefined> {
    const { data, error, response } = await this.client.GET("/items/{id}", {
      params: { path: { id } },
    });
    if (response.status === 404) return undefined;
    if (data === undefined) throw refusal(response, error);
    return data.metadata.tags;
  }

  async versions(id: string): Promise<Version[]> {
    const { data, error, response } = await this.client.GET(
      "/items/{id}/versions",
      { params: { path: { id } } },
    );
    if (data === undefined) throw refusal(response, error);
    const types = this.types;
    if (types === undefined) return data.data;
    return data.data.map((version) => ({
      ...version,
      properties: types.view(id, version.properties),
    }));
  }

  async merge(
    id: string,
    version: number,
    properties: Record<string, unknown>,
    exact = false,
  ): Promise<Item> {
    const { data, error, response } = await this.client.PATCH("/items/{id}", {
      params: { path: { id } },
      body: {
        version,
        properties: this.types?.properties(properties, { id }) ?? properties,
        ...(exact && { version_match: "exact" }),
      },
    });
    if (data === undefined) throw refusal(response, error);
    this.noteLink(data.item);
    return this.seen(data.item);
  }

  /** The log from a cursor, as frames: head, retained events plus
   *  anything written meanwhile, a marker, then new events. */
  async events(
    types: readonly string[],
    cursor: string | undefined,
    signal: AbortSignal,
    edges: boolean,
  ): Promise<ReadableStream<Uint8Array>> {
    const { data, error, response } = await this.client.GET("/events", {
      params: {
        query: {
          type: [
            ...new Set(
              types.flatMap((type) => this.types?.reads(type) ?? [type]),
            ),
          ].join(","),
          edges: edges ? "all" : "none",
        },
        ...(cursor !== undefined && { header: { "Last-Event-ID": cursor } }),
      },
      parseAs: "stream",
      signal,
    });
    if (data === undefined || data === null) throw refusal(response, error);
    return data;
  }

  /** Creates rows through the bulk door, each claiming at version 0 that
   *  no row holds its natural key, and each answered on its own. A create
   *  names no tier: the server gives the tier the owner's mapping chose for
   *  the kind, the feed by default. */
  async create(
    type: string,
    source: string,
    rows: readonly NewRow[],
  ): Promise<BulkResult[]> {
    const { data, error, response } = await this.client.POST("/items/bulk", {
      body: {
        items: rows.map((row) => ({
          type: this.out(type),
          source,
          source_id: row.source_id,
          properties:
            this.types?.properties(row.properties, { type }) ??
            row.properties,
          ...(row.occurred_at !== undefined && {
            occurred_at: row.occurred_at,
          }),
          version: 0,
        })),
        atomic: false,
      },
    });
    if (data === undefined) throw refusal(response, error);
    return data.results;
  }

  /** Replaces a row's properties at the version read; on a moved version
   *  the server merges over what landed, shown by a jump past one. */
  async update(
    id: string,
    version: number,
    properties: Record<string, unknown>,
    occurredAt: string | undefined,
    sourceId?: string,
    exact = false,
  ): Promise<Item> {
    const { data, error, response } = await this.client.PATCH("/items/{id}", {
      params: { path: { id } },
      body: {
        version,
        properties: this.types?.properties(properties, { id }) ?? properties,
        properties_mode: "replace",
        ...(exact && { version_match: "exact" }),
        ...(occurredAt !== undefined && { occurred_at: occurredAt }),
        ...(sourceId !== undefined && { source_id: sourceId }),
      },
    });
    if (data === undefined) throw refusal(response, error);
    this.noteLink(data.item);
    return this.seen(data.item);
  }

  async endpoints(id: string): Promise<InboundEndpoint[]> {
    const { data, error, response } = await this.client.GET(
      "/connectors/{id}/endpoints",
      { params: { path: { id } } },
    );
    if (data === undefined) throw refusal(response, error);
    return data.data;
  }

  async pendingDeliveries(
    id: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<InboundDeliveryRow[]> {
    const rows: InboundDeliveryRow[] = [];
    const walk = pages(async (cursor) => {
      const { data, error, response } = await this.client.GET(
        "/connectors/{id}/deliveries",
        {
          params: {
            path: { id },
            query: {
              state: "pending",
              limit: Math.min(200, limit - rows.length),
              ...(cursor !== undefined && { cursor }),
            },
          },
          signal,
        },
      );
      if (data === undefined) throw refusal(response, error);
      return data;
    });
    for await (const row of walk) {
      rows.push(row);
      if (rows.length >= limit) break;
    }
    return rows;
  }

  async deliveryBody(
    id: string,
    deliveryId: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const { data, error, response } = await this.client.GET(
      "/connectors/{id}/deliveries/{delivery_id}/body",
      {
        params: { path: { id, delivery_id: deliveryId } },
        parseAs: "arrayBuffer",
        signal,
      },
    );
    if (!response.ok) throw refusal(response, error);
    // A zero-length `200` is an empty body, and the client reads it as no data.
    return new Uint8Array(data ?? new ArrayBuffer(0));
  }

  /** The first mark stands. */
  async handled(
    id: string,
    ids: readonly string[],
    outcome: InboundOutcome,
  ): Promise<void> {
    for (let at = 0; at < ids.length; at += 200) {
      const { data, error, response } = await this.client.POST(
        "/connectors/{id}/deliveries/handled",
        {
          params: { path: { id } },
          body: { ids: ids.slice(at, at + 200), outcome },
        },
      );
      if (data === undefined) throw refusal(response, error);
    }
  }

  async hold(
    id: string,
    process: string,
    signal: AbortSignal,
  ): Promise<
    | {
        elsewhere: false;
        until: string;
        renewed: boolean;
        /** How long the instance holds it, in milliseconds. */
        ttlMs: number;
      }
    | { elsewhere: true; until: string }
  > {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/hold",
      { params: { path: { id } }, body: { process }, signal },
    );
    if (data !== undefined) {
      // A window that is no positive number would never fence a run.
      if (!Number.isFinite(data.ttl_seconds) || data.ttl_seconds <= 0) {
        throw new Refusal(
          response.status,
          "invalid_hold_window",
          `the hold answered no usable hold window (ttl_seconds ${String(data.ttl_seconds)})`,
        );
      }
      return {
        elsewhere: false,
        until: data.expires_at,
        renewed: data.renewed,
        ttlMs: data.ttl_seconds * 1000,
      };
    }
    const refused = refusal(response, error);
    const until = refused.details["expires_at"];
    if (refused.code === "connector_held" && typeof until === "string") {
      return { elsewhere: true, until };
    }
    throw refused;
  }

  async release(id: string, process: string): Promise<void> {
    const { data, error, response } = await this.client.DELETE(
      "/connectors/{id}/hold",
      { params: { path: { id }, query: { process } } },
    );
    if (data === undefined) throw refusal(response, error);
  }

  async connectorState(id: string): Promise<unknown> {
    const { data, error, response } = await this.client.GET(
      "/connectors/{id}/state",
      { params: { path: { id } } },
    );
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  async putConnectorState(
    id: string,
    process: string,
    state: Record<string, unknown>,
    problems: Record<string, string>,
  ): Promise<void> {
    const intended = JSON.parse(JSON.stringify({ state, problems })) as {
      state: Record<string, unknown>;
      problems: Record<string, string>;
    };
    const { data, error, response } = await this.client.PUT(
      "/connectors/{id}/state",
      { params: { path: { id } }, body: { process, ...intended } },
    );
    if (data === undefined) throw refusal(response, error);
    if (
      !isDeepStrictEqual(data.state, intended.state) ||
      !isDeepStrictEqual(data.problems, intended.problems)
    ) {
      throw new Error(
        "invalid state acknowledgment; restart before writing again",
      );
    }
  }

  async lookupAgreements(
    id: string,
    itemIds: readonly string[],
  ): Promise<{ item_id: string; record: unknown }[]> {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/agreements/lookup",
      { params: { path: { id } }, body: { item_ids: [...itemIds] } },
    );
    if (data === undefined) throw refusal(response, error);
    return data.data;
  }

  /** The connector's agreements, page by page, or only those waiting. */
  agreements(
    id: string,
    signal: AbortSignal,
    { waiting = false }: { waiting?: boolean } = {},
  ): AsyncIterable<{ item_id: string; record: unknown }> {
    return pages(async (cursor) => {
      const { data, error, response } = await this.client.GET(
        "/connectors/{id}/agreements",
        {
          params: {
            path: { id },
            query: {
              ...(waiting && { waiting: true as const }),
              limit: 200,
              ...(cursor !== undefined && { cursor }),
            },
          },
          signal,
        },
      );
      if (data === undefined) throw refusal(response, error);
      return data;
    });
  }

  async writeAgreements(
    id: string,
    process: string,
    set: readonly { item_id: string; waiting: boolean; record: object }[],
    clear: readonly string[],
  ): Promise<{ written: number; cleared: number; skipped: string[] }> {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/agreements",
      {
        params: { path: { id } },
        body: {
          process,
          set: set.map((entry) => ({
            ...entry,
            record: entry.record as Record<string, unknown>,
          })),
          clear: [...clear],
        },
      },
    );
    if (data === undefined) throw refusal(response, error);
    return data;
  }
}
