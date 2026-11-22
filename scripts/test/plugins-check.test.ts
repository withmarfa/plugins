import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPlugins } from "../check-plugins.js";
import { findPlugins, root } from "../release/plugins.js";
import { emptyTree, remove, widget, writePlugin } from "./plugin-fixtures.js";

async function fresh(): Promise<string> {
  const base = await emptyTree();
  await mkdir(join(base, "types"), { recursive: true });
  await writeFile(join(base, "types", "README.md"), "# Types\n");
  return base;
}

describe("which folders are plugins", () => {
  it("reads the repository from its root, which holds the pin and the families", () => {
    expect(existsSync(join(root, "scripts", "monorepo.commit"))).toBe(true);
    expect(existsSync(join(root, "types", "README.md"))).toBe(true);
  });

  it("finds a family of types and a connector's generated plugin, and leaves README.md alone", async () => {
    const base = await fresh();
    try {
      await writePlugin(base, "types/tickets");
      await writePlugin(base, "connectors/todoist/plugin", { name: "todoist" });
      await mkdir(join(base, "connectors", "rss"), { recursive: true });
      const found = findPlugins(base);
      expect(found.problems).toEqual([]);
      expect(found.plugins).toEqual([
        { folder: "types/tickets", name: "tickets" },
        { folder: "connectors/todoist/plugin", name: "todoist" },
      ]);
    } finally {
      await remove(base);
    }
  });

  it("finds none in a tree with no family, which is no problem", async () => {
    const base = await fresh();
    try {
      expect(findPlugins(base)).toEqual({ plugins: [], problems: [] });
    } finally {
      await remove(base);
    }
  });

  it("counts a folder of types with no plugin.json, a stray file and a plugin.json that names nothing as problems, not as skipped", async () => {
    const base = await fresh();
    try {
      await mkdir(join(base, "types", "forgotten", "types"), {
        recursive: true,
      });
      await writeFile(join(base, "types", "notes.txt"), "stray");
      await mkdir(join(base, "types", "nameless"), { recursive: true });
      await writeFile(join(base, "types", "nameless", "plugin.json"), "{}");
      await mkdir(join(base, "types", "broken"), { recursive: true });
      await writeFile(join(base, "types", "broken", "plugin.json"), "{");
      await mkdir(join(base, "connectors", "c", "plugin"), { recursive: true });
      const found = findPlugins(base);
      expect(found.plugins).toEqual([]);
      expect(
        found.problems.map((problem) => problem.split(":")[0]).sort(),
      ).toEqual([
        "connectors/c/plugin",
        "types/broken",
        "types/forgotten",
        "types/nameless",
        "types/notes.txt",
      ]);
    } finally {
      await remove(base);
    }
  });

  it("counts two folders that name one plugin as a problem, since they would write one bundle", async () => {
    const base = await fresh();
    try {
      await writePlugin(base, "types/one", { name: "same" });
      await writePlugin(base, "connectors/two/plugin", { name: "same" });
      const found = findPlugins(base);
      expect(found.plugins).toEqual([{ folder: "types/one", name: "same" }]);
      expect(found.problems).toEqual([
        "connectors/two/plugin: names the plugin same, as types/one does",
      ]);
    } finally {
      await remove(base);
    }
  });
});

describe("the check, as installing will judge", () => {
  it("passes a tree whose plugins are well formed", async () => {
    const base = await fresh();
    try {
      await writePlugin(base, "types/alpha", {
        guidance: { "common.alpha": "Use it well.\n" },
      });
      await writePlugin(base, "types/beta");
      expect((await checkPlugins(base)).failures).toEqual([]);
    } finally {
      await remove(base);
    }
  });

  it("fails a plugin with a bad type, naming its folder, and passes it once fixed", async () => {
    const base = await fresh();
    try {
      await writePlugin(base, "types/good");
      await writePlugin(base, "types/bad", {
        types: {
          "common.bad": {
            ...widget("common.bad"),
            fields: { colour: { type: "not-a-field-type" } },
          },
        },
      });
      const { failures } = await checkPlugins(base);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("types/bad");
      expect(failures[0]).not.toContain("types/good");

      await writePlugin(base, "types/bad");
      expect((await checkPlugins(base)).failures).toEqual([]);
    } finally {
      await remove(base);
    }
  });

  it("fails a plugin.json that names a version, naming its folder, and passes it once the version is gone", async () => {
    const base = await fresh();
    try {
      await writePlugin(base, "types/versioned", {
        manifest: { version: "1.0.0" },
      });
      const { failures } = await checkPlugins(base);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("types/versioned");
      expect(failures[0]).toContain("version");

      await writePlugin(base, "types/versioned");
      expect((await checkPlugins(base)).failures).toEqual([]);
    } finally {
      await remove(base);
    }
  });

  it("fails a file whose name is not the id of its definition, naming its folder, and passes it once renamed", async () => {
    const base = await fresh();
    try {
      await writePlugin(base, "types/named", {
        name: "named",
        types: { "common.other": widget("common.named") },
      });
      const { failures } = await checkPlugins(base);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("types/named");
      expect(failures[0]).toContain("file_name_mismatch");

      await remove(join(base, "types", "named"));
      await writePlugin(base, "types/named");
      expect((await checkPlugins(base)).failures).toEqual([]);
    } finally {
      await remove(base);
    }
  });

  it("fails a folder of types that is no plugin, and reports every failure rather than the first", async () => {
    const base = await fresh();
    try {
      await mkdir(join(base, "types", "forgotten"), { recursive: true });
      await writePlugin(base, "types/versioned", {
        manifest: { version: "1.0.0" },
      });
      const { failures } = await checkPlugins(base);
      expect(failures).toHaveLength(2);
      expect(failures.join("\n")).toContain("types/forgotten");
      expect(failures.join("\n")).toContain("types/versioned");

      await remove(join(base, "types", "forgotten"));
      await writePlugin(base, "types/versioned");
      expect((await checkPlugins(base)).failures).toEqual([]);
    } finally {
      await remove(base);
    }
  });
});
