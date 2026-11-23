/**
 * The connector host a release carries: one archive per platform, and the
 * script that installs it. An archive holds a small shell program, the Node
 * `host/node.json` pins, the host bundled into one file, and the licences.
 * The shell program is what a service runs, so an update moves `current` and
 * leaves the service file alone.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import {
  fetchNode,
  nodeTarget,
  platforms,
  readPin,
  type Pin,
  type Platform,
} from "../node-pin.ts";
import { root } from "./plugins.ts";
import { tarGz } from "./tar.ts";

export const installHostName = "install-host.sh";

/** The directory an archive unpacks, and the name of the program inside it. */
export const archiveDirectory = "marfa-connector-host";

export function hostArchiveName(version: string, platform: string): string {
  return `${archiveDirectory}-${version}-${platform}.tar.gz`;
}

/**
 * Follows this file when it is a symlink, then changes to its real directory,
 * so `current` resolves before `../lib` is read.
 */
export const wrapperScript = [
  "#!/bin/sh",
  "set -eu",
  "self=$0",
  'while [ -L "$self" ]; do',
  '  dir=$(dirname "$self")',
  '  target=$(readlink "$self")',
  "  case $target in",
  "    /*) self=$target ;;",
  '    *) self="$dir/$target" ;;',
  "  esac",
  "done",
  'cd -P "$(dirname "$self")"',
  'exec ../lib/node ../lib/host.mjs "$@"',
  "",
].join("\n");

/**
 * `bin/node` and `LICENSE` for `platform`, from `MARFA_NODE_CACHE` when that
 * directory already holds the pin's archive, and fetched otherwise.
 */
export async function nodeFor(
  platform: Platform,
  pin?: Pin,
): Promise<{ node: string; license: string }> {
  const held = pin ?? (await readPin());
  const chosen = process.env["MARFA_NODE_CACHE"];
  const cache =
    chosen !== undefined && chosen !== ""
      ? chosen
      : join(tmpdir(), "marfa-node-cache");
  const dir = join(cache, held.version, platform);
  const marker = join(dir, "archive.sha256");
  const node = join(dir, "bin", "node");
  const license = join(dir, "LICENSE");
  const wanted = held.platforms[platform].sha256;
  const recorded = await readFile(marker, "utf8").catch(() => "");
  if (recorded.trim() === wanted && existsSync(node) && existsSync(license)) {
    return { node, license };
  }
  const fetched = await fetchNode(platform, dir, held);
  await writeFile(marker, `${wanted}\n`);
  return { node: fetched.node, license: fetched.license };
}

/**
 * The host as one ECMAScript module, with its dependencies inside, and the
 * repository it updates from written in.
 */
export async function bundleHost(file: string, repo: string): Promise<void> {
  const pin = await readPin();
  await mkdir(dirname(file), { recursive: true });
  await build({
    entryPoints: [join(root, "host/src/main.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: nodeTarget(pin),
    outfile: file,
    logLevel: "silent",
    legalComments: "none",
    define: { MARFA_PLUGINS_REPOSITORY: JSON.stringify(repo) },
    plugins: [
      {
        name: "resolve-typescript",
        setup(esbuild) {
          esbuild.onResolve({ filter: /^\.{1,2}\// }, (args) => {
            if (!args.path.endsWith(".js")) return undefined;
            const source = resolve(
              args.resolveDir,
              args.path.replace(/\.js$/, ".ts"),
            );
            if (!existsSync(source)) return undefined;
            return { path: source };
          });
        },
      },
    ],
  });
}

function quote(value: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new Error(`${value} cannot be written into install-host.sh`);
  }
  return `'${value}'`;
}

/** `install-host.sh` with this release's version and repository filled in. */
export async function renderInstallHost(
  version: string,
  repo: string,
): Promise<string> {
  const template = await readFile(
    join(import.meta.dirname, "install-host.sh"),
    "utf8",
  );
  if (!template.includes("@VERSION@") || !template.includes("@REPOSITORY@")) {
    throw new Error("install-host.sh has no version or repository to fill in");
  }
  const rendered = template
    .replaceAll("@VERSION@", quote(version))
    .replaceAll("@REPOSITORY@", quote(repo));
  if (rendered.includes("@VERSION@") || rendered.includes("@REPOSITORY@")) {
    throw new Error("install-host.sh still has a placeholder");
  }
  return rendered;
}

/** What a test hands `build` instead of fetching Node and bundling the host. */
export interface ReleaseParts {
  node?: (platform: Platform) => Promise<{ node: string; license: string }>;
  bundleHost?: (file: string, repo: string) => Promise<void>;
}

/**
 * Writes one archive per platform, and `install-host.sh`, into `out`.
 */
export async function writeHostRelease(
  version: string,
  out: string,
  repo: string,
  parts: ReleaseParts = {},
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "host-bundle-"));
  try {
    const bundled = join(scratch, "host.mjs");
    await (parts.bundleHost ?? bundleHost)(bundled, repo);
    const hostBytes = await readFile(bundled);
    const license = await readFile(join(root, "LICENSE"));
    const wrapper = Buffer.from(wrapperScript);
    const nodeOf = parts.node ?? ((platform: Platform) => nodeFor(platform));
    for (const platform of platforms) {
      const fetched = await nodeOf(platform);
      const archive = tarGz([
        {
          path: `${archiveDirectory}/bin/${archiveDirectory}`,
          bytes: wrapper,
          mode: 0o755,
        },
        {
          path: `${archiveDirectory}/lib/node`,
          bytes: await readFile(fetched.node),
          mode: 0o755,
        },
        {
          path: `${archiveDirectory}/lib/host.mjs`,
          bytes: hostBytes,
          mode: 0o644,
        },
        {
          path: `${archiveDirectory}/LICENSE`,
          bytes: license,
          mode: 0o644,
        },
        {
          path: `${archiveDirectory}/LICENSE.node`,
          bytes: await readFile(fetched.license),
          mode: 0o644,
        },
      ]);
      await writeFile(join(out, hostArchiveName(version, platform)), archive);
    }
    await writeFile(
      join(out, installHostName),
      await renderInstallHost(version, repo),
      {
        mode: 0o755,
      },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
