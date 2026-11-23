/**
 * Builds and publishes a release: the bundle of every plugin at the release's
 * version, each connector's code, the connector host for every platform,
 * `install-host.sh`, `plugins.json` and a checksums file. A release is made
 * from a version tag, `v<version>`, and the same build runs on a laptop.
 *
 *   node --experimental-strip-types scripts/release/release.ts build --version 0.0.13 --out <folder>
 *   node --experimental-strip-types scripts/release/release.ts absent --tag v0.0.13
 *   node --experimental-strip-types scripts/release/release.ts publish --tag v0.0.13 --dir <folder> [--dry-run]
 *
 * `build` needs `marfa` (`scripts/monorepo.sh`, or `MARFA_BIN`). `absent` and
 * `publish` need `gh`, with `GH_TOKEN` and `GH_REPO` set where it has no
 * checkout. A dry run builds or checks everything and publishes nothing.
 * Publishing creates a draft, uploads every asset and then publishes it, so
 * the release is never left without its files and an immutable release can
 * take them.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleConnector } from "../bundle-connectors.ts";
import { checkPlugins } from "../check-plugins.ts";
import { readPin, type Pin } from "../node-pin.ts";
import { writeHostRelease, type ReleaseParts } from "./host-archive.ts";
import {
  compareVersions,
  readPublished,
  type Index as PublishedIndex,
} from "./only-adds.ts";
import { findPlugins, root, runMarfa, type Plugin } from "./plugins.ts";
import { downloadUrl, repository } from "./repository.ts";
import type { Index } from "./only-adds.ts";

export const checksumsFile = "checksums.txt";

export type { ReleaseParts };

export function versionOf(text: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(text)) {
    throw new Error(`${text} is not a version such as 1.2.3`);
  }
  return text;
}

export function versionOfTag(tag: string): string {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`${tag} is not a tag such as v1.2.3`);
  }
  return tag.slice(1);
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** `<sha256>  <name>` for every file of `dir` but the checksums file, as `shasum -c` reads it. */
async function checksumLines(dir: string): Promise<string[]> {
  const lines: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (name === checksumsFile) continue;
    lines.push(`${sha256(await readFile(join(dir, name)))}  ${name}`);
  }
  return lines;
}

/**
 * Checks what `marfa plugins index` wrote against the files beside it: one
 * entry per plugin, each bundle there with the SHA-256 the index lists and the
 * release's version.
 */
async function verifyIndex(
  out: string,
  version: string,
  plugins: readonly Plugin[],
): Promise<void> {
  const index = JSON.parse(
    await readFile(join(out, "plugins.json"), "utf8"),
  ) as Index;
  const listed = index.plugins.map((entry) => entry.name).sort();
  const expected = plugins.map((plugin) => plugin.name).sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    throw new Error(
      `plugins.json lists ${listed.join(", ") || "nothing"}, and the plugins are ${expected.join(", ") || "none"}`,
    );
  }
  for (const entry of index.plugins) {
    const bytes = await readFile(join(out, entry.bundle));
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`plugins.json lists another SHA-256 for ${entry.bundle}`);
    }
    const stamped = (
      JSON.parse(bytes.toString("utf8")) as { version?: unknown }
    ).version;
    if (entry.version !== version || stamped !== version) {
      throw new Error(
        `${entry.bundle} is version ${String(stamped)}, and the release is ${version}`,
      );
    }
  }
}

interface Manifest {
  connector?: Record<string, unknown>;
}

/**
 * Bundles one plugin. A connector's code is built first and named on a copy
 * of the plugin, never on the plugin in the repository.
 */
async function bundlePlugin(
  plugin: Plugin,
  version: string,
  out: string,
  base: string,
  repo: string,
  pin: Pin,
): Promise<void> {
  const source = join(base, plugin.folder);
  const manifestPath = join(source, "plugin.json");
  const before = await readFile(manifestPath);
  const manifest = JSON.parse(before.toString("utf8")) as Manifest;
  let folder = source;
  const temps: string[] = [];
  let failure: unknown;
  try {
    if (manifest.connector !== undefined) {
      const bundled = await bundleConnector(
        plugin.name,
        version,
        out,
        pin,
        base,
      );
      const bytes = await readFile(bundled.file);
      const parent = await mkdtemp(join(tmpdir(), "plugin-release-"));
      temps.push(parent);
      folder = join(parent, "plugin");
      await cp(source, folder, { recursive: true });
      const copyPath = join(folder, "plugin.json");
      const copy = JSON.parse(await readFile(copyPath, "utf8")) as Manifest;
      if (copy.connector === undefined) {
        throw new Error(`${plugin.folder} lost its connector`);
      }
      copy.connector["code"] = {
        url: downloadUrl(repo, version, basename(bundled.file)),
        sha256: sha256(bytes),
        size: bytes.byteLength,
      };
      await writeFile(copyPath, `${JSON.stringify(copy, null, 2)}\n`);
    }
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
        `marfa plugins bundle ${plugin.folder} exited ${String(ran.code)}: ${ran.stdout}${ran.stderr}`.trim(),
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const temp of temps) await rm(temp, { recursive: true, force: true });
  }
  const after = await readFile(manifestPath);
  if (!before.equals(after)) {
    throw new Error(`the build wrote into ${plugin.folder}/plugin.json`, {
      cause: failure,
    });
  }
  if (failure instanceof Error) throw failure;
  if (failure !== undefined)
    throw new Error("the build failed", { cause: failure });
}

/**
 * Builds every plugin of `base` at `version` into the empty folder `out`, and
 * answers the names of the files written. Fails, writing nothing it would
 * publish, when a plugin does not pass its check.
 */
export async function build(
  version: string,
  out: string,
  base: string = root,
  parts: ReleaseParts = {},
): Promise<string[]> {
  versionOf(version);
  const { failures } = await checkPlugins(base);
  if (failures.length > 0) {
    throw new Error(
      `the plugins do not pass their check:\n${failures.join("\n")}`,
    );
  }
  const { plugins } = findPlugins(base);
  if (plugins.length === 0) {
    throw new Error("there is no plugin to release");
  }
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length > 0) {
    throw new Error(`${out} is not empty`);
  }
  const pin = await readPin();
  const repo = repository();
  for (const plugin of plugins) {
    await bundlePlugin(plugin, version, out, base, repo, pin);
  }
  await writeHostRelease(version, out, repo, parts);
  const indexed = await runMarfa(["plugins", "index", out]);
  if (indexed.code !== 0) {
    throw new Error(
      `marfa plugins index exited ${String(indexed.code)}: ${indexed.stdout}${indexed.stderr}`.trim(),
    );
  }
  await verifyIndex(out, version, plugins);
  await writeFile(
    join(out, checksumsFile),
    `${(await checksumLines(out)).join("\n")}\n`,
  );
  return (await readdir(out)).sort();
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function gh(program: string, args: readonly string[]): Promise<Ran> {
  return new Promise((done, fail) => {
    execFile(
      program,
      [...args],
      { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 },
      (error, stdout, stderr) => {
        if (error === null) done({ code: 0, stdout, stderr });
        else if (typeof error.code === "number") {
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

/** What the release of `tag` is: none, a draft, published, or unknown. */
async function releaseState(
  tag: string,
  program: string,
): Promise<"none" | "draft" | "published" | { unknown: string }> {
  const ran = await gh(program, ["release", "view", tag, "--json", "isDraft"]);
  if (ran.code !== 0) {
    return /release not found/i.test(ran.stderr)
      ? "none"
      : {
          unknown: `gh exited ${String(ran.code)}: ${ran.stderr.trim()}`,
        };
  }
  try {
    const { isDraft } = JSON.parse(ran.stdout) as { isDraft?: unknown };
    if (isDraft === true) return "draft";
    if (isDraft === false) return "published";
  } catch {
    // Answered below.
  }
  return { unknown: `gh printed ${ran.stdout.trim()}` };
}

/**
 * Fails when a published release exists for `tag`, or when the release
 * cannot be asked about: nothing is published on a guess. A draft was never
 * public, so it does not block: with `deleteDrafts`, which needs a token that
 * may write, it is deleted, as a run that was stopped halfway leaves one.
 */
export async function assertAbsent(
  tag: string,
  program = "gh",
  options: { deleteDrafts?: boolean } = {},
): Promise<void> {
  versionOfTag(tag);
  for (let tries = 0; tries < 5; tries += 1) {
    const state = await releaseState(tag, program);
    if (state === "none") return;
    if (state === "published") {
      throw new Error(
        `a release for ${tag} exists; it is never overwritten: publish a later tag`,
      );
    }
    if (typeof state === "object") {
      throw new Error(
        `could not ask whether a release for ${tag} exists (${state.unknown})`,
      );
    }
    if (options.deleteDrafts !== true) return;
    const deleted = await gh(program, ["release", "delete", tag, "--yes"]);
    if (deleted.code !== 0) {
      throw new Error(
        `could not delete the draft release for ${tag} (gh exited ${String(deleted.code)}): ${deleted.stderr.trim()}`,
      );
    }
  }
  throw new Error(`drafts for ${tag} are still there after deleting five`);
}

/**
 * After a failed step, deletes the release of `tag` only while it is still
 * a draft, and says what it is now.
 */
async function withdraw(tag: string, program: string): Promise<string> {
  const state = await releaseState(tag, program);
  if (state === "draft") {
    const deleted = await gh(program, ["release", "delete", tag, "--yes"]);
    return deleted.code === 0
      ? `the draft for ${tag} was deleted`
      : `the draft for ${tag} could not be deleted: ${deleted.stderr.trim()}`;
  }
  if (state === "published") {
    return `${tag} is published and was kept: check its assets and that it is marked latest`;
  }
  if (state === "none") return `no release for ${tag} is left`;
  return `${tag} was left as it is, since it could not be read (${state.unknown})`;
}

/**
 * Fails unless `version` is later than every plugin the latest release lists,
 * so a release marked latest never moves an installed plugin back.
 */
export function assertNewer(
  version: string,
  published: PublishedIndex | undefined,
): void {
  for (const entry of published?.plugins ?? []) {
    if (compareVersions(version, entry.version) <= 0) {
      throw new Error(
        `the latest release lists ${entry.name} at ${entry.version}, and ${version} is not later`,
      );
    }
  }
}

/**
 * Publishes the files of `dir` as the release of `tag`, marked latest, after
 * checking that they are the ones `build` wrote (their checksums), that no
 * release exists for the tag, and that the tag is later than the latest
 * release. The release is created as a draft, the assets are uploaded, and
 * only then is it published, so a failed upload leaves nothing published.
 * After a failure the release is deleted only while it is still a draft. A
 * dry run does the checks and creates nothing.
 */
export async function publish(
  tag: string,
  dir: string,
  options: {
    dryRun?: boolean;
    gh?: string;
    published?: () => Promise<PublishedIndex | undefined>;
  } = {},
): Promise<string[]> {
  const version = versionOfTag(tag);
  const files = (await readdir(dir)).sort();
  for (const needed of ["plugins.json", checksumsFile]) {
    if (!files.includes(needed)) throw new Error(`${dir} holds no ${needed}`);
  }
  const written = (await readFile(join(dir, checksumsFile), "utf8"))
    .trim()
    .split("\n");
  const actual = await checksumLines(dir);
  if (JSON.stringify(written) !== JSON.stringify(actual)) {
    throw new Error(
      `the files of ${dir} are not the ones ${checksumsFile} lists`,
    );
  }
  const index = JSON.parse(
    await readFile(join(dir, "plugins.json"), "utf8"),
  ) as Index;
  for (const entry of index.plugins) {
    if (entry.version !== version) {
      throw new Error(
        `${entry.name} is version ${entry.version}, and the tag is ${tag}`,
      );
    }
  }
  const program = options.gh ?? "gh";
  await assertAbsent(tag, program, { deleteDrafts: options.dryRun !== true });
  assertNewer(version, await (options.published ?? readPublished)());
  if (options.dryRun === true) return files;
  const notes = `Plugin bundles at ${version}, each connector's code, the connector host, install-host.sh, plugins.json and ${checksumsFile}.`;
  const created = await gh(program, [
    "release",
    "create",
    tag,
    "--draft",
    "--title",
    tag,
    "--notes",
    notes,
    "--verify-tag",
  ]);
  if (created.code !== 0) {
    throw new Error(
      `gh release create ${tag} exited ${String(created.code)}: ${created.stderr.trim()}; ${await withdraw(tag, program)}`,
    );
  }
  const uploaded = await gh(program, [
    "release",
    "upload",
    tag,
    ...files.map((name) => join(dir, name)),
  ]);
  if (uploaded.code !== 0) {
    throw new Error(
      `gh release upload ${tag} exited ${String(uploaded.code)}: ${uploaded.stderr.trim()}; ${await withdraw(tag, program)}`,
    );
  }
  const edited = await gh(program, [
    "release",
    "edit",
    tag,
    "--draft=false",
    "--latest",
  ]);
  if (edited.code !== 0) {
    throw new Error(
      `gh release edit ${tag} exited ${String(edited.code)}: ${edited.stderr.trim()}; ${await withdraw(tag, program)}`,
    );
  }
  return files;
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function required(name: string): string {
  const value = option(name);
  if (value === undefined) throw new Error(`--${name} names nothing`);
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (command === "build") {
      const files = await build(
        versionOf(required("version")),
        required("out"),
      );
      console.log(`built ${files.join(", ")}`);
    } else if (command === "absent") {
      await assertAbsent(required("tag"));
      console.log(`no published release for ${required("tag")}`);
    } else if (command === "publish") {
      const dryRun = process.argv.includes("--dry-run");
      const files = await publish(required("tag"), required("dir"), { dryRun });
      console.log(
        `${dryRun ? "would publish" : "published"} ${required("tag")}: ${files.join(", ")}`,
      );
    } else {
      throw new Error("usage: release.ts build | absent | publish");
    }
  } catch (error) {
    console.log(
      `FAIL ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
