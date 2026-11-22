import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { shippedConnection, type Connector } from "@withmarfa/connector";
import { marfaRelease } from "../connector-plugins.ts";
import { runMarfa } from "../release/plugins.ts";

const root = resolve(import.meta.dirname, "../../..");

/** The key that installs, by the address of the server it belongs to: the
 *  proof's working key, which holds `schema.write` and write on every type and
 *  edge type, and which no connector under proof ever runs on. */
const installers = new Map<string, string>();
const installed = new Set<string>();

export function rememberInstaller(url: string, key: string): void {
  installers.set(url, key);
}

/** Writes the folder of `connector`'s plugin as the generator writes a
 *  connector's: `plugin.json`, each kind's type in `types/` with its guidance
 *  beside it, and each connection type the instance does not ship in
 *  `edge-types/`. */
async function folderOf(connector: Connector, into: string): Promise<string> {
  const folder = join(into, connector.name);
  await mkdir(join(folder, "types"), { recursive: true });
  await mkdir(join(folder, "edge-types"), { recursive: true });
  await writeFile(
    join(folder, "plugin.json"),
    JSON.stringify({
      name: connector.name,
      title: connector.title ?? connector.name,
      description: connector.description ?? "A connector the proof makes up.",
      mark: connector.mark ?? "lucide:box",
      maker: connector.maker ?? "WithMarfa",
      marfa: marfaRelease,
    }),
  );
  for (const kind of connector.types) {
    await writeFile(
      join(folder, "types", `${kind.type.id}.json`),
      JSON.stringify(kind.type),
    );
    await writeFile(
      join(folder, "types", `${kind.type.id}.md`),
      "A type the proof's own connector writes.\n",
    );
  }
  for (const connection of connector.connections ?? []) {
    if (shippedConnection(connection.id) === undefined) {
      await writeFile(
        join(folder, "edge-types", `${connection.id}.json`),
        JSON.stringify(connection),
      );
    }
  }
  return folder;
}

/** A connector the repository ships: its generated plugin folder, without the
 *  `connector` section. A key made through the API cannot name the source of
 *  an installed plugin's connector (`keys-and-oauth/plugin-source-held`), and
 *  until connectors start from a key their host mints, the proof's own keys
 *  are the API's, so only the types and connection types are installed. */
async function shippedFolder(name: string, into: string): Promise<string> {
  const folder = join(into, name);
  await cp(join(root, "connectors", name, "plugin"), folder, {
    recursive: true,
  });
  const path = join(folder, "plugin.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  Reflect.deleteProperty(manifest, "connector");
  await writeFile(path, JSON.stringify(manifest));
  return folder;
}

let imports = 0;

async function definitionAt(
  entry: string,
  env: Record<string, string> = {},
): Promise<Connector> {
  const was = Object.fromEntries(
    Object.keys(env).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, env);
  let held: { connector?: Connector };
  try {
    // A query makes each import read the environment again.
    imports += 1;
    held = (await import(
      `${pathToFileURL(entry).href}?import=${String(imports)}`
    )) as typeof held;
  } finally {
    for (const [name, value] of Object.entries(was)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
  if (held.connector === undefined) {
    throw new Error(`${entry} exports no connector, so it has no plugin`);
  }
  return held.connector;
}

/** The version a plugin installs at, and the one the proof gives an older
 *  plugin. Both sit at or below the first release the repository makes, so a
 *  group that installs the same plugin at a later version is never refused for
 *  being older. */
const currentVersion = "0.0.1";
export const olderVersion = "0.0.0";

/** How a plugin is installed: at which version, and whether its folder is
 *  changed first, which is how the proof makes an older plugin. */
export interface InstallOptions {
  /** The current version, unless the proof says another. */
  version?: string;
  /** Changes the folder before it is installed. */
  edit?: (folder: string) => Promise<void>;
  /** What the connector's module reads from the environment where it is
   *  imported to give its definition, which only a connector of the proof's
   *  own does. */
  env?: Record<string, string>;
}

/**
 * Installs the plugin of a connector under proof into the instance at `url`
 * with `marfa plugins install <folder>`, so its types and connection types are
 * there when it starts: the kit registers none. A shipped connector is
 * installed from its generated folder, the proof's own from a folder made of
 * its definition the same way. Installing again at a higher version is the
 * update an owner makes, which may only add to the types.
 */
export async function installPlugin(
  url: string,
  name: string,
  entry: string | undefined,
  options: InstallOptions = {},
): Promise<void> {
  const version = options.version ?? currentVersion;
  const mark = `${url} ${name} ${entry ?? ""} ${version}`;
  if (installed.has(mark)) return;
  const key = installers.get(url);
  if (key === undefined) throw new Error(`no key installs plugins at ${url}`);
  const work = await mkdtemp(join(tmpdir(), "plugins-proof-install-"));
  try {
    const folder =
      entry === undefined
        ? await shippedFolder(name, work)
        : await folderOf(await definitionAt(entry, options.env), work);
    await options.edit?.(folder);
    const ran = await runMarfa(
      ["plugins", "install", folder, "--version", version],
      { env: { MARFA_API_URL: url, MARFA_API_KEY: key } },
    );
    if (ran.code !== 0) {
      throw new Error(
        `marfa plugins install ${name} exited ${String(ran.code)}: ${ran.stderr.trim() || ran.stdout.trim()}`,
      );
    }
    installed.add(mark);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Installs the plugin again, as an owner does after its types were deleted. */
export async function reinstallPlugin(
  url: string,
  name: string,
  entry: string | undefined,
): Promise<void> {
  const key = installers.get(url);
  if (key === undefined) throw new Error(`no key installs plugins at ${url}`);
  // The install record outlives a type deleted from the instance, so it goes
  // too, and the install makes the types again.
  const removed = await runMarfa(["plugins", "remove", name], {
    env: { MARFA_API_URL: url, MARFA_API_KEY: key },
  });
  if (removed.code !== 0) {
    throw new Error(
      `marfa plugins remove ${name} exited ${String(removed.code)}: ${removed.stderr.trim() || removed.stdout.trim()}`,
    );
  }
  installed.delete(`${url} ${name} ${entry ?? ""} ${currentVersion}`);
  await installPlugin(url, name, entry);
}
