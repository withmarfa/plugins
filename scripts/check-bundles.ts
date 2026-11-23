/**
 * Runs each connector bundle in a folder as the connector host will: under the
 * permission flags, from an empty folder with no `node_modules` anywhere on
 * its path, with `--help`. A bundle that needs anything it was not given,
 * a file beside it, a dependency or a permission, fails here.
 *
 *   node --experimental-strip-types scripts/check-bundles.ts <folder of bundles>
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { permissionFlags } from "./permission-flags.ts";

const run = promisify(execFile);

export interface Helped {
  bundle: string;
  /** What it printed, whether on the standard output or the error output,
   *  where the kit prints its help and Node its warnings. */
  printed: string;
}

/**
 * What `bundle --help` prints under the permission flags, from an empty folder
 * with an empty environment. Rejects
 * when the bundle exits with anything but 0.
 */
export async function helpOf(
  bundle: string,
  node = process.execPath,
): Promise<Helped> {
  const folder = await mkdtemp(join(tmpdir(), "bundle-help-"));
  try {
    bundle = await realpath(bundle);
    const { stdout, stderr } = await run(
      node,
      [...permissionFlags(bundle), bundle, "--help"],
      { cwd: folder, env: {} },
    );
    return { bundle, printed: stdout + stderr };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** The bundles in `folder`. */
export async function bundlesIn(folder: string): Promise<string[]> {
  return (await readdir(folder))
    .filter((name) => name.endsWith(".connector.mjs"))
    .sort()
    .map((name) => join(folder, name));
}

async function main(): Promise<void> {
  const folder = process.argv[2];
  if (folder === undefined) {
    throw new Error("usage: check-bundles.ts <folder of bundles>");
  }
  const bundles = await bundlesIn(resolve(folder));
  if (bundles.length === 0) throw new Error(`${folder} holds no bundle`);
  console.log(`node ${process.version}`);
  for (const bundle of bundles) {
    const { printed } = await helpOf(bundle);
    if (!printed.includes("MARFA_API_URL")) {
      throw new Error(`${bundle} printed no help`);
    }
    console.log(`${bundle} --help: ok`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
