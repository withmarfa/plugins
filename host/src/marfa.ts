import { createClient, type components } from "@withmarfa/client";

export type Self = components["schemas"]["ConnectorHostSelf"];
export type Assigned = Self["connectors"][number];
export type Code = components["schemas"]["PluginConnectorCode"];

/** A call that got no answer, or one the host cannot act on now. */
function failure(response: Response | undefined, error: unknown): string {
  if (response === undefined)
    return error instanceof Error ? error.message : String(error);
  const body = error as { code?: unknown; detail?: unknown } | undefined;
  const code = typeof body?.code === "string" ? ` ${body.code}` : "";
  return `${String(response.status)}${code}`;
}

/** What a door the host calls answered, made plain. */
async function call<T>(
  send: () => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<
  | { ok: true; data: T }
  | { ok: false; status: number | undefined; reason: string }
> {
  try {
    const { data, error, response } = await send();
    if (data !== undefined) return { ok: true, data };
    return {
      ok: false,
      status: response.status,
      reason: failure(response, error),
    };
  } catch (error) {
    return { ok: false, status: undefined, reason: failure(undefined, error) };
  }
}

/** A request sent with no credential, as redeeming a link is. */
const uncredentialed =
  (send: typeof fetch): typeof fetch =>
  (input, init) => {
    const request = new Request(input, init);
    request.headers.delete("authorization");
    return send(request);
  };

export class RedeemRefused extends Error {
  override name = "RedeemRefused";
}

export interface Redeemed {
  host: { id: string; name: string };
  key: string;
}

/** Redeems a one-time link's code for the host's key (`plugins/redeem`). */
export async function redeem(
  origin: string,
  code: string,
  send: typeof fetch = fetch,
): Promise<Redeemed> {
  const client = createClient({
    baseUrl: origin,
    credential: "none",
    fetch: uncredentialed(send),
  });
  const answer = await call(() =>
    client.POST("/connector-hosts/redeem", {
      body: { code },
      signal: AbortSignal.timeout(30_000),
    }),
  );
  if (answer.ok)
    return {
      host: { id: answer.data.host.id, name: answer.data.host.name },
      key: answer.data.key,
    };
  switch (answer.status) {
    case 404:
      throw new RedeemRefused(
        "Marfa did not take the link: it was used already, it is more than 15 minutes old, or a newer link replaced it. Make a new link with `marfa hosts link <host>` and install again.",
      );
    case 429:
      throw new RedeemRefused(
        "Marfa refused the link after too many tries from this address. Wait 15 minutes, then install again with a new link.",
      );
    case 400:
      throw new RedeemRefused(
        "Marfa did not take the link's code. Copy the whole link Marfa gave you and install again.",
      );
    case undefined:
      throw new RedeemRefused(
        `Could not reach Marfa at ${origin}: ${answer.reason}. Check the address and the network, then install again.`,
      );
    default:
      throw new RedeemRefused(
        `Marfa at ${origin} answered ${answer.reason} to the link. Install again with a new link.`,
      );
  }
}

export type SelfAnswer =
  | { kind: "ok"; self: Self }
  | { kind: "unlinked" }
  | { kind: "failed"; reason: string };

export type Minted =
  | { kind: "ok"; key: string }
  | { kind: "unassigned" }
  | { kind: "unlinked" }
  | { kind: "failed"; reason: string };

export interface StartFailure {
  plugin: string;
  key: string;
  readOnlyTypes: string[];
  at: Date;
  error: string;
}

/** The doors a linked host uses. */
export interface HostApi {
  /** `GET /connector-hosts/self`. */
  self(): Promise<SelfAnswer>;
  /** `POST /connector-hosts/self/connectors/{plugin}/key`. */
  mint(plugin: string): Promise<Minted>;
  /** Registers with the connector's own key, as the kit does, and reports
   *  one failed run. */
  reportStartFailure(failure: StartFailure): Promise<void>;
}

export function hostApi(
  origin: string,
  hostKey: string,
  send: typeof fetch = fetch,
): HostApi {
  const host = createClient({
    baseUrl: origin,
    credential: hostKey,
    fetch: send,
  });
  const timeout = (): AbortSignal => AbortSignal.timeout(30_000);
  return {
    async self() {
      const answer = await call(() =>
        host.GET("/connector-hosts/self", { signal: timeout() }),
      );
      if (answer.ok) return { kind: "ok", self: answer.data };
      if (answer.status === 401) return { kind: "unlinked" };
      return { kind: "failed", reason: answer.reason };
    },
    async mint(plugin) {
      const answer = await call(() =>
        host.POST("/connector-hosts/self/connectors/{plugin}/key", {
          params: { path: { plugin } },
          signal: timeout(),
        }),
      );
      if (answer.ok) return { kind: "ok", key: answer.data.key };
      if (answer.status === 401) return { kind: "unlinked" };
      if (answer.status === 404) return { kind: "unassigned" };
      return { kind: "failed", reason: answer.reason };
    },
    async reportStartFailure(failed) {
      const connector = createClient({
        baseUrl: origin,
        credential: failed.key,
        fetch: send,
      });
      const registered = await call(() =>
        connector.POST("/connectors", {
          body: {
            name: failed.plugin,
            ...(failed.readOnlyTypes.length > 0 && {
              read_only_types: failed.readOnlyTypes,
            }),
          },
          signal: timeout(),
        }),
      );
      if (!registered.ok)
        throw new Error(`registering was refused: ${registered.reason}`);
      const at = failed.at.toISOString();
      const reported = await call(() =>
        connector.POST("/connectors/{id}/runs", {
          params: { path: { id: registered.data.id } },
          body: {
            outcome: "failed",
            started_at: at,
            finished_at: at,
            error: failed.error,
          },
          signal: timeout(),
        }),
      );
      if (!reported.ok)
        throw new Error(`the run was refused: ${reported.reason}`);
    },
  };
}
