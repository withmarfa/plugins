/**
 * Installs a newer release of the host beside the one that is running, then
 * points `current` at it. A failed download or checksum changes nothing.
 * `run` asks once a day; `update` asks when someone runs it, and still asks
 * when the daily check is off.
 *
 * Every installer stages into a folder of its own in `versions/`, and only
 * the holder of `update.lock` moves a staged copy into place, switches
 * `current` and prunes.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readIfThere, writeWhole } from "./files.js";
import { Home } from "./home.js";
import { alive, heldVersion, holder, takeLock, type Lock } from "./lock.js";

/** Written in by the release build: the repository the release came from. */
declare const MARFA_PLUGINS_REPOSITORY: string | undefined;

/** The repository a released host updates from, or none for a copy built
 *  outside a release. */
export function pluginsRepository(): string | undefined {
  return typeof MARFA_PLUGINS_REPOSITORY === "string"
    ? MARFA_PLUGINS_REPOSITORY
    : undefined;
}

export const hostPlatforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
] as const;

export type HostPlatform = (typeof hostPlatforms)[number];

export const dayMs = 24 * 60 * 60 * 1000;

export const updateLockName = "update.lock";

const checkedName = "update-checked";

const unchanged = "Nothing was changed.";

const semver = /^\d+\.\d+\.\d+$/;

export class UpdateRefused extends Error {
  override name = "UpdateRefused";
}

export type UpdateOutcome =
  { kind: "stay" } | { kind: "updated"; version: string };

/** How long each fetch may take: to its answer's first byte, and whole. */
export interface Deadlines {
  firstByteMs: number;
  totalMs: number;
  archiveTotalMs: number;
}

export const deadlines: Deadlines = {
  firstByteMs: 30_000,
  totalMs: 60_000,
  archiveTotalMs: 10 * 60_000,
};

/** How long an installer waits for another to finish moving its copy in. */
const lockWaitMs = 60_000;

export function hostPlatform(
  platform = process.platform,
  arch = process.arch,
): HostPlatform | undefined {
  const system =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : undefined;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (system === undefined || cpu === undefined) return undefined;
  const name = `${system}-${cpu}`;
  return hostPlatforms.find((known) => known === name);
}

export function hostArchiveName(version: string, platform: string): string {
  return `marfa-connector-host-${version}-${platform}.tar.gz`;
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The release this file is, when it is `<root>/versions/<version>/lib/host.mjs`
 * of this host's own folder; otherwise none.
 */
export function installedVersion(
  root: string,
  moduleUrl: string,
): string | undefined {
  const file = real(fileURLToPath(moduleUrl));
  const versions = real(join(root, "versions"));
  if (file === undefined || versions === undefined) return undefined;
  const lib = dirname(file);
  const folder = dirname(lib);
  const version = basename(folder);
  if (
    basename(file) !== "host.mjs" ||
    basename(lib) !== "lib" ||
    dirname(folder) !== versions ||
    !semver.test(version)
  )
    return undefined;
  return version;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(a[index] ?? 0) - Number(b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The version `current` names, when it is a link at `versions/<version>`. */
export function currentVersion(root: string): string | undefined {
  try {
    const target = readlinkSync(join(root, "current"));
    return /(?:^|\/)versions\/(\d+\.\d+\.\d+)$/.exec(target)?.[1];
  } catch {
    return undefined;
  }
}

/** Whether `current` names a release other than the one this process is. */
export function currentPointsElsewhere(root: string, version: string): boolean {
  const current = currentVersion(root);
  return current !== undefined && current !== version;
}

/**
 * Whether `host.json` turns the daily check off. Anything but `false`,
 * including a file that is not there, leaves it on.
 */
export function updatesOff(root: string): boolean {
  const text = readIfThere(join(root, "host.json"));
  if (text === undefined) return false;
  try {
    return (JSON.parse(text) as { updates?: unknown }).updates === false;
  } catch {
    return false;
  }
}

/**
 * Points `current` at `versions/<version>`: a new link renamed over the old
 * one. `rename` replaces a link and never follows it, where `mv` onto a link
 * to a folder moves into that folder.
 */
function switchCurrent(root: string, version: string): void {
  const next = join(root, `.current-${randomBytes(6).toString("hex")}`);
  symlinkSync(join("versions", version), next);
  try {
    renameSync(next, join(root, "current"));
  } catch (error) {
    rmSync(next, { force: true });
    throw error;
  }
}

/** `.<version>.aside`: an installed copy moved aside while it is replaced. */
const asideName = /^\.(\d+\.\d+\.\d+)\.aside$/;
/** `.<version>.discard`: a copy moved out of the way to be deleted. */
const discardName = /^\.\d+\.\d+\.\d+\.discard$/;
/** `.stage-<pid>-<random>`: the folder one installer stages into. */
const stageName = /^\.stage-(\d+)-/;

/** Deletes `path`; one that will not go is left for the next `recover`. */
function discard(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Its name keeps it out of every release.
  }
}

/**
 * What a stopped installer left, cleared under the update lock. Only a
 * rename puts a tree at `versions/<version>`, so one there is whole: a copy
 * set aside goes when one is there and goes back when none is. A copy to
 * discard goes, and a staging folder goes once the process that made it is
 * gone.
 */
function recover(dir: string): void {
  const names = readdirSync(dir);
  for (const name of names) {
    const aside = asideName.exec(name);
    if (aside?.[1] === undefined) continue;
    const dest = join(dir, aside[1]);
    if (existsSync(dest)) discard(join(dir, name));
    else renameSync(join(dir, name), dest);
  }
  for (const name of names) {
    if (discardName.test(name)) {
      discard(join(dir, name));
      continue;
    }
    const pid = Number(stageName.exec(name)?.[1]);
    if (pid > 0 && pid !== process.pid && !alive(pid)) discard(join(dir, name));
  }
}

/**
 * Deletes every installed release but the two newest, the one `current`
 * names, the ones in `keep` and the one a live `run` holds `run.lock` for.
 * Only finished copies are named `<version>`, so a folder another installer
 * stages into is never touched.
 */
function pruneVersions(root: string, keep: (string | undefined)[]): void {
  const dir = join(root, "versions");
  const names = readdirSync(dir).filter((name) => semver.test(name));
  const kept = new Set<string | undefined>([
    ...[...names]
      .sort((left, right) => compareVersions(right, left))
      .slice(0, 2),
    ...keep,
    currentVersion(root),
    heldVersion(new Home(root).lock),
  ]);
  for (const name of names) {
    if (kept.has(name)) continue;
    // One rename takes the copy out of `versions/<name>`, so a stop part way
    // through the delete never leaves a partial copy there.
    const going = join(dir, `.${name}.discard`);
    discard(going);
    try {
      renameSync(join(dir, name), going);
    } catch {
      continue;
    }
    discard(going);
  }
}

function refuse(message: string): UpdateRefused {
  return new UpdateRefused(
    message.endsWith(unchanged) ? message : `${message} ${unchanged}`,
  );
}

function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Takes `update.lock`, waiting on the monotonic clock while another holds it. */
async function updateLock(
  root: string,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<Lock> {
  const path = join(root, updateLockName);
  const until = performance.now() + waitMs;
  for (;;) {
    if (signal?.aborted === true) throw refuse("The update was stopped.");
    const taken = takeLock(path);
    if ("lock" in taken) return taken.lock;
    if (performance.now() > until) {
      const pid = taken.holder ?? holder(path);
      throw refuse(
        `Another update${pid === undefined ? "" : `, process ${String(pid)},`} is putting a release in place in ${root}.`,
      );
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

interface Placing {
  root: string;
  version: string;
  stage: string;
  /** Keeps this release, which the process runs. */
  running?: string | undefined;
  /** Leaves `current` alone when it already names this release or a later one. */
  onlyNewer?: boolean;
  lockWaitMs?: number;
  signal?: AbortSignal | undefined;
}

/**
 * Moves a finished staged copy to `versions/<version>` and points `current`
 * at it, under the update lock. A copy already there is moved aside first
 * and put back if anything after fails. Each step that changes the tree at
 * `versions/<version>` is one rename, so a stop at any point leaves a whole
 * copy there or none. Answers the release `current` names afterwards.
 */
async function placeRelease(placing: Placing): Promise<string> {
  const { root, version, stage } = placing;
  const dir = join(root, "versions");
  const lock = await updateLock(
    root,
    placing.lockWaitMs ?? lockWaitMs,
    placing.signal,
  );
  try {
    recover(dir);
    const current = currentVersion(root);
    if (
      placing.onlyNewer === true &&
      current !== undefined &&
      existsSync(join(dir, current)) &&
      compareVersions(current, version) >= 0
    ) {
      rmSync(stage, { recursive: true, force: true });
      return current;
    }
    const dest = join(dir, version);
    const aside = join(dir, `.${version}.aside`);
    const had = existsSync(dest);
    if (had) renameSync(dest, aside);
    try {
      renameSync(stage, dest);
    } catch (error) {
      if (had) renameSync(aside, dest);
      throw refuse(`Could not put ${version} in place: ${said(error)}.`);
    }
    try {
      switchCurrent(root, version);
    } catch (error) {
      const failed = join(dir, `.${version}.discard`);
      renameSync(dest, failed);
      if (had) renameSync(aside, dest);
      discard(failed);
      throw refuse(`Could not switch to ${version}: ${said(error)}.`);
    }
    if (had) discard(aside);
    pruneVersions(root, [placing.running, version]);
    return version;
  } finally {
    lock.release();
  }
}

/** The parts of a release a staged copy must hold. */
const releaseFiles = ["bin/marfa-connector-host", "lib/node", "lib/host.mjs"];

function assertWhole(stage: string, what: string): void {
  for (const relative of releaseFiles)
    if (!existsSync(join(stage, relative)))
      throw refuse(`${what} has no ${relative}.`);
}

/**
 * What `install-host.sh` runs from the copy it staged: puts that copy in
 * place as `version` and points `current` at it. The copy must be staged in
 * this host's own `versions/` folder.
 */
export async function activateRelease(
  root: string,
  version: string,
  moduleUrl: string,
  wait: number = lockWaitMs,
): Promise<void> {
  if (!semver.test(version)) throw refuse(`${version} is not a version.`);
  const file = real(fileURLToPath(moduleUrl));
  const versions = real(join(root, "versions"));
  const stage = file === undefined ? undefined : dirname(dirname(file));
  if (
    stage === undefined ||
    versions === undefined ||
    dirname(stage) !== versions ||
    !stageName.test(basename(stage))
  )
    throw refuse(
      `This copy is not staged in ${join(root, "versions")}, so it cannot put itself in place.`,
    );
  assertWhole(stage, "The staged copy");
  await placeRelease({ root, version, stage, lockWaitMs: wait });
}

/** `url` fetched within its deadlines, or a refusal saying why not. */
async function fetchWithin(
  url: string,
  get: typeof fetch,
  signal: AbortSignal,
  firstByteMs: number,
  totalMs: number,
): Promise<{ url: string; bytes?: Buffer }> {
  const first = new AbortController();
  const total = AbortSignal.timeout(totalMs);
  const timer = setTimeout(() => {
    first.abort();
  }, firstByteMs);
  const all = AbortSignal.any([signal, total, first.signal]);
  try {
    const response = await get(url, { signal: all });
    clearTimeout(timer);
    if (!response.ok) {
      await response.body?.cancel();
      throw refuse(`${url} answered ${String(response.status)}.`);
    }
    return {
      url: response.url,
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  } catch (error) {
    if (error instanceof UpdateRefused) throw error;
    if (signal.aborted) throw refuse("The update was stopped.");
    if (first.signal.aborted)
      throw refuse(
        `${url} did not answer within ${String(firstByteMs / 1000)} seconds.`,
      );
    if (total.aborted)
      throw refuse(
        `${url} took longer than ${String(totalMs / 1000)} seconds.`,
      );
    throw refuse(said(error));
  } finally {
    clearTimeout(timer);
  }
}

async function untar(
  archive: string,
  into: string,
  signal: AbortSignal,
): Promise<void> {
  await promisify(execFile)(
    "tar",
    ["-xzf", archive, "-C", into, "--strip-components=1"],
    { signal },
  );
}

export interface UpdateRequest {
  root: string;
  version: string;
  platform: string;
  repository?: string | undefined;
  origin?: string;
  fetch?: typeof fetch;
  /** Stops every fetch and the unpacking, changing nothing. */
  signal?: AbortSignal;
  deadlines?: Partial<Deadlines>;
  lockWaitMs?: number;
}

/**
 * Downloads the newest release when it is newer than `version`, checks it,
 * stages it in a folder of its own and puts it in place.
 */
export async function updateRelease(
  request: UpdateRequest,
): Promise<UpdateOutcome> {
  if (!hostPlatforms.some((known) => known === request.platform)) {
    throw refuse(
      `This system (${request.platform}) has no connector host build.`,
    );
  }
  const repo = request.repository ?? pluginsRepository();
  if (repo === undefined)
    throw refuse("This copy was not built by a release, so it cannot update.");
  const origin = request.origin ?? "https://github.com";
  const get = request.fetch ?? fetch;
  const signal = request.signal ?? new AbortController().signal;
  const limits = { ...deadlines, ...request.deadlines };
  const latest = await fetchWithin(
    `${origin}/${repo}/releases/latest`,
    get,
    signal,
    limits.firstByteMs,
    limits.totalMs,
  );
  let newest: string;
  try {
    const named = /\/releases\/tag\/v(\d+\.\d+\.\d+)\/?$/.exec(
      new URL(latest.url).pathname,
    )?.[1];
    if (named === undefined) throw new Error("no version");
    newest = named;
  } catch {
    throw refuse(`The latest release did not name a version (${latest.url}).`);
  }
  if (compareVersions(newest, request.version) <= 0) return { kind: "stay" };
  const name = hostArchiveName(newest, request.platform);
  const base = `${origin}/${repo}/releases/download/v${newest}`;
  const archive = await fetchWithin(
    `${base}/${name}`,
    get,
    signal,
    limits.firstByteMs,
    limits.archiveTotalMs,
  );
  const checksums = await fetchWithin(
    `${base}/checksums.txt`,
    get,
    signal,
    limits.firstByteMs,
    limits.totalMs,
  );
  const wanted = listedChecksum(checksums.bytes?.toString("utf8") ?? "", name);
  const bytes = archive.bytes ?? Buffer.alloc(0);
  if (
    wanted === undefined ||
    createHash("sha256").update(bytes).digest("hex") !== wanted
  ) {
    throw refuse(`The checksum of ${name} does not match.`);
  }
  const dir = join(request.root, "versions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(tmpdir(), "host-update-"));
  const stage = await mkdtemp(join(dir, `.stage-${String(process.pid)}-`));
  try {
    const archivePath = join(scratch, name);
    await writeFile(archivePath, bytes);
    try {
      await untar(archivePath, stage, signal);
    } catch (error) {
      if (signal.aborted) throw refuse("The update was stopped.");
      throw refuse(`Could not unpack ${name}: ${said(error)}.`);
    }
    assertWhole(stage, "The archive");
    if (signal.aborted) throw refuse("The update was stopped.");
    const current = await placeRelease({
      root: request.root,
      version: newest,
      stage,
      running: request.version,
      onlyNewer: true,
      signal,
      ...(request.lockWaitMs === undefined
        ? {}
        : { lockWaitMs: request.lockWaitMs }),
    });
    return current === request.version
      ? { kind: "stay" }
      : { kind: "updated", version: current };
  } catch (error) {
    if (error instanceof UpdateRefused) throw error;
    throw refuse(said(error));
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function listedChecksum(text: string, name: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (match?.[2] === name) return match[1];
  }
  return undefined;
}

export interface DailyRequest extends UpdateRequest {
  env: NodeJS.ProcessEnv;
  now?: number;
}

/**
 * The check `run` makes: nothing, when it is turned off or it has already
 * happened today, and otherwise the same install `update` makes. A failure
 * leaves no record, so the next process tries again.
 */
export async function dailyUpdate(
  request: DailyRequest,
): Promise<UpdateOutcome> {
  if (
    request.env["MARFA_CONNECTOR_HOST_NO_UPDATE"] === "1" ||
    updatesOff(request.root)
  ) {
    return { kind: "stay" };
  }
  const now = request.now ?? Date.now();
  const stamp = join(request.root, checkedName);
  const recorded = Number(readIfThere(stamp)?.trim());
  if (Number.isFinite(recorded) && now - recorded < dayMs) {
    return { kind: "stay" };
  }
  const outcome = await updateRelease(request);
  writeWhole(stamp, `${String(now)}\n`);
  return outcome;
}
