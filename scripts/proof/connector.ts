import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createClient,
  type components,
  type MarfaClient,
} from "@withmarfa/client";
import { bundleIn, permissionFlags } from "../permission-flags.js";
import { check } from "./check.js";
import { freshConnectorKey, setSettings, type ConnectorKey } from "./host.js";
import {
  installPlugin,
  reinstallPlugin,
  type InstallOptions,
} from "./install.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");

/**
 * The arguments `node` is started with for the connector built at `entry`.
 * The connector runs from its `dist/` as built; when `PROOF_BUNDLES` names a
 * folder of bundles (`scripts/bundle-connectors.ts`), a connector of the
 * repository runs from its bundle instead, under the permission flags its
 * host gives it, so the proof shows the same behavior from the bundle. A
 * connector of the proof's own always runs as built.
 */
export function startOf(entry: string, args: readonly string[]): string[] {
  const bundles = process.env["PROOF_BUNDLES"];
  const own = /^([a-z0-9-]+)\/dist\/main\.js$/.exec(
    relative(join(root, "connectors"), entry),
  );
  if (bundles === undefined || own?.[1] === undefined) {
    return [entry, ...args];
  }
  const bundle = bundleIn(bundles, own[1]);
  return [...permissionFlags(bundle), bundle, ...args];
}

export type Item = components["schemas"]["Item"];

/** What a run is given: each name in lowercase is a setting, set in Marfa
 *  through the owner's door before the run, as the connector reads every
 *  setting; each in capitals is a variable of the process, which only a
 *  connector of the proof's own reads, for what the proof tells it. */
export type Given = Readonly<Record<string, unknown>>;

function settingsOf(given: Given): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(given).filter(([name]) => /^[a-z]/.test(name)),
  );
}

function variablesOf(given: Given): Record<string, string> {
  return Object.fromEntries(
    Object.entries(given)
      .filter(([name]) => !/^[a-z]/.test(name))
      .map(([name, value]) => [name, String(value)]),
  );
}

export class ConnectorUnderProof {
  private readonly entry: string;
  /** The proof's own entry, for a connector it defines; none for one the
   *  repository ships, whose plugin is its generated folder. */
  private readonly own: string | undefined;

  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly key: string,
    private readonly given: Given,
    entry?: string,
    /** The address of the instance that holds the plugin, where a proxy
     *  stands between the connector and it; `false` where the proof holds
     *  the connector's types itself. */
    private readonly installAt: string | false = url,
  ) {
    this.own = entry;
    this.entry = entry ?? join(root, "connectors", name, "dist/main.js");
  }

  /** The plugin's types and connection types installed, as an owner's
   *  `marfa plugins install` leaves them, which the kit never registers, and
   *  its connector's settings set as this run is given them. */
  private async prepare(given: Given): Promise<void> {
    if (this.installAt !== false)
      await installPlugin(this.installAt, this.name, this.own);
    const settings = settingsOf(given);
    // A connector of the proof's own given no setting declares none.
    if (this.own !== undefined && Object.keys(settings).length === 0) return;
    await setSettings(this.installAt || this.url, this.name, settings);
  }

  /** The plugin installed again, after its types were deleted. */
  reinstall(): Promise<void> {
    if (this.installAt === false) return Promise.resolve();
    return reinstallPlugin(this.installAt, this.name, this.own);
  }

  once(): Promise<{ code: number; output: string; printed: string }> {
    return this.run(["--once"]);
  }

  private environment(given: Given): Record<string, string | undefined> {
    return {
      PATH: process.env["PATH"],
      MARFA_API_URL: this.url,
      MARFA_API_KEY: this.key,
      ...variablesOf(given),
    };
  }

  /** A run told to stop once `until` says so, as a stop or a reboot would. */
  async stopped(
    args: readonly string[],
    until: () => Promise<void>,
  ): Promise<{ code: number | null; output: string }> {
    await this.prepare(this.given);
    const child = spawn("node", startOf(this.entry, args), {
      env: this.environment(this.given),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let output = "";
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<{ code: number | null; output: string }>(
      (done) => {
        child.once("close", (code) => {
          done({ code, output });
        });
      },
    );
    void until().then(() => child.kill("SIGTERM"));
    return exited;
  }

  /** One run, given what the runner was made with and `more` over it. The
   *  log is `output`, and what the connector prints on standard output,
   *  which only setup does, is `printed`. */
  async run(
    args: readonly string[],
    more: Given = {},
  ): Promise<{ code: number; output: string; printed: string }> {
    const given = { ...this.given, ...more };
    await this.prepare(given);
    try {
      const { stdout, stderr } = await run("node", startOf(this.entry, args), {
        env: this.environment(given),
      });
      return { code: 0, output: stderr, printed: stdout };
    } catch (error) {
      const failed = error as {
        code?: number;
        stderr?: string;
        stdout?: string;
      };
      return {
        code: failed.code ?? -1,
        output: failed.stderr ?? String(error),
        printed: failed.stdout ?? "",
      };
    }
  }
}

/** The types of a shipped connector's kinds and its edge types, as its
 *  plugin's folder names them. */
async function reachOf(
  plugin: string,
): Promise<{ types: string[]; edges: string[] }> {
  const manifest = JSON.parse(
    await readFile(
      join(root, "connectors", plugin, "plugin", "plugin.json"),
      "utf8",
    ),
  ) as { connector: { kinds: { type: string }[]; edge_types?: string[] } };
  return {
    types: manifest.connector.kinds.map((kind) => kind.type),
    edges: manifest.connector.edge_types ?? [],
  };
}

/**
 * The key the proof's connector host mints for `plugin`'s connector, checked
 * as the template's README says it is made: the connector's source as its
 * own, write on the types of its kinds and on its edge types, and nothing
 * else. A shipped connector's are read from its plugin's folder; one of the
 * proof's own names them. The group starts afresh, as `freshConnectorKey`
 * says.
 */
export async function hostMintedKey(
  url: string,
  plugin: string,
  own?: { entry: string; types: readonly string[]; edges?: readonly string[] },
  install?: InstallOptions,
): Promise<ConnectorKey> {
  const { types, edges = [] } = own ?? (await reachOf(plugin));
  const entry = own?.entry;
  let minted: ConnectorKey | undefined;
  await check(
    `${plugin}: its connector host mints its key, holding its own source and write on its types and connection types alone`,
    async () => {
      minted = await freshConnectorKey(url, plugin, entry, install);
      const { data: key, error } = await createClient({
        baseUrl: url,
        credential: minted.key,
      }).GET("/keys/current");
      if (key === undefined)
        throw new Error(`the key was refused: ${JSON.stringify(error)}`);
      const want = (names: readonly string[]) =>
        JSON.stringify(
          Object.fromEntries([...names].sort().map((name) => [name, "write"])),
        );
      const sorted = (map: Record<string, string> | undefined) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(map ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          ),
        );
      const typesHeld = sorted(key.type_permissions);
      const edgesHeld = sorted(key.edge_permissions);
      const rest = JSON.stringify([
        key.permissions,
        key.sources,
        key.metadata_permissions,
        key.extension_permissions,
        key.profile_permissions,
      ]);
      if (
        key.source !== minted.source ||
        key.default_tier !== "feed" ||
        typesHeld !== want(types) ||
        edgesHeld !== want(edges) ||
        rest !== "[[],[],{},{},{}]"
      ) {
        throw new Error(
          `source ${key.source}, type_permissions ${typesHeld}, edge_permissions ${edgesHeld}, permissions, claims, metadata, extension and profile ${rest}, default tier ${key.default_tier}`,
        );
      }
      return `source ${key.source}, type_permissions ${typesHeld}, edge_permissions ${edgesHeld}, no permission, claim or other entry, default tier ${key.default_tier}`;
    },
  );
  if (minted === undefined) throw new Error("the key check answered nothing");
  return minted;
}

export async function fieldsOf(marfa: MarfaClient, id: string) {
  const { data, error } = await marfa.GET("/types/{id}", {
    params: { path: { id } },
  });
  if (data === undefined)
    throw new Error(`the type ${id} was refused: ${JSON.stringify(error)}`);
  return {
    fields: Object.keys(data.fields),
    parent: data.parent,
  };
}

export async function witnessTypeAnswers(marfa: MarfaClient): Promise<string> {
  const id = "proof.witness";
  const { error, response } = await marfa.POST("/types", {
    body: {
      id,
      label: "Proof Witness",
      parent: "core.bookmark",
      fields: { witness: { type: "string" } },
    },
  });
  if (!response.ok) {
    throw new Error(`the witness type was refused: ${JSON.stringify(error)}`);
  }
  const served = await fieldsOf(marfa, id);
  const bookmark = await fieldsOf(marfa, "core.bookmark");
  if (
    served.parent !== "core.bookmark" ||
    !served.fields.includes("witness") ||
    !bookmark.fields.every((field) => served.fields.includes(field))
  ) {
    throw new Error(
      `parent ${String(served.parent)}, fields ${served.fields.join(", ")}`,
    );
  }
  return `${id} answers parent ${served.parent} and its own witness field beside its parent's ${String(bookmark.fields.length)}`;
}

export async function typeHeld(marfa: MarfaClient, id: string) {
  const { data, error, response } = await marfa.GET("/types/{id}", {
    params: { path: { id } },
  });
  if (data !== undefined) return true;
  if (response.status === 404) return false;
  throw new Error(`the type ${id} was refused: ${JSON.stringify(error)}`);
}

/** The type as the plugin's install left it, a kind of `parent`, holding every
 *  field of the rows written to it. */
export async function installedAsKindOf(
  marfa: MarfaClient,
  type: string,
  parent: string,
  rows: Iterable<Item>,
): Promise<{ own: string[]; inherited: number }> {
  const served = await fieldsOf(marfa, type);
  const core = await fieldsOf(marfa, parent);
  if (served.parent !== parent) {
    throw new Error(`parent ${String(served.parent)}`);
  }
  const missing = core.fields.filter((field) => !served.fields.includes(field));
  const unknown = [...rows]
    .flatMap((row) => Object.keys(row.properties))
    .filter((field) => !served.fields.includes(field));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${type} lacks ${parent}'s ${missing.join(", ") || "nothing"}; written outside the type: ${unknown.join(", ") || "nothing"}`,
    );
  }
  return {
    own: served.fields.filter((field) => !core.fields.includes(field)).sort(),
    inherited: core.fields.length,
  };
}

export async function runsOf(marfa: MarfaClient, keyId: string) {
  const { id } = await registration(marfa, keyId);
  const { data, error } = await marfa.GET("/connectors/{id}/runs", {
    params: { path: { id } },
  });
  if (data === undefined)
    throw new Error(`the runs were refused: ${JSON.stringify(error)}`);
  return data.data;
}

export async function lastRun(marfa: MarfaClient, keyId: string) {
  const found = await registration(marfa, keyId);
  if (found.last_run === null) throw new Error("no run is reported");
  return found.last_run;
}

export async function rowsOf(
  marfa: MarfaClient,
  type: string,
  source: string,
): Promise<Map<string, Item>> {
  const rows = new Map<string, Item>();
  let cursor: string | undefined;
  do {
    const { data, error } = await marfa.GET("/items", {
      params: {
        query: {
          type,
          source,
          state: "any",
          limit: 200,
          ...(cursor !== undefined && { cursor }),
        },
      },
    });
    if (data === undefined)
      throw new Error(`the listing was refused: ${JSON.stringify(error)}`);
    for (const row of data.data) {
      const item = "item" in row ? row.item : row;
      if (item.source_id !== undefined) rows.set(item.source_id, item);
    }
    cursor = data.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return rows;
}

// A transition changes state without moving the version, so both are compared.
export function moved(
  before: Map<string, Item>,
  after: Map<string, Item>,
): string[] {
  return [...after.values()].flatMap((row) => {
    const was = before.get(row.source_id ?? "");
    if (was?.version === row.version && was.state === row.state) return [];
    const state =
      was?.state === row.state ? "" : ` ${String(was?.state)}→${row.state}`;
    return [
      `${row.source_id ?? row.id} ${String(was?.version)}→${String(row.version)}${state}`,
    ];
  });
}

export async function registration(marfa: MarfaClient, keyId: string) {
  const { data, error } = await marfa.GET("/connectors");
  if (data === undefined)
    throw new Error(`the listing was refused: ${JSON.stringify(error)}`);
  const found = data.data.find((connector) => connector.key_id === keyId);
  if (found === undefined)
    throw new Error("no registration carries the connector's key");
  return found;
}

export async function edit(
  marfa: MarfaClient,
  row: Item,
  properties: Record<string, unknown>,
): Promise<Item> {
  const { data, error } = await marfa.PATCH("/items/{id}", {
    params: { path: { id: row.id } },
    body: { version: row.version, properties, properties_mode: "merge" },
  });
  if (data === undefined)
    throw new Error(`the edit was refused: ${JSON.stringify(error)}`);
  return data.item;
}

export async function create(
  marfa: MarfaClient,
  type: string,
  properties: Record<string, unknown>,
): Promise<Item> {
  const { data, error } = await marfa.POST("/items", {
    body: { type, properties },
  });
  if (data === undefined)
    throw new Error(`the create was refused: ${JSON.stringify(error)}`);
  return data.item;
}

export async function trash(marfa: MarfaClient, id: string): Promise<void> {
  const { error, response } = await marfa.DELETE("/items/{id}", {
    params: { path: { id } },
  });
  if (!response.ok)
    throw new Error(`the trash was refused: ${JSON.stringify(error)}`);
}

export async function restore(marfa: MarfaClient, id: string): Promise<void> {
  const { error, response } = await marfa.POST("/items/{id}/restore", {
    params: { path: { id } },
  });
  if (!response.ok)
    throw new Error(`the restore was refused: ${JSON.stringify(error)}`);
}

export async function purge(marfa: MarfaClient, id: string): Promise<void> {
  const { error, response } = await marfa.POST("/items/{id}/purge", {
    params: { path: { id } },
  });
  if (!response.ok)
    throw new Error(`the purge was refused: ${JSON.stringify(error)}`);
}

export async function deriveLibraryItem(
  marfa: MarfaClient,
  type: string,
  properties: Record<string, unknown>,
  from: Item | undefined,
): Promise<Item> {
  const { data, error } = await marfa.POST("/items", {
    body: {
      type,
      properties,
      tier: "library",
      ...(from !== undefined && { edges: { "derived-from": [from.id] } }),
    },
  });
  if (data === undefined)
    throw new Error(`the library item was refused: ${JSON.stringify(error)}`);
  return data.item;
}

export async function deriveAndFind(
  marfa: MarfaClient,
  type: string,
  properties: Record<string, unknown>,
  from: Item,
  other: Item,
): Promise<{ copy: Item; found: Item[] }> {
  await deriveLibraryItem(marfa, type, properties, undefined);
  await deriveLibraryItem(marfa, type, properties, other);
  const copy = await deriveLibraryItem(marfa, type, properties, from);
  const found = await derivedFrom(marfa, type, from);
  const everyOne = await marfa.GET("/items", { params: { query: { type } } });
  const count = everyOne.data?.data.length ?? 0;
  if (count < 3) {
    throw new Error(
      `the type holds ${String(count)} items, not the three made`,
    );
  }
  if (found.map((candidate) => candidate.id).join() !== copy.id) {
    throw new Error(
      `the edge filter found ${String(found.length)} of the type's ${String(count)} items`,
    );
  }
  return { copy, found };
}

export async function derivedFrom(
  marfa: MarfaClient,
  type: string,
  from: Item,
): Promise<Item[]> {
  const { data, error } = await marfa.GET("/items", {
    params: { query: { type, filter: `edge[derived-from] eq "${from.id}"` } },
  });
  if (data === undefined)
    throw new Error(`the edge filter was refused: ${JSON.stringify(error)}`);
  return data.data.map((row) => ("item" in row ? row.item : row));
}

export async function item(marfa: MarfaClient, id: string): Promise<Item> {
  const { data, error } = await marfa.GET("/items/{id}", {
    params: { path: { id } },
  });
  if (data === undefined)
    throw new Error(`the read was refused: ${JSON.stringify(error)}`);
  return data.item;
}
