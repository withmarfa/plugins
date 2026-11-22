/**
 * What a plugin owes the versions already published: a newer version may only
 * add to its types. Marfa's server holds that rule (`plugins/update-only-adds`,
 * answering `409 plugin_narrows`); this module only asks it, by installing the
 * latest published bundle of a plugin into a server and then the bundle built
 * from the source at the next version.
 *
 * The release address is one variable, `MARFA_PLUGINS_URL`, the one the
 * `marfa` command line reads to install by name, so a test points both at a
 * local server.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root, runMarfa, type Plugin } from "./plugins.ts";

/** Where the latest published release of the plugins repository serves its files. */
export const latestRelease =
  "https://github.com/withmarfa/plugins/releases/latest/download";

/** The release to compare with: `MARFA_PLUGINS_URL`, or the latest published. */
export function releaseAddress(): string {
  const named = process.env["MARFA_PLUGINS_URL"];
  return (named === undefined || named === "" ? latestRelease : named).replace(
    /\/+$/,
    "",
  );
}

export interface IndexEntry {
  name: string;
  version: string;
  has_connector: boolean;
  bundle: string;
  sha256: string;
}

export interface Index {
  format: number;
  plugins: IndexEntry[];
}

export interface Fetching {
  fetch?: typeof fetch;
  /** Tries before a network error or a 5xx counts. */
  attempts?: number;
  retryDelayMs?: number;
}

/**
 * A file of a release, or `undefined` when the release answers 404 for it: no
 * release yet, or a release without the file. Any other failure throws, naming
 * the address, so an unreadable release is never taken for an empty one.
 */
async function fetchFile(
  address: string,
  { fetch: get = fetch, attempts = 3, retryDelayMs = 1000 }: Fetching,
): Promise<Uint8Array | undefined> {
  let last = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1)
      await new Promise((done) => setTimeout(done, retryDelayMs));
    try {
      const response = await get(address, {
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) return undefined;
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      last = `answered ${String(response.status)}`;
      if (response.status < 500) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`${address} could not be read: ${last}`);
}

/**
 * The index of the release at `address`, or `undefined` when it has none.
 */
export async function readPublished(
  address: string = releaseAddress(),
  fetching: Fetching = {},
): Promise<Index | undefined> {
  const url = `${address}/plugins.json`;
  const bytes = await fetchFile(url, fetching);
  if (bytes === undefined) return undefined;
  let index: unknown;
  try {
    index = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${url} is not JSON`);
  }
  const listed = (index as { format?: unknown; plugins?: unknown } | null)
    ?.plugins;
  if ((index as { format?: unknown }).format !== 1 || !Array.isArray(listed)) {
    throw new Error(`${url} is not an index of format 1`);
  }
  return index as Index;
}

/** The bundle an index entry lists, checked against the SHA-256 the index gives. */
export async function readBundle(
  address: string,
  entry: IndexEntry,
  fetching: Fetching = {},
): Promise<Uint8Array> {
  const url = `${address}/${entry.bundle}`;
  const bytes = await fetchFile(url, fetching);
  if (bytes === undefined) {
    throw new Error(`${url} is listed by plugins.json and is not there`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== entry.sha256) {
    throw new Error(
      `${url} has the SHA-256 ${actual}, and plugins.json lists ${entry.sha256}`,
    );
  }
  return bytes;
}

/** `1.2.3` is followed by `1.2.4`. */
export function nextVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    throw new Error(`${version} is not a version such as 1.2.3`);
  }
  return `${match[1]}.${match[2]}.${String(Number(match[3]) + 1)}`;
}

/** What the server answered to an install, or why it refused. */
export class InstallRefused extends Error {
  readonly plugin: string;
  readonly code: string;
  readonly changes: unknown;

  constructor(plugin: string, code: string, changes: unknown, message: string) {
    super(message);
    this.plugin = plugin;
    this.code = code;
    this.changes = changes;
  }
}

/** The server and key a plugin is installed into, as the `marfa` command line reads them. */
export interface Target {
  url: string;
  key: string;
}

/** The error object `--json` ends stderr with, which the server's refusal fills. */
function refusal(stderr: string): {
  code?: string;
  message?: string;
  details?: { changes?: unknown };
} {
  const line = stderr.trim().split("\n").at(-1) ?? "";
  try {
    const error = (
      JSON.parse(line) as {
        error?: {
          code?: string;
          message?: string;
          server?: { code?: string; details?: { changes?: unknown } } | null;
        };
      }
    ).error;
    return {
      ...(error?.server?.code === undefined
        ? error?.code === undefined
          ? {}
          : { code: error.code }
        : { code: error.server.code }),
      ...(error?.message === undefined ? {} : { message: error.message }),
      ...(error?.server?.details === undefined
        ? {}
        : { details: error.server.details }),
    };
  } catch {
    return { message: stderr.trim() };
  }
}

/**
 * Installs `nameOrPath` (a bundle file, a source folder or a name) as `plugin`
 * into the server. Answers the server's answer; a refusal throws
 * `InstallRefused`, naming the plugin and carrying `details.changes`.
 */
export async function install(
  plugin: string,
  nameOrPath: string,
  target: Target,
  options: { version?: string; cwd?: string; address?: string } = {},
): Promise<{ outcome: string; version: string }> {
  const env: Record<string, string> = {
    MARFA_API_URL: target.url,
    MARFA_API_KEY: target.key,
  };
  if (options.address !== undefined) env["MARFA_PLUGINS_URL"] = options.address;
  const ran = await runMarfa(
    [
      "--json",
      "plugins",
      "install",
      nameOrPath,
      ...(options.version === undefined ? [] : ["--version", options.version]),
    ],
    { env, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) },
  );
  if (ran.code !== 0) {
    const said = refusal(ran.stderr);
    throw new InstallRefused(
      plugin,
      said.code ?? "unknown",
      said.details?.changes,
      `${plugin} was refused (${said.code ?? `exit ${String(ran.code)}`}): ${said.message ?? ran.stderr.trim()}${said.details?.changes === undefined ? "" : ` details.changes: ${JSON.stringify(said.details.changes)}`}`,
    );
  }
  const answer = JSON.parse(ran.stdout) as { outcome: string; version: string };
  return { outcome: answer.outcome, version: answer.version };
}

/** Builds the bundle of a source folder at `version` in `out`, answering its path. */
export async function bundle(
  folder: string,
  version: string,
  out: string,
): Promise<string> {
  await mkdir(out, { recursive: true });
  const ran = await runMarfa([
    "plugins",
    "bundle",
    folder,
    "--version",
    version,
    "--output",
    out,
  ]);
  if (ran.code !== 0) {
    throw new Error(
      `marfa plugins bundle ${folder} exited ${String(ran.code)}: ${ran.stderr.trim()}`,
    );
  }
  const name = (
    JSON.parse(await readFile(join(folder, "plugin.json"), "utf8")) as {
      name: string;
    }
  ).name;
  return join(out, `${name}.plugin.json`);
}

/**
 * Proves one plugin of the source against `published`, the index of the
 * latest release (or `undefined` for none). When the index lists it, installs
 * that bundle, then the source at the next version, so a version that narrows
 * is refused by the server and fails here; otherwise installs the source
 * alone. Answers a line saying which.
 */
export async function proveAgainstPublished(
  plugin: Plugin,
  published: Index | undefined,
  address: string,
  target: Target,
  work: string,
  fetching: Fetching = {},
  base: string = root,
): Promise<string> {
  const folder = join(base, plugin.folder);
  const listed = published?.plugins.find((entry) => entry.name === plugin.name);
  if (listed === undefined) {
    const file = await bundle(
      folder,
      "0.0.1",
      join(work, plugin.name, "alone"),
    );
    const done = await install(plugin.name, file, target);
    return `${plugin.name} is not published, and installs alone as ${done.outcome}`;
  }
  const bytes = await readBundle(address, listed, fetching);
  const old = join(work, plugin.name, "published");
  await mkdir(old, { recursive: true });
  const oldFile = join(old, listed.bundle);
  await writeFile(oldFile, bytes);
  await install(plugin.name, oldFile, target);
  const next = nextVersion(listed.version);
  const file = await bundle(folder, next, join(work, plugin.name, "next"));
  const done = await install(plugin.name, file, target);
  return `${plugin.name} ${listed.version} installs, then the source at ${next} as ${done.outcome}`;
}
