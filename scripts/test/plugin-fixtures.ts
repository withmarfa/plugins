import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A repository-shaped folder to put plugin source folders in. */
export async function emptyTree(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plugins-fixture-"));
}

export async function remove(folder: string): Promise<void> {
  await rm(folder, { recursive: true, force: true });
}

export interface Fixture {
  name?: string;
  /** Extra keys of `plugin.json`, such as the `version` a check refuses. */
  manifest?: Record<string, unknown>;
  /** The file name, without `.json`, and the definition it holds. */
  types?: Record<string, Record<string, unknown>>;
  guidance?: Record<string, string>;
}

/** A well-formed type of the given id. */
export function widget(id: string): Record<string, unknown> {
  return {
    id,
    parent: "core.task",
    description: "A type the tests make up.",
    fields: { colour: { type: "string" } },
  };
}

/**
 * Writes a plugin's source folder at `folder` under `base` (`types/tickets`,
 * `connectors/todoist/plugin`) and answers its path.
 */
export async function writePlugin(
  base: string,
  folder: string,
  fixture: Fixture = {},
): Promise<string> {
  const path = join(base, folder);
  const name =
    fixture.name ??
    folder
      .split("/")
      .filter((part) => part !== "plugin")
      .at(-1) ??
    folder;
  await mkdir(join(path, "types"), { recursive: true });
  await writeFile(
    join(path, "plugin.json"),
    JSON.stringify({
      name,
      title: name,
      description: "A plugin the tests make up.",
      mark: "lucide:box",
      maker: "Marfa",
      marfa: "0.0.1",
      ...fixture.manifest,
    }),
  );
  const types = fixture.types ?? {
    [`common.${name}`]: widget(`common.${name}`),
  };
  for (const [file, definition] of Object.entries(types)) {
    await writeFile(
      join(path, "types", `${file}.json`),
      JSON.stringify(definition),
    );
  }
  for (const [file, text] of Object.entries(fixture.guidance ?? {})) {
    await writeFile(join(path, "types", `${file}.md`), text);
  }
  return path;
}
