import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { plan, stale } from "../connector-plugins.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

const places: string[] = [];
afterEach(async () => {
  for (const place of places.splice(0)) {
    await rm(place, { recursive: true, force: true });
  }
});

interface Fake {
  /** The connector's fields beside the ones every plugin needs. */
  extra?: string;
  /** Left out of the definition, to see it refused. */
  leaving?: string[];
  /** The guidance files to write, by type id; none writes one per type. */
  guidance?: Record<string, string>;
}

/** The connector's built definition as a script writes it for the fake. */
function definition(name: string, fake: Fake = {}): string {
  let fields: Record<string, string> = {
    name: `"${name}"`,
    title: `"${name} title"`,
    mark: `"lucide:box"`,
    maker: `"WithMarfa"`,
    description: `"The ${name} connector."`,
    source: `"${name}"`,
    sourceName: `"${name} source"`,
    types: `[{ name: "item", direction: "in", type: { id: "${name}.item", label: "Item" } }]`,
  };
  for (const left of fake.leaving ?? []) {
    fields = Object.fromEntries(
      Object.entries(fields).filter(([key]) => key !== left),
    );
  }
  const body = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
  return `export function connector(settings) { return { ${body}${fake.extra === undefined ? "" : `, ${fake.extra}`} }; }`;
}

/** A repository holding only the built definitions given, by folder name,
 *  each with the guidance of its one type. */
async function repository(
  folders: Record<string, [string, Fake?]>,
): Promise<string> {
  const place = await mkdtemp(join(tmpdir(), "connector-plugins-"));
  places.push(place);
  await mkdir(join(place, "connectors"), { recursive: true });
  for (const [folder, [name, fake]] of Object.entries(folders)) {
    const dist = join(place, "connectors", folder, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "definition.js"), definition(name, fake));
    const guidance = fake?.guidance ?? { [`${name}.item`]: "Use for items.\n" };
    const types = join(place, "connectors", folder, "plugin", "types");
    await mkdir(types, { recursive: true });
    for (const [id, text] of Object.entries(guidance)) {
      await writeFile(join(types, `${id}.md`), text);
    }
  }
  return place;
}

async function written(place: string): Promise<Map<string, string>> {
  const made = await plan(place);
  expect(made.missing).toEqual([]);
  return made.write;
}

/** Every file under `folder`, by its path from there. */
async function tree(folder: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found.set(path.slice(folder.length + 1), await readFile(path, "utf8"));
  }
  return found;
}

function manifest(text: string | undefined): {
  connector: {
    kinds: { name: string; type: string; direction: string }[];
    edge_types?: string[];
    settings: Record<string, unknown>[];
  };
  [key: string]: unknown;
} {
  return JSON.parse(text ?? "null") as ReturnType<typeof manifest>;
}

describe("the generated plugin folder of each connector", () => {
  it("has one folder for each folder of connectors/, and no other", async () => {
    const folders = (
      await readdir(join(root, "connectors"), { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => `connectors/${entry.name}/plugin/plugin.json`)
      .sort();
    expect(folders.length).toBeGreaterThan(0);
    const made = await written(root);
    expect(
      [...made.keys()].filter((path) => path.endsWith("/plugin.json")).sort(),
    ).toEqual(folders);
  });

  it("is what is committed, so a definition changed without regenerating it fails here", async () => {
    const made = await plan(root);
    expect(await stale(root, made)).toEqual([]);
  });

  it("fails the check for a folder that is out of date, which the same folder in order does not", async () => {
    const place = await repository({ alpha: ["alpha"] });
    const made = await plan(place);
    expect(await stale(place, made)).toEqual([...made.write.keys()].sort());
    for (const [path, text] of made.write) {
      await mkdir(join(place, path, ".."), { recursive: true });
      await writeFile(join(place, path), text);
    }
    expect(await stale(place, await plan(place))).toEqual([]);

    const changed = "connectors/alpha/plugin/plugin.json";
    await writeFile(join(place, changed), "{}\n");
    expect(await stale(place, await plan(place))).toEqual([changed]);
  });

  it("gains a folder when a connector is added and loses it when removed, with no other edit", async () => {
    const place = await repository({
      alpha: ["alpha"],
      beta: ["beta"],
    });
    const folders = async () =>
      [...(await written(place)).keys()]
        .filter((path) => path.endsWith("/plugin.json"))
        .sort();
    expect(await folders()).toEqual([
      "connectors/alpha/plugin/plugin.json",
      "connectors/beta/plugin/plugin.json",
    ]);
    await rm(join(place, "connectors", "alpha"), { recursive: true });
    expect(await folders()).toEqual(["connectors/beta/plugin/plugin.json"]);
  });

  it("names what a connector sets in the manifest, its kinds and its settings, and leaves out what it does not set", async () => {
    const place = await repository({
      full: [
        "full",
        {
          extra: `sourceMark: "lucide:box", settings: [
            { name: "full_token", label: "Token", kind: "text", secret: true, required: true },
            { name: "full_mode", label: "Mode", kind: "choice", choices: ["a", "b"], default: "a" },
            { name: "full_limit", label: "Limit", kind: "number" },
          ]`,
        },
      ],
      bare: ["bare"],
    });
    const made = await written(place);
    expect(
      JSON.parse(made.get("connectors/full/plugin/plugin.json") ?? ""),
    ).toEqual({
      name: "full",
      title: "full title",
      description: "The full connector.",
      mark: "lucide:box",
      maker: "WithMarfa",
      marfa: "0.0.95",
      connector: {
        source: "full",
        source_name: "full source",
        source_mark: "lucide:box",
        kinds: [{ name: "item", type: "full.item", direction: "in" }],
        settings: [
          {
            name: "full_token",
            label: "Token",
            kind: "text",
            secret: true,
            required: true,
          },
          {
            name: "full_mode",
            label: "Mode",
            kind: "choice",
            default: "a",
            required: false,
            choices: ["a", "b"],
          },
          {
            name: "full_limit",
            label: "Limit",
            kind: "number",
            required: false,
          },
        ],
        runs: { on: "host" },
      },
    });
    const bare = manifest(made.get("connectors/bare/plugin/plugin.json"));
    expect(bare.connector).not.toHaveProperty("source_mark");
    expect(bare.connector).not.toHaveProperty("edge_types");
    expect(bare.connector.settings).toEqual([]);
  });

  it("writes a type for each kind, an edge type for each connection Marfa does not ship, and names every connection in the connector's edge_types", async () => {
    const place = await repository({
      linked: [
        "linked",
        {
          extra: `connections: [
            { id: "linked.in-box", cardinality: "many-to-one", from_type_constraints: ["linked.item"], to_type_constraints: ["linked.item"] },
            { id: "attached-to", cardinality: "many-to-many", from_type_constraints: ["linked.item"], to_type_constraints: ["linked.item"] },
            { id: "child-of", cardinality: "many-to-one", from_type_constraints: ["linked.item"], to_type_constraints: ["linked.item"] },
          ]`,
        },
      ],
    });
    const made = await written(place);
    expect(
      [...made.keys()].filter((path) => !path.endsWith("plugin.json")),
    ).toEqual([
      "connectors/linked/plugin/types/linked.item.json",
      "connectors/linked/plugin/edge-types/linked.in-box.json",
    ]);
    expect(
      manifest(made.get("connectors/linked/plugin/plugin.json")).connector
        .edge_types,
    ).toEqual(["linked.in-box", "attached-to", "parent-of"]);
  });

  it("refuses a connector that cannot be a plugin, naming what it lacks", async () => {
    for (const left of [
      "title",
      "mark",
      "maker",
      "sourceName",
      "description",
    ]) {
      const place = await repository({
        odd: ["odd", { leaving: [left] }],
      });
      await expect(plan(place)).rejects.toThrow(
        new RegExp(
          `connectors/odd/src/definition\\.ts needs .*${left === "description" ? "description" : `a ${left}`}`,
        ),
      );
    }
    const long = await repository({
      long: ["long", { extra: `description: "${"a".repeat(301)}"` }],
    });
    await expect(plan(long)).rejects.toThrow(/a description of 1 to 300/);
    const unnamed = await repository({
      unnamed: [
        "unnamed",
        {
          extra: `types: [{ type: { id: "unnamed.item" } }]`,
        },
      ],
    });
    await expect(plan(unnamed)).rejects.toThrow(
      /a name and a direction for the kind of unnamed\.item/,
    );
    const named = await repository({ Odd: ["Not A Plugin Name"] });
    await expect(plan(named)).rejects.toThrow(/a name of lowercase words/);
  });

  it("refuses a folder with no built definition, naming it, and a definition that does not export connector as a function", async () => {
    const place = await repository({ alpha: ["alpha"] });
    await mkdir(join(place, "connectors", "unbuilt"), { recursive: true });
    await expect(plan(place)).rejects.toThrow(/connectors\/unbuilt/);
    const odd = await mkdtemp(join(tmpdir(), "connector-plugins-"));
    places.push(odd);
    await mkdir(join(odd, "connectors", "odd", "dist"), { recursive: true });
    await writeFile(
      join(odd, "connectors", "odd", "dist", "definition.js"),
      "export const connector = 1;",
    );
    await expect(plan(odd)).rejects.toThrow(
      /connectors\/odd\/src\/definition\.ts must export a function/,
    );
  });

  it("builds a definition from the settings it names as its widest, and from none otherwise", async () => {
    const place = await mkdtemp(join(tmpdir(), "connector-plugins-"));
    places.push(place);
    for (const [folder, widest] of [
      ["plain", ""],
      ["wide", `export const widest = { PICTURES: "save" };`],
    ] as const) {
      const dist = join(place, "connectors", folder, "dist");
      await mkdir(dist, { recursive: true });
      await writeFile(
        join(dist, "definition.js"),
        `${widest}
        export function connector(settings) {
          return {
            name: "${folder}", title: "T", mark: "lucide:box", maker: "M", description: "D",
            source: "${folder}", sourceName: "S",
            types: [
              { name: "entry", direction: "in", type: { id: "${folder}.entry" } },
              ...(settings.PICTURES === "save"
                ? [{ name: "picture", direction: "in", type: { id: "${folder}.picture" } }]
                : []),
            ],
          };
        }`,
      );
      const types = join(place, "connectors", folder, "plugin", "types");
      await mkdir(types, { recursive: true });
      for (const id of ["entry", "picture"]) {
        if (folder === "plain" && id === "picture") continue;
        await writeFile(join(types, `${folder}.${id}.md`), "Guidance.\n");
      }
    }
    const made = await written(place);
    expect(
      manifest(
        made.get("connectors/plain/plugin/plugin.json"),
      ).connector.kinds.map((kind) => kind.name),
    ).toEqual(["entry"]);
    expect(
      manifest(
        made.get("connectors/wide/plugin/plugin.json"),
      ).connector.kinds.map((kind) => kind.name),
    ).toEqual(["entry", "picture"]);
  });

  it("refuses a widest that is not each setting with its text", async () => {
    const place = await mkdtemp(join(tmpdir(), "connector-plugins-"));
    places.push(place);
    const dist = join(place, "connectors", "odd", "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(
      join(dist, "definition.js"),
      `export const widest = { PICTURES: 1 };\n${definition("odd")}`,
    );
    await expect(plan(place)).rejects.toThrow(
      /connectors\/odd\/src\/definition\.ts must export `widest`/,
    );
  });

  it("finds guidance missing, empty, over 1,000 characters or left with no type, which nothing generates", async () => {
    const place = await repository({
      none: ["none", { guidance: {} }],
      empty: ["empty", { guidance: { "empty.item": "  \n" } }],
      huge: ["huge", { guidance: { "huge.item": "x".repeat(1001) } }],
      orphan: [
        "orphan",
        { guidance: { "orphan.item": "Fine.\n", "orphan.old": "Left.\n" } },
      ],
    });
    const made = await plan(place);
    expect(made.missing).toEqual([
      "connectors/empty/plugin/types/empty.item.md holds no guidance",
      "connectors/huge/plugin/types/huge.item.md is longer than 1000 characters",
      "connectors/none/plugin/types/none.item.md holds no guidance",
    ]);
    expect(made.extra).toEqual([
      "connectors/orphan/plugin/types/orphan.old.md",
    ]);
  });

  it("removes the JSON of a type or connection no definition names any more, and leaves the guidance as written", async () => {
    const place = await repository({ alpha: ["alpha"] });
    for (const [path, text] of await written(place)) {
      await mkdir(join(place, path, ".."), { recursive: true });
      await writeFile(join(place, path), text);
    }
    const stray = join(place, "connectors/alpha/plugin/edge-types/old.json");
    await mkdir(join(stray, ".."), { recursive: true });
    await writeFile(stray, "{}\n");
    const made = await plan(place);
    expect(made.extra).toEqual(["connectors/alpha/plugin/edge-types/old.json"]);
    expect(await stale(place, made)).toEqual([
      "connectors/alpha/plugin/edge-types/old.json",
    ]);
  });

  it("is the same whatever settings the caller's environment holds", async () => {
    // The generator is run as CI runs it, in a process of its own, with a
    // setting that adds a type, one that removes fields and a token set.
    const done = await run(
      process.execPath,
      [
        "--experimental-strip-types",
        join(root, "scripts/connector-plugins.ts"),
        "--check",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          RSS_PICTURES: "addresses",
          GITHUB_PERSONAL_TOKEN: "token",
          GITHUB_STARS: "false",
          GITHUB_READ_ONLY: "true",
          TODOIST_READ_ONLY: "true",
          READWISE_READER_INBOUND_ONLY: "true",
        },
      },
    ).catch((error: unknown) => {
      throw new Error("the generator refused the folders", { cause: error });
    });
    expect(done.stderr).not.toMatch(/out of date/);
  });
});

describe("the plugins the real connectors are published as", () => {
  const folderOf = async (name: string) =>
    tree(join(root, "connectors", name, "plugin"));
  const kindsOf = async (name: string) =>
    manifest((await folderOf(name)).get("plugin.json")).connector.kinds;

  it("holds the picture type and the entry type in the widest shape, for RSS, whatever its settings", async () => {
    const folder = await folderOf("rss");
    expect((await kindsOf("rss")).map((kind) => kind.type)).toEqual([
      "rss.entry",
      "rss.picture",
    ]);
    const entry = JSON.parse(folder.get("types/rss.entry.json") ?? "") as {
      fields: Record<string, unknown>;
    };
    expect(Object.keys(entry.fields)).toContain("rss_pictures");
    expect(folder.has("types/rss.picture.json")).toBe(true);
  });

  it("holds the file types GitHub writes for the attachments it retains", async () => {
    expect((await kindsOf("github")).map((kind) => kind.type)).toEqual(
      expect.arrayContaining(["github.file", "github.file.image"]),
    );
  });

  it("holds the file type Readwise and Readwise Reader write beside sources and highlights", async () => {
    for (const name of ["readwise", "readwise-reader"]) {
      expect((await kindsOf(name)).map((kind) => kind.type)).toEqual([
        "readwise.source",
        "readwise.highlight",
        "readwise.file",
      ]);
    }
  });

  it("holds a type, in each connector, for every type its definition lists, and guidance beside each", async () => {
    for (const name of await readdir(join(root, "connectors"))) {
      const folder = await folderOf(name);
      const types = manifest(folder.get("plugin.json")).connector.kinds.map(
        (kind) => kind.type,
      );
      expect(types.length).toBeGreaterThan(0);
      for (const type of types) {
        expect(folder.has(`types/${type}.json`)).toBe(true);
        expect(folder.get(`types/${type}.md`)?.trim()).not.toBe("");
      }
      expect(
        [...folder.keys()].filter((path) => path.startsWith("types/")),
      ).toHaveLength(types.length * 2);
    }
  });

  // What each connector writes, found by reading its definition's connections
  // and every `connections` an entry of its `run` names: the key a host mints
  // for it writes these edge types and no others.
  it.each([
    [
      "github",
      [
        "attached-to",
        "about",
        "github.in-repository",
        "github.sub-issue-of",
        "github.blocked-by",
        "github.relates-to",
        "github.duplicate-of",
        "references",
        "in-thread",
        "comments-on",
        "parent-of",
        "in-collection",
        "github.closes",
        "github.closed-by",
      ],
    ],
    ["google-calendar", ["google.calendar.in-calendar", "parent-of"]],
    ["readwise", ["excerpt-of", "references", "attached-to"]],
    ["readwise-reader", ["excerpt-of", "references", "attached-to"]],
    ["rss", ["attached-to"]],
    ["todoist", undefined],
  ])("names the edge types %s writes, and no other", async (name, expected) => {
    const folder = await folderOf(name);
    expect(manifest(folder.get("plugin.json")).connector.edge_types).toEqual(
      expected,
    );
    // An edge type of its own is a file; one Marfa ships is not.
    const own = [...folder.keys()]
      .filter((path) => path.startsWith("edge-types/"))
      .map((path) => path.slice("edge-types/".length, -".json".length))
      .sort();
    expect(own).toEqual(
      (expected ?? []).filter((id) => id.includes(".")).sort(),
    );
  });

  it("declares each setting as the contract takes it, and names every secret", async () => {
    for (const name of await readdir(join(root, "connectors"))) {
      const settings = manifest((await folderOf(name)).get("plugin.json"))
        .connector.settings;
      expect(settings.length).toBeGreaterThan(0);
      for (const setting of settings) {
        expect(setting["name"]).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(setting["secret"] === true ? setting["kind"] : "text").toBe(
          "text",
        );
        if (setting["secret"] === true) {
          expect(setting).not.toHaveProperty("default");
        }
      }
    }
    const github = manifest((await folderOf("github")).get("plugin.json"))
      .connector.settings;
    expect(
      github
        .filter((setting) => setting["secret"] === true)
        .map((one) => one["name"]),
    ).toEqual([
      "github_private_key",
      "github_webhook_secret",
      "github_personal_token",
      "github_notifications_token",
    ]);
  });
});
