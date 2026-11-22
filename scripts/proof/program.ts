import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Whether the module at `url` is the program being run, and not imported by
 *  the proof to read the connector it defines. */
export function isProgram(url: string): boolean {
  const run = process.argv[1];
  return run !== undefined && pathToFileURL(realpathSync(run)).href === url;
}
