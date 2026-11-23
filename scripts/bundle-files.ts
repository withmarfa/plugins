/**
 * Where a connector's bundle is: its file name at a version, and the one
 * bundle of a connector in a folder, by its real path, since the permission
 * flags (`host/src/permission-flags.ts`) refuse a bundle reached through a
 * link.
 */
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

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
