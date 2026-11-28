/**
 * `scripts/bundle-connectors.ts` turns a built connector into one file that
 * runs on the Node the host carries with nothing beside it. Each test makes a
 * small repository in a temporary folder, bundles its connector and runs the
 * bundle as the host will: under the permission flags, from an empty folder.
 */
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  bundleConnector,
  connectorsOf,
  refusals,
} from "../bundle-connectors.js";
import { bundlesIn, helpOf } from "../check-bundles.js";
import { readPin, type Pin } from "../node-pin.js";
import { permissionFlags } from "@withmarfa/connector-host/permission-flags";
import { bundleName } from "../bundle-files.js";

const run = promisify(execFile);

const root = resolve(import.meta.dirname, "..", "..");
const made: string[] = [];

afterAll(async () => {
  for (const folder of made) await rm(folder, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  // A real path: a bundle reached through a link is not readable under the
  // permission flags (`host/src/permission-flags.ts`).
  const folder = await realpath(await mkdtemp(join(tmpdir(), "bundle-test-")));
  made.push(folder);
  return folder;
}

/**
 * A repository holding the connector `c`, built: its `dist/main.js` and what
 * else is given, by path from the repository. MiniJinja is installed in it,
 * as the real one is.
 */
async function repository(files: Record<string, string>): Promise<string> {
  const base = await scratch();
  const all: Record<string, string> = {
    "connectors/c/plugin/plugin.json": '{"name":"c"}',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), text);
  }
  await mkdir(join(base, "node_modules"), { recursive: true });
  await symlink(
    await realpath(join(root, "kit", "node_modules", "minijinja-js")),
    join(base, "node_modules", "minijinja-js"),
  );
  return base;
}

async function bundled(
  files: Record<string, string>,
  pin?: Pin,
): Promise<{ file: string; text: string }> {
  const base = await repository(files);
  const made = await bundleConnector(
    "c",
    "1.2.3",
    join(await scratch(), "out"),
    pin ?? (await readPin()),
    base,
  );
  return { file: made.file, text: await readFile(made.file, "utf8") };
}

/** The static imports at the head of a bundle that name more than a built-in
 *  module of Node: what the bundle would read from `node_modules`. */
function importsOf(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() !== "" && !/^(import |\/\/)/.test(line)) break;
    const from = /^import .* from "([^"]+)"/.exec(line);
    if (from?.[1] !== undefined && !from[1].startsWith("node:")) {
      found.push(from[1]);
    }
  }
  return found;
}

/** Runs a bundle as the host will, and gives what it printed. */
async function started(
  bundle: string,
  options: { flags?: string[]; env?: Record<string, string> } = {},
): Promise<string> {
  const { stdout } = await run(
    process.execPath,
    [...(options.flags ?? permissionFlags(bundle)), bundle],
    { cwd: await scratch(), env: options.env ?? {} },
  );
  return stdout;
}

describe("which folders are connectors", () => {
  it("takes the folders that hold a generated plugin, and not a folder of leftover build output", async () => {
    const base = await repository({
      "connectors/a/plugin/plugin.json": '{"name":"a"}',
      "connectors/readwise-reader/dist/main.js": "",
    });
    // The witness: the leftover folder is a folder of connectors/, and the
    // repository's own connector `c` is found beside `a`.
    expect(await connectorsOf(base)).toEqual(["a", "c"]);
  });

  it("finds exactly the connectors of this repository", async () => {
    const found = await connectorsOf();
    expect(found).toEqual(
      expect.arrayContaining(["github", "readwise", "rss", "todoist"]),
    );
    expect(found).not.toContain("readwise-reader");
  });
});

describe("a bundle", () => {
  it("is one file named for the plugin and the version, and runs from an empty folder under the permission flags", async () => {
    const { file, text } = await bundled({
      "connectors/c/dist/main.js": 'console.log("hello from the bundle");',
    });
    expect(file.endsWith(bundleName("c", "1.2.3"))).toBe(true);
    expect(await started(file)).toBe("hello from the bundle\n");
    // The witness for the flags: they deny a read of any other file.
    const folder = await scratch();
    const reader = join(folder, "reader.mjs");
    const secret = join(folder, "secret.txt");
    await writeFile(secret, "secret");
    await writeFile(
      reader,
      'import { readFileSync } from "node:fs"; readFileSync(process.argv[2]);',
    );
    await expect(
      run(process.execPath, [...permissionFlags(file), reader, secret], {
        env: {},
      }),
    ).rejects.toThrow(/ERR_ACCESS_DENIED/);
    // The same read is allowed for the file the flags name.
    await run(process.execPath, [...permissionFlags(secret), reader, secret], {
      env: {},
    });
    expect(importsOf(text)).toEqual([]);
    // The witness: an import of a package is found as one.
    expect(importsOf('import x from "left-pad";\nx();')).toEqual(["left-pad"]);
  });

  it("refuses a version that is not x.y.z", async () => {
    const base = await repository({ "connectors/c/dist/main.js": "" });
    await expect(
      bundleConnector("c", "v1", await scratch(), await readPin(), base),
    ).rejects.toThrow(/not a version/);
  });

  it("is built for the Node release the pin names", async () => {
    const pin = await readPin();
    const source = {
      "connectors/c/dist/main.js": "let x; x ??= 1; console.log(x);",
    };
    const current = await bundled(source, pin);
    expect(current.text).toContain("??=");
    // The witness: an older target lowers what the pinned one keeps.
    const older = await bundled(source, { ...pin, version: "14.0.0" });
    expect(older.text).not.toContain("??=");
  });
});

describe("MiniJinja's WebAssembly", () => {
  const source = {
    "connectors/c/dist/main.js": [
      'import { Environment } from "minijinja-js";',
      'console.log(new Environment().renderStr("Hello {{ name }}", { name: "bundle" }));',
    ].join("\n"),
  };

  it("is carried in the bundle: a template renders with no file beside it to read", async () => {
    const { file } = await bundled(source);
    expect(await started(file)).toBe("Hello bundle\n");
  });

  it("is read from a file beside the entry when the entry is not bundled", async () => {
    // The witness for the test above: left as it ships, the entry looks for
    // its WebAssembly on the disk, which the permission model denies.
    const base = await repository(source);
    await writeFile(
      join(base, "connectors/c/dist/main.mjs"),
      source["connectors/c/dist/main.js"],
    );
    await expect(
      run(
        process.execPath,
        [
          "--permission",
          `--allow-fs-read=${join(base, "connectors/c/dist/main.mjs")}`,
          join(base, "connectors/c/dist/main.mjs"),
        ],
        { env: {} },
      ),
    ).rejects.toThrow();
  });
});

describe("the kit's telemetry", () => {
  const source = {
    "connectors/c/dist/main.js": [
      "if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined) {",
      '  await import("./telemetry.js");',
      "}",
      'console.log(globalThis.telemetry ?? "not loaded");',
    ].join("\n"),
    "connectors/c/dist/telemetry.js": 'globalThis.telemetry = "loaded";',
  };

  it("is inside the bundle, and loads only when an endpoint is set", async () => {
    const { file } = await bundled(source);
    expect(await started(file)).toBe("not loaded\n");
    expect(
      await started(file, {
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1" },
      }),
    ).toBe("loaded\n");
  });
});

describe("a worker", () => {
  const main = {
    "connectors/c/dist/main.js": [
      'import { Worker } from "node:worker_threads";',
      'new Worker("console.log(42)", { eval: true });',
    ].join("\n"),
  };

  it("is refused under the permission flags, and starts without them", async () => {
    const file = join(await scratch(), "c-1.2.3.connector.mjs");
    // The bundler refuses the code, so the file is made by hand here to
    // show what the flags do with it.
    await writeFile(file, main["connectors/c/dist/main.js"]);
    await expect(started(file)).rejects.toThrow(/ERR_ACCESS_DENIED/);
    // The witness: the same code, without the permission model, starts one.
    expect(await started(file, { flags: [] })).toBe("42\n");
  });

  it("is refused when the code of a connector starts one", async () => {
    const base = await repository(main);
    await expect(
      bundleConnector("c", "1.2.3", await scratch(), await readPin(), base),
    ).rejects.toThrow(/imports node:worker_threads/);
  });
});

describe("SQLite and FFI", () => {
  // Each way a bundle can reach a built-in module, printing what it got.
  const reach = [
    'import { createRequire } from "node:module";',
    "const require = createRequire(import.meta.url);",
    "for (const name of ['node:sqlite', 'node:ffi']) {",
    "  const got = [];",
    "  try { await import(name); got.push('import'); } catch {}",
    "  try { require(name); got.push('require'); } catch {}",
    "  if (process.getBuiltinModule(name) !== undefined) got.push('getBuiltinModule');",
    "  console.log(name + ': ' + (got.join(',') || 'none'));",
    "}",
  ].join("\n");

  it("cannot be loaded by import, require or getBuiltinModule under the permission flags", async () => {
    const file = join(await scratch(), "c-1.2.3.connector.mjs");
    await writeFile(file, reach);
    expect(await started(file)).toBe("node:sqlite: none\nnode:ffi: none\n");
    // The witness: without the two flags, the same code loads node:sqlite.
    const withoutFlags = permissionFlags(file).filter(
      (flag) => !flag.startsWith("--no-experimental-"),
    );
    expect(await started(file, { flags: withoutFlags })).toMatch(
      /^node:sqlite: import,require,getBuiltinModule\n/,
    );
  });
});

describe("what a connector reads from the disk", () => {
  it("is refused when its own code imports a module that writes files or starts a process", async () => {
    for (const module of [
      "node:fs",
      "node:fs/promises",
      "node:os",
      "node:child_process",
      "node:sqlite",
      "node:ffi",
    ]) {
      const base = await repository({
        "connectors/c/dist/main.js": `import "${module}";`,
      });
      await expect(
        bundleConnector("c", "1.2.3", await scratch(), await readPin(), base),
        module,
      ).rejects.toThrow(`imports ${module}`);
    }
  });

  it("is not refused for a dependency, which the bundle may carry unused", async () => {
    await expect(
      bundled({
        "connectors/c/dist/main.js": 'import "carried";',
        "node_modules/carried/package.json":
          '{"name":"carried","main":"index.js"}',
        "node_modules/carried/index.js":
          'import { tmpdir } from "node:os"; export const unused = () => tmpdir();',
      }),
    ).resolves.toBeDefined();
  });
});

describe("what a bundle cannot carry", () => {
  it("refuses a dependency that is a native add-on, naming it", async () => {
    const base = await repository({
      "connectors/c/dist/main.js": 'import "native-thing";',
      "node_modules/native-thing/package.json":
        '{"name":"native-thing","main":"index.js"}',
      "node_modules/native-thing/index.js":
        'module.exports = require("./build/thing.node");',
      "node_modules/native-thing/build/thing.node": "not really a binary",
    });
    await expect(
      bundleConnector("c", "1.2.3", await scratch(), await readPin(), base),
    ).rejects.toThrow(/thing\.node is a native add-on/);
  });

  it("refuses a dependency that loads an add-on by a loader of its own", async () => {
    const base = await repository({
      "connectors/c/dist/main.js": 'import "loads-addon";',
      "node_modules/loads-addon/package.json":
        '{"name":"loads-addon","main":"index.js"}',
      "node_modules/loads-addon/index.js":
        "module.exports = (path) => process.dlopen({ exports: {} }, path);",
    });
    await expect(
      bundleConnector("c", "1.2.3", await scratch(), await readPin(), base),
    ).rejects.toThrow(/loads-addon\/index\.js is, or loads, a native add-on/);
  });

  it("refuses a dependency that calls require with what esbuild cannot resolve", async () => {
    const base = await repository({
      "connectors/c/dist/main.js": 'import "dynamic-require";',
      "node_modules/dynamic-require/package.json":
        '{"name":"dynamic-require","main":"index.js"}',
      "node_modules/dynamic-require/index.js":
        "module.exports = (name) => require(name);",
    });
    await expect(
      bundleConnector("c", "1.2.3", await scratch(), await readPin(), base),
    ).rejects.toThrow(/calls require/);
  });

  it("refuses a dependency that finds files by its own location, and says how to list it once reviewed", async () => {
    const base = await repository({
      "connectors/c/dist/main.js": 'import "by-location";',
      "node_modules/by-location/package.json":
        '{"name":"by-location","main":"index.js"}',
      "node_modules/by-location/index.js":
        'import { readFileSync } from "node:fs"; export default readFileSync(__dirname + "/data.json");',
    });
    await expect(
      bundleConnector("c", "1.2.3", await scratch(), await readPin(), base),
    ).rejects.toThrow(/by-location\/index\.js finds files by its own location/);
    for (const text of [
      "import.meta.url",
      "import.meta.dirname",
      "__filename",
    ]) {
      await mkdir(join(base, "node_modules/other"), { recursive: true });
      await writeFile(join(base, "node_modules/other/index.js"), `x(${text});`);
      expect(
        await refusals({ "node_modules/other/index.js": {} as never }, base),
        text,
      ).toHaveLength(1);
    }
    // The witness: a dependency that does none of these is let through.
    await writeFile(join(base, "node_modules/other/index.js"), "x(1);");
    expect(
      await refusals({ "node_modules/other/index.js": {} as never }, base),
    ).toEqual([]);
  });
});

describe("Readwise content downloaded from a URL", () => {
  it("is held and replayed by the Readwise code in a bundle under the permission flags, which let it write no file", async () => {
    const dist = join(root, "connectors", "readwise", "dist");
    const { file } = await bundled({
      "connectors/c/dist/main.js": [
        `import { download } from "${join(dist, "content.js")}";`,
        `import { stageContent } from "${join(dist, "content-staging.js")}";`,
        "const bytes = new Uint8Array(200_000).fill(42);",
        "const signal = new AbortController().signal;",
        'const content = await download("https://readwise-assets.s3.amazonaws.com/f.pdf", signal, {',
        '  fetch: () => Promise.resolve(new Response(bytes, { headers: { "content-type": "application/pdf" } })),',
        "});",
        "const load = await stageContent(content, signal);",
        "let total = 0;",
        "for (let attempt = 0; attempt < 2; attempt++) {",
        "  const loaded = await load(signal);",
        "  total += (await new Response(loaded.bytes).arrayBuffer()).byteLength;",
        "}",
        "console.log(total);",
      ].join("\n"),
    });
    expect(await started(file)).toBe("400000\n");
  });
});

describe("the connectors of this repository, built", () => {
  it("each bundle is one file that answers --help under the permission flags, from an empty folder", async () => {
    const out = join(await scratch(), "bundles");
    const names = await connectorsOf();
    const pin = await readPin();
    for (const name of names) {
      const made = await bundleConnector(name, "0.0.0", out, pin);
      expect(made.bytes, name).toBeGreaterThan(0);
    }
    const bundles = await bundlesIn(out);
    expect(bundles).toHaveLength(names.length);
    for (const bundle of bundles) {
      const { printed } = await helpOf(bundle);
      expect(printed, bundle).toContain("MARFA_API_URL");
      expect(importsOf(await readFile(bundle, "utf8")), bundle).toEqual([]);
    }
    // The kit's telemetry is in each bundle, behind its dynamic import.
    expect(await readFile(bundles[0] ?? "", "utf8")).toContain(
      "OTEL_EXPORTER_OTLP_ENDPOINT",
    );
  });

  it("refuses to run when the help cannot be had", async () => {
    const folder = await scratch();
    const broken = join(folder, "broken-0.0.0.connector.mjs");
    await writeFile(broken, 'throw new Error("it does not start");');
    await expect(helpOf(broken)).rejects.toThrow();
  });
});
