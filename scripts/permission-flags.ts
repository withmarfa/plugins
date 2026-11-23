/**
 * How a connector's bundle is run: the flags the connector host starts it
 * with, and where the proof finds a bundle to start. One place, so the
 * proof, the CI job and the host cannot disagree on what a connector is
 * allowed.
 *
 * The Node permission model denies everything the flags do not grant: no
 * write to the file system, no child process, no native add-on. A bundle
 * reads only itself. `--allow-net` is needed because the permission model
 * denies the network by default (Node 25 and later); `--allow-worker` is
 * needed by the RSS connector, which parses a feed in a worker with a capped
 * heap. A worker runs under the same permissions as the process that starts
 * it.
 *
 * Node resolves the real path of its entry before it reads it, and that
 * reads every folder on the way: a bundle reached through a link (macOS's
 * `/var` and `/tmp` are links) is refused as `ERR_ACCESS_DENIED` on the link.
 * The bundle named in the flags and run must be a real path, which `bundleIn`
 * and `scripts/check-bundles.ts` give.
 */
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function permissionFlags(bundle: string): string[] {
  return [
    "--permission",
    `--allow-fs-read=${bundle}`,
    "--allow-net",
    "--allow-worker",
  ];
}

/** The file name of a connector's bundle at a version. */
export const bundleName = (plugin: string, version: string): string =>
  `${plugin}-${version}.connector.mjs`;

/** The bundle of `plugin` in `folder`, whatever version it was built at. */
export function bundleIn(folder: string, plugin: string): string {
  const found = readdirSync(folder).filter(
    (name) =>
      /^[a-z0-9-]+-\d+\.\d+\.\d+\.connector\.mjs$/.test(name) &&
      name.slice(0, name.lastIndexOf("-")) === plugin,
  );
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(
      `${folder} holds ${String(found.length)} bundles of ${plugin}, and the proof needs one`,
    );
  }
  return realpathSync(join(folder, found[0]));
}
