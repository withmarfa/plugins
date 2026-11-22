/**
 * Writes `connectors/<name>/plugin/`, the folder of the plugin each connector
 * is published as, from the connector's own definition: the `connector()`
 * that its `src/definition.ts` exports, built to `dist/definition.js`. The
 * folder is the shape `types/tickets/` has and `marfa plugins check` reads:
 *
 *   plugin.json          the plugin's identity and its `connector` section
 *   types/<id>.json      each kind's type, in its widest shape
 *   types/<id>.md        its guidance, written by hand and read here
 *   edge-types/<id>.json each connection type the connector declares that
 *                        Marfa does not ship
 *
 * Nothing in the JSON is typed by hand, so a connector added to or removed
 * from `connectors/` changes the folders with no other edit. The guidance is
 * the one part written by hand: the script refuses a type with none, and a
 * guidance file with no type, and leaves the files as they are.
 *
 * The folder does not depend on who runs the script. A definition is built
 * from the settings it is given, and the script gives it the ones the
 * definition names as its `widest`, or none, so no variable of the caller's
 * environment reaches it, and a type that a setting changes is written in the
 * widest shape it takes: the key a host mints writes only the types of the
 * plugin's kinds.
 *
 *   node --experimental-strip-types scripts/connector-plugins.ts          writes the folders
 *   node --experimental-strip-types scripts/connector-plugins.ts --check  fails when one is out of date
 *
 * Run `pnpm build` first: the folders are read from what the build made.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";
import {
  edgeTypesOf,
  shippedConnection,
  type Connector,
} from "@withmarfa/connector";

/**
 * The oldest Marfa release the generated plugins work with: the first that
 * takes `edge_types` in a connector section and 65,536 characters in a text
 * setting.
 */
export const marfaRelease = "0.0.95";

/** Where a connector's folder is, from the connector's own. */
export const pluginFolder = "plugin";

/** The longest a plugin's description, a type's description and its guidance
 *  may be, as `marfa plugins check` holds them to. */
const longest = { description: 300, guidance: 1000 };

type Settings = Readonly<Record<string, string | number | boolean | undefined>>;

/** A connector's definition: how to build it, and the settings that give it
 *  its widest shape. */
interface Definition {
  build: (settings: Settings) => Connector;
  widest: Settings;
}

async function definitionOf(
  root: string,
  directory: string,
): Promise<Definition> {
  const built = join(root, directory, "dist", "definition.js");
  let module: { connector?: unknown; widest?: unknown };
  try {
    module = (await import(pathToFileURL(built).href)) as typeof module;
  } catch (error) {
    throw new Error(
      `${directory} has no built definition at ${directory}/dist/definition.js: run pnpm build, and keep its definition in src/definition.ts`,
      { cause: error },
    );
  }
  if (typeof module.connector !== "function") {
    throw new Error(
      `${directory}/src/definition.ts must export a function \`connector\` that returns the connector`,
    );
  }
  const widest: unknown = module.widest ?? {};
  if (
    typeof widest !== "object" ||
    widest === null ||
    !Object.values(widest).every((value) =>
      ["string", "number", "boolean"].includes(typeof value),
    )
  ) {
    throw new Error(
      `${directory}/src/definition.ts must export \`widest\` as each setting's name with the value that gives the connector its widest shape`,
    );
  }
  return {
    build: module.connector as Definition["build"],
    widest: widest as Settings,
  };
}

/** What stops a connector from being a plugin: every refusal is here, so the
 *  person who adds a connector hears of it from this script. */
function problemsOf(connector: Connector): string[] {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(connector.name)) {
    problems.push(
      "a name of lowercase words and numbers joined by hyphens, which is the plugin's name",
    );
  }
  for (const field of ["title", "mark", "maker", "sourceName"] as const) {
    if (connector[field] === undefined) problems.push(`a ${field}`);
  }
  const description = connector.description ?? "";
  if (description === "" || description.length > longest.description) {
    problems.push(
      `a description of 1 to ${String(longest.description)} characters`,
    );
  }
  for (const kind of connector.types) {
    if (kind.name === undefined || kind.direction === undefined) {
      problems.push(`a name and a direction for the kind of ${kind.type.id}`);
    }
  }
  return problems;
}

/** The `plugin.json` of the connector, with the section Marfa records. */
function manifestOf(connector: Connector): Record<string, unknown> {
  const edgeTypes = [...edgeTypesOf(connector.connections ?? [])];
  return {
    name: connector.name,
    title: connector.title,
    description: connector.description,
    mark: connector.mark,
    maker: connector.maker,
    marfa: marfaRelease,
    connector: {
      source: connector.source,
      source_name: connector.sourceName,
      ...(connector.sourceMark === undefined
        ? {}
        : { source_mark: connector.sourceMark }),
      kinds: connector.types.map((kind) => ({
        name: kind.name,
        type: kind.type.id,
        direction: kind.direction,
      })),
      ...(edgeTypes.length === 0 ? {} : { edge_types: edgeTypes }),
      settings: (connector.settings ?? []).map((setting) => ({
        name: setting.name,
        label: setting.label,
        kind: setting.kind,
        ...(setting.secret === true ? { secret: true } : {}),
        ...(setting.default === undefined ? {} : { default: setting.default }),
        required: setting.required === true,
        ...(setting.choices === undefined
          ? {}
          : { choices: [...setting.choices] }),
      })),
      ...(connector.signIn === undefined
        ? {}
        : {
            sign_in: {
              kind: connector.signIn.kind,
              provider: connector.signIn.provider,
              scopes: [...connector.signIn.scopes],
              client_id_setting: connector.signIn.clientIdSetting,
              client_secret_setting: connector.signIn.clientSecretSetting,
              token_setting: connector.signIn.tokenSetting,
            },
          }),
      runs: { on: "host" },
    },
  };
}

/** One connector's folder: each JSON file by its path inside the folder, and
 *  the type ids whose guidance the folder must hold. */
export interface Folder {
  directory: string;
  json: Map<string, unknown>;
  guidance: string[];
}

export function folderOf(directory: string, connector: Connector): Folder {
  const problems = problemsOf(connector);
  if (problems.length > 0) {
    throw new Error(
      `${directory}/src/definition.ts needs ${problems.join("; ")}`,
    );
  }
  const json = new Map<string, unknown>([
    ["plugin.json", manifestOf(connector)],
  ]);
  for (const kind of connector.types) {
    json.set(`types/${kind.type.id}.json`, kind.type);
  }
  for (const connection of connector.connections ?? []) {
    if (shippedConnection(connection.id) === undefined) {
      json.set(`edge-types/${connection.id}.json`, connection);
    }
  }
  return {
    directory,
    json,
    guidance: connector.types.map((kind) => kind.type.id),
  };
}

async function folders(root: string): Promise<Folder[]> {
  const names = (
    await readdir(join(root, "connectors"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const found: Folder[] = [];
  for (const name of names) {
    const directory = `connectors/${name}`;
    const definition = await definitionOf(root, directory);
    found.push(folderOf(directory, definition.build(definition.widest)));
  }
  return found;
}

async function formatted(
  root: string,
  path: string,
  value: unknown,
): Promise<string> {
  const options = (await resolveConfig(join(root, path))) ?? {};
  return format(JSON.stringify(value), {
    ...options,
    filepath: join(root, path),
  });
}

/** The files under `folder`, relative to it with forward slashes. */
async function filesUnder(folder: string, inside = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(folder, inside), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = inside === "" ? entry.name : `${inside}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await filesUnder(folder, path)));
    else files.push(path);
  }
  return files.sort();
}

export interface Plan {
  /** Each file to write, by its path from the repository root. */
  write: Map<string, string>;
  /** Files in a generated folder that nothing generates: JSON no connector's
   *  definition names. */
  extra: string[];
  /** What is wrong with the guidance, which is written by hand. */
  missing: string[];
}

/** What the folders of every connector should hold, against what they hold. */
export async function plan(root: string): Promise<Plan> {
  const write = new Map<string, string>();
  const extra: string[] = [];
  const missing: string[] = [];
  for (const folder of await folders(root)) {
    const base = `${folder.directory}/${pluginFolder}`;
    for (const [inside, value] of folder.json) {
      write.set(
        `${base}/${inside}`,
        await formatted(root, `${base}/${inside}`, value),
      );
    }
    const held = await filesUnder(join(root, base));
    const wanted = new Set(folder.guidance.map((id) => `types/${id}.md`));
    for (const file of held) {
      if (file.endsWith(".json") && !folder.json.has(file)) {
        extra.push(`${base}/${file}`);
      } else if (file.endsWith(".md") && !wanted.has(file)) {
        extra.push(`${base}/${file}`);
      } else if (!file.endsWith(".json") && !file.endsWith(".md")) {
        extra.push(`${base}/${file}`);
      }
    }
    for (const file of wanted) {
      const text = await readFile(join(root, base, file), "utf8").catch(
        () => undefined,
      );
      if (text === undefined || text.trim() === "") {
        missing.push(`${base}/${file} holds no guidance`);
      } else if (Array.from(text).length > longest.guidance) {
        missing.push(
          `${base}/${file} is longer than ${String(longest.guidance)} characters`,
        );
      }
    }
  }
  return { write, extra, missing };
}

/** The paths whose files differ from what the definitions give. */
export async function stale(root: string, made: Plan): Promise<string[]> {
  const differing: string[] = [];
  for (const [path, text] of made.write) {
    const current = await readFile(join(root, path), "utf8").catch(
      () => undefined,
    );
    if (current !== text) differing.push(path);
  }
  return [...differing, ...made.extra, ...made.missing];
}

async function write(root: string, made: Plan): Promise<void> {
  for (const path of made.extra) {
    await rm(join(root, path), { force: true });
  }
  for (const [path, text] of made.write) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const made = await plan(root);
  if (process.argv.includes("--check")) {
    const differing = await stale(root, made);
    if (differing.length > 0) {
      console.error(
        `the plugin folders are out of date with the connectors' definitions: run pnpm build, then pnpm connectors:generate, write any guidance that is missing, and commit the result\n${differing.join("\n")}`,
      );
      process.exitCode = 1;
    }
    return;
  }
  await write(root, made);
  if (made.missing.length > 0) {
    console.error(made.missing.join("\n"));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
