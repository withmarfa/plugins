import { createClient, type MarfaClient } from "@withmarfa/client";
import { installPlugin, type InstallOptions } from "./install.js";

/** The key that holds `connectors.manage`, by the address of the server it
 *  belongs to: the owner's reach, which makes the host and sets settings. */
const managers = new Map<string, MarfaClient>();
const managerKeys = new Map<string, string>();
const hosts = new Map<string, Promise<MarfaClient>>();

export function rememberManager(url: string, key: string): void {
  managers.set(url, createClient({ baseUrl: url, credential: key }));
  managerKeys.set(url, key);
}

/** The key itself, for a `marfa` command run as the owner. */
export function managerKeyAt(url: string): string {
  const key = managerKeys.get(url);
  if (key === undefined) throw new Error(`no key manages connectors at ${url}`);
  return key;
}

function managerAt(url: string): MarfaClient {
  const manager = managers.get(url);
  if (manager === undefined)
    throw new Error(`no key manages connectors at ${url}`);
  return manager;
}

/** A request sent with no credential, as a host redeeming its link sends. */
const uncredentialed: typeof fetch = (input, init) => {
  const request = new Request(input, init);
  request.headers.delete("authorization");
  return fetch(request);
};

/** The proof's one connector host at `url`, made and linked as an owner makes
 *  one: `POST /connector-hosts`, then the link's code redeemed. */
function hostAt(url: string): Promise<MarfaClient> {
  let host = hosts.get(url);
  if (host === undefined) {
    host = (async () => {
      const made = await managerAt(url).POST("/connector-hosts", {
        body: { name: "proof host" },
      });
      if (made.data === undefined)
        throw new Error(`the host was refused: ${JSON.stringify(made.error)}`);
      const anonymous = createClient({
        baseUrl: url,
        credential: "none",
        fetch: uncredentialed,
      });
      const redeemed = await anonymous.POST("/connector-hosts/redeem", {
        body: { code: made.data.code },
      });
      if (redeemed.data === undefined)
        throw new Error(
          `the host's link was refused: ${JSON.stringify(redeemed.error)}`,
        );
      return createClient({ baseUrl: url, credential: redeemed.data.key });
    })();
    hosts.set(url, host);
  }
  return host;
}

export interface ConnectorKey {
  id: string;
  key: string;
  source: string;
}

/**
 * The key a connector host mints for `plugin`'s connector at `url`, with the
 * plugin installed and its connector assigned to the proof's host first.
 * Each call mints again, which revokes the key minted before.
 */
export async function connectorKey(
  url: string,
  plugin: string,
  entry?: string,
  options?: InstallOptions,
): Promise<ConnectorKey> {
  await installPlugin(url, plugin, entry, options);
  const host = await hostAt(url);
  // Removing a plugin unassigns its connector, so the assignment is read
  // each time rather than remembered.
  const { data: self } = await host.GET("/connector-hosts/self");
  const manager = managerAt(url);
  const held = await manager.GET("/plugins/{name}/connector", {
    params: { path: { name: plugin } },
  });
  if (held.data?.host !== self?.id) {
    const put = await manager.PUT("/plugins/{name}/connector", {
      params: { path: { name: plugin } },
      body: { host: self?.id ?? null },
    });
    if (put.data === undefined)
      throw new Error(
        `assigning ${plugin} was refused: ${JSON.stringify(put.error)}`,
      );
  }
  const minted = await host.POST(
    "/connector-hosts/self/connectors/{plugin}/key",
    { params: { path: { plugin } } },
  );
  if (minted.data === undefined)
    throw new Error(
      `the host's key for ${plugin} was refused: ${JSON.stringify(minted.error)}`,
    );
  return {
    id: minted.data.key_id,
    key: minted.data.key,
    source: minted.data.source,
  };
}

/**
 * Sets every setting `plugin`'s connector declares through the owner's door,
 * `PATCH /plugins/{name}/connector/settings`: each to its value in `values`,
 * and each not named there back to none, so what one run was given never
 * reaches another. A plugin with no connector, or one that declares no
 * setting, is left as it is.
 */
export async function setSettings(
  url: string,
  plugin: string,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  const manager = managerAt(url);
  const held = await manager.GET("/plugins/{name}/connector/settings", {
    params: { path: { name: plugin } },
  });
  if (held.data === undefined) {
    if (held.response.status === 404 && Object.keys(values).length === 0)
      return;
    throw new Error(
      `the settings of ${plugin} were refused: ${JSON.stringify(held.error)}`,
    );
  }
  const declared = held.data.settings.map((setting) => setting.name);
  const unknown = Object.keys(values).filter(
    (name) => !declared.includes(name),
  );
  if (unknown.length > 0)
    throw new Error(`${plugin} declares no setting ${unknown.join(", ")}`);
  if (declared.length === 0) return;
  const body = Object.fromEntries(
    declared.map((name) => [name, values[name] ?? null]),
  );
  const set = await manager.PATCH("/plugins/{name}/connector/settings", {
    params: { path: { name: plugin } },
    body,
  });
  if (set.data === undefined)
    throw new Error(
      `setting ${plugin}'s settings was refused: ${JSON.stringify(set.error)}`,
    );
}

/**
 * A key minted as `connectorKey` mints it, for a connector that starts
 * afresh: the source's state, problems and agreements are cleared first, as
 * an owner resetting the connector clears them. Item rows stay, so groups
 * sharing a source see the rows an earlier group wrote.
 */
export async function freshConnectorKey(
  url: string,
  plugin: string,
  entry?: string,
  options?: InstallOptions,
): Promise<ConnectorKey> {
  const minted = await connectorKey(url, plugin, entry, options);
  const manager = managerAt(url);
  const listed = await manager.GET("/connectors");
  if (listed.data === undefined)
    throw new Error(
      `the registrations were refused: ${JSON.stringify(listed.error)}`,
    );
  const held = listed.data.data.find((one) => one.source === minted.source);
  if (held !== undefined) {
    const cleared = await manager.DELETE("/connectors/{id}/state", {
      params: { path: { id: held.id } },
    });
    if (cleared.data === undefined)
      throw new Error(
        `clearing ${minted.source}'s state was refused: ${JSON.stringify(cleared.error)}`,
      );
  }
  return minted;
}
