/**
 * Checks every plugin of this repository as installing it will: it runs
 * `marfa plugins check` on each source folder and fails, naming the folder,
 * when any is refused. A folder of `types/` that is no plugin fails too.
 *
 *   node --experimental-strip-types scripts/check-plugins.ts
 *
 * Run `scripts/monorepo.sh` first; `MARFA_BIN` names another `marfa`.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPlugins, root, runMarfa } from "./release/plugins.ts";

export interface Checked {
  /** The folders that passed. */
  passed: string[];
  /** The folders that did not, each with what was said of it. */
  failures: string[];
}

export async function checkPlugins(base: string = root): Promise<Checked> {
  const { plugins, problems } = findPlugins(base);
  const checked: Checked = { passed: [], failures: [...problems] };
  for (const plugin of plugins) {
    const ran = await runMarfa(["plugins", "check", join(base, plugin.folder)]);
    if (ran.code === 0) {
      checked.passed.push(plugin.folder);
    } else {
      const said = `${ran.stdout}${ran.stderr}`.trim();
      checked.failures.push(
        `${plugin.folder}: marfa plugins check exited ${String(ran.code)}\n${said}`,
      );
    }
  }
  return checked;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { passed, failures } = await checkPlugins();
    for (const folder of passed) console.log(`ok   ${folder}`);
    for (const failure of failures) console.log(`FAIL ${failure}`);
    if (passed.length + failures.length === 0) console.log("no plugins yet");
    process.exitCode = failures.length === 0 ? 0 : 1;
  } catch (error) {
    console.log(
      `FAIL the check could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
