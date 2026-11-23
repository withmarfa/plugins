/**
 * Bundles each connector into one file, `<plugin>-<version>.connector.mjs`,
 * that the connector host runs with the Node it carries: the kit and every
 * dependency are inside, and nothing is read from `node_modules` or from the
 * disk beside it at run time.
 *
 *   node --experimental-strip-types scripts/bundle-connectors.ts --version 0.0.13 --out <folder> [--connector rss]
 *
 * Run `pnpm build` first: a bundle is made from what the build left in each
 * connector's `dist/`. The connectors are the folders `connectors/<name>/`
 * that hold a generated `plugin/plugin.json`, so a folder of leftover build
 * output is none. The target is the Node release `host/node.json` pins.
 *
 * Three things a bundle cannot leave to the disk are carried in it:
 * MiniJinja's WebAssembly, which its Node entry reads from a file beside
 * itself; the RSS connector's worker, whose source is embedded and started
 * from a string; and the kit's telemetry, which stays behind its dynamic
 * `import()` and runs only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. A build
 * is refused, naming what it found, when a dependency is a native add-on,
 * calls `require` with an argument esbuild cannot resolve, or finds files by
 * its own location unless that use is listed in `reviewedReads`.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Metafile, type Plugin } from "esbuild";
import { nodeTarget, readPin, type Pin } from "./node-pin.ts";
import { bundleName } from "./permission-flags.ts";

const root = resolve(import.meta.dirname, "..");

export interface Bundled {
  plugin: string;
  file: string;
  bytes: number;
}

/**
 * What a dependency does by its own location and was reviewed: each is code
 * the bundle never reaches.
 */
export const reviewedReads: readonly { input: RegExp; why: string }[] = [
  {
    input: /\/minijinja-js\/dist\/wasm\/minijinja_js\.js$/,
    why: "its default loader fetches the WebAssembly beside it, and the bundle starts it from bytes it carries instead",
  },
];

const besideItself =
  /__dirname|__filename|import\.meta\.(?:url|dirname|filename)/;

const nativeAddOns =
  /\bprocess\.dlopen\b|\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:bindings|node-gyp-build|prebuild-install|node-pre-gyp)\//;

/** The `new Worker(new URL("./file.js", import.meta.url), {` of a connector's
 *  own code, which a bundle has no file to start. */
const workerStart =
  /new Worker\(\s*new URL\(\s*"(\.\/[^"]+)"\s*,\s*import\.meta\.url\s*\)\s*,\s*\{/g;

/**
 * MiniJinja's Node entry reads its WebAssembly from a file beside it. The
 * bundle takes the entry that initializes from bytes, and carries them.
 */
function minijinja(): Plugin {
  return {
    name: "minijinja-wasm",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^minijinja-js$/ }, (args) => ({
        path: "minijinja-js",
        namespace: "minijinja-wasm",
        pluginData: { resolveDir: args.resolveDir },
      }));
      esbuild.onLoad({ filter: /.*/, namespace: "minijinja-wasm" }, (args) => ({
        contents: [
          'import wasm from "minijinja-js/minijinja_js_bg.wasm";',
          'import { initSync } from "minijinja-js/init";',
          "initSync(wasm);",
          'export { Environment, SafeString, TemplateError, markSafe, passState } from "minijinja-js/init";',
        ].join("\n"),
        resolveDir: (args.pluginData as { resolveDir: string }).resolveDir,
        loader: "js",
      }));
    },
  };
}

/** Refuses a native add-on, which a bundle cannot carry and the permission
 *  model does not let a connector load. */
function noAddOns(): Plugin {
  return {
    name: "no-native-add-ons",
    setup(esbuild) {
      esbuild.onLoad({ filter: /\.node$/ }, (args) => {
        throw new Error(
          `${args.path} is a native add-on, which a connector bundle cannot carry`,
        );
      });
    },
  };
}

/**
 * Embeds the worker a connector's own code starts from a file. The worker is
 * bundled as a script and started from its source, with `eval: true`.
 */
function workers(inner: (entry: string) => Promise<string>): Plugin {
  return {
    name: "embedded-workers",
    setup(esbuild) {
      esbuild.onLoad({ filter: /\.js$/ }, async (args) => {
        if (args.path.includes("/node_modules/")) return undefined;
        const text = await readFile(args.path, "utf8");
        if (!text.includes("new Worker(")) return undefined;
        const starts = [...text.matchAll(workerStart)];
        if (starts.length !== text.split("new Worker(").length - 1) {
          throw new Error(
            `${args.path} starts a worker in a form the bundle cannot embed: use \`new Worker(new URL("./file.js", import.meta.url), { ... })\``,
          );
        }
        let contents = text;
        for (const start of starts) {
          const file = resolve(args.path, "..", start[1] ?? "");
          const embedded = `new Worker(${JSON.stringify(await inner(file))}, { eval: true,`;
          contents = contents.replace(start[0], () => embedded);
        }
        return { contents, loader: "js", resolveDir: resolve(args.path, "..") };
      });
    },
  };
}

interface Built {
  code: string;
  inputs: Metafile["inputs"];
}

async function bundle(
  entry: string,
  format: "esm" | "cjs",
  target: string,
  base: string,
  inWorker = false,
): Promise<Built> {
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: base,
    bundle: true,
    platform: "node",
    format,
    target,
    write: false,
    metafile: true,
    logLevel: "silent",
    loader: { ".wasm": "binary" },
    plugins: [
      minijinja(),
      noAddOns(),
      // A worker's own bundle starts no worker: it is refused as any
      // `import.meta` is in a script.
      ...(inWorker
        ? []
        : [
            workers(
              async (file) =>
                (await bundle(file, "cjs", target, base, true)).code,
            ),
          ]),
    ],
  });
  if (result.warnings.length > 0) {
    throw new Error(
      `bundling ${entry} gave warnings, which a bundle that must run without a disk to read refuses:\n${result.warnings
        .map(
          (warning) =>
            `${warning.location?.file ?? ""}:${String(warning.location?.line ?? 0)} ${warning.text}`,
        )
        .join("\n")}`,
    );
  }
  const code = result.outputFiles[0]?.text;
  if (code === undefined || result.outputFiles.length !== 1) {
    throw new Error(
      `bundling ${entry} made ${String(result.outputFiles.length)} files, not one`,
    );
  }
  if (/\bvar __require\s*=/.test(code)) {
    throw new Error(
      `${entry} reaches a dependency that calls require where esbuild cannot resolve it, and an ES module bundle has no require`,
    );
  }
  return { code, inputs: result.metafile.inputs };
}

/** What a dependency's code does that a bundle cannot keep working, as a
 *  message, or nothing. */
export async function refusals(
  inputs: Metafile["inputs"],
  base = root,
): Promise<string[]> {
  const found: string[] = [];
  for (const input of Object.keys(inputs)) {
    if (!input.includes("node_modules/")) continue;
    const text = await readFile(join(base, input), "utf8");
    const path = `/${input}`;
    if (nativeAddOns.test(path) || nativeAddOns.test(text)) {
      found.push(`${input} is, or loads, a native add-on`);
    } else if (
      besideItself.test(text) &&
      !reviewedReads.some((reviewed) => reviewed.input.test(path))
    ) {
      found.push(
        `${input} finds files by its own location (__dirname, __filename or import.meta); review it, and list it in reviewedReads if it never does at run time`,
      );
    }
  }
  return found;
}

/** The connectors of `base`: the folders that hold a generated plugin. */
export async function connectorsOf(base = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(base, "connectors"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const manifest = await readFile(
      join(base, "connectors", entry.name, "plugin", "plugin.json"),
      "utf8",
    ).catch(() => undefined);
    if (manifest !== undefined) {
      found.push((JSON.parse(manifest) as { name: string }).name);
    }
  }
  return found.sort();
}

/**
 * Bundles one connector of the repository at `base`, built, at `version` into
 * `out`; the connector's entry is its `dist/main.js`.
 */
export async function bundleConnector(
  plugin: string,
  version: string,
  out: string,
  pin: Pin,
  base = root,
): Promise<Bundled> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${version} is not a version such as 1.2.3`);
  }
  const entry = join("connectors", plugin, "dist", "main.js");
  const built = await bundle(entry, "esm", nodeTarget(pin), base).catch(
    (error: unknown) => {
      throw new Error(
        `${plugin}: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    },
  );
  const problems = await refusals(built.inputs, base);
  if (problems.length > 0) {
    throw new Error(`${plugin} cannot be bundled:\n${problems.join("\n")}`);
  }
  await mkdir(out, { recursive: true });
  const file = join(out, bundleName(plugin, version));
  await writeFile(file, built.code);
  return { plugin, file, bytes: Buffer.byteLength(built.code) };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const version = value("--version");
  const out = value("--out");
  if (version === undefined || out === undefined) {
    throw new Error(
      "usage: bundle-connectors.ts --version <version> --out <folder> [--connector <name>]",
    );
  }
  const pin = await readPin();
  const only = value("--connector");
  const names = only === undefined ? await connectorsOf() : [only];
  for (const name of names) {
    const made = await bundleConnector(name, version, resolve(out), pin);
    console.log(`${made.file} ${String(made.bytes)} bytes`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
