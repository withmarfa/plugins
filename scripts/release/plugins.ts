/**
 * Finds the plugins of this repository and runs the pinned `marfa` command
 * line on them. Every script that checks, builds or proves a plugin goes
 * through here, so they all find the same folders and run the same binary.
 *
 * A plugin's source folder is `types/<name>/` for a family of common types,
 * and `connectors/<name>/plugin/` for the plugin a connector generates.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "../..");

export interface Plugin {
  /** The folder from the repository root, with forward slashes. */
  folder: string;
  /** The `name` of its `plugin.json`. */
  name: string;
}

export interface Found {
  plugins: Plugin[];
  /** What stops the folder tree from being a set of plugins, by folder. */
  problems: string[];
}

function entries(folder: string): string[] {
  return existsSync(folder)
    ? readdirSync(folder)
        .filter((entry) => !entry.startsWith("."))
        .sort()
    : [];
}

function isFolder(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** The name in `folder`'s `plugin.json`, or what is wrong with it. */
function nameOf(base: string, folder: string): string | { problem: string } {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readFileSync(join(base, folder, "plugin.json"), "utf8"),
    );
  } catch (error) {
    return {
      problem: `${folder}: plugin.json cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const name = (manifest as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || name === "") {
    return { problem: `${folder}: plugin.json has no name` };
  }
  return name;
}

/**
 * Every plugin source folder under `base`. A folder of `types/` with no
 * `plugin.json` and a file of `types/` other than `README.md` are problems,
 * never skipped: a family that cannot be found is a family that is not
 * checked, and so not released. Two folders that name one plugin are a
 * problem too, since they would write one bundle.
 */
export function findPlugins(base: string = root): Found {
  const folders: string[] = [];
  const problems: string[] = [];
  for (const entry of entries(join(base, "types"))) {
    const folder = `types/${entry}`;
    if (isFolder(join(base, folder))) {
      if (existsSync(join(base, folder, "plugin.json"))) folders.push(folder);
      else problems.push(`${folder}: holds no plugin.json`);
    } else if (entry !== "README.md") {
      problems.push(`${folder}: is not a plugin folder`);
    }
  }
  for (const entry of entries(join(base, "connectors"))) {
    const folder = `connectors/${entry}/plugin`;
    if (!isFolder(join(base, folder))) continue;
    if (existsSync(join(base, folder, "plugin.json"))) folders.push(folder);
    else problems.push(`${folder}: holds no plugin.json`);
  }
  const plugins: Plugin[] = [];
  const named = new Map<string, string>();
  for (const folder of folders) {
    const name = nameOf(base, folder);
    if (typeof name !== "string") {
      problems.push(name.problem);
      continue;
    }
    const other = named.get(name);
    if (other !== undefined) {
      problems.push(`${folder}: names the plugin ${name}, as ${other} does`);
      continue;
    }
    named.set(name, folder);
    plugins.push({ folder, name });
  }
  return { plugins, problems };
}

/**
 * The `marfa` to run: the one `MARFA_BIN` names, or the pinned release's,
 * which `scripts/monorepo.sh` fetched.
 */
export function marfaProgram(base: string = root): string {
  const named = process.env["MARFA_BIN"];
  if (named !== undefined && named !== "") return resolve(named);
  const pin = readFileSync(
    join(base, "scripts/monorepo.commit"),
    "utf8",
  ).trim();
  const held = join(base, "vendor/marfa/commit");
  const have = existsSync(held) ? readFileSync(held, "utf8").trim() : undefined;
  if (have !== pin) {
    throw new Error(
      `vendor/marfa holds ${have ?? "no marfa"}, the pin is ${pin}; run scripts/monorepo.sh`,
    );
  }
  return join(base, "vendor/marfa/marfa");
}

/** A name is the script's to choose, never the shell's. */
function inherited(name: string): boolean {
  return name.startsWith("MARFA_") || name.startsWith("OTEL_");
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `marfa` with `args`, with no keychain, no telemetry and nothing of the
 * caller's `MARFA_` settings but those in `env`. A run that cannot start (no
 * such program) throws; a run that exits non-zero answers its code.
 */
export function runMarfa(
  args: readonly string[],
  options: {
    env?: Record<string, string>;
    cwd?: string;
    program?: string;
  } = {},
): Promise<Ran> {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!inherited(name)) env[name] = value;
  }
  env["MARFA_NO_KEYCHAIN"] = "1";
  env["OTEL_SDK_DISABLED"] = "true";
  Object.assign(env, options.env);
  const program = options.program ?? marfaProgram();
  return new Promise((done, fail) => {
    execFile(
      program,
      [...args],
      {
        env,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          done({ code: 0, stdout, stderr });
        } else if (typeof error.code === "number") {
          done({ code: error.code, stdout, stderr });
        } else {
          fail(
            new Error(`${program} did not run: ${error.message}`, {
              cause: error,
            }),
          );
        }
      },
    );
  });
}
