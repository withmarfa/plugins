/**
 * Installs a newer release of the host beside the one that is running, then
 * points `current` at it. A failed download or checksum changes nothing.
 * `run` asks once a day; `update` asks when someone runs it, and still asks
 * when the daily check is off.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readIfThere, writeWhole } from "./files.js";

/** The repository a released host updates from. The release build names the same one. */
export const pluginsRepository = "withmarfa/plugins";

export const hostPlatforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
] as const;

export type HostPlatform = (typeof hostPlatforms)[number];

export const dayMs = 24 * 60 * 60 * 1000;

const checkedName = "update-checked";

const unchanged = "Nothing was changed.";

export class UpdateRefused extends Error {
  override name = "UpdateRefused";
}

export type UpdateOutcome =
  { kind: "stay" } | { kind: "updated"; version: string };

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

/** The release this file was installed as, from a `versions/<version>/` path. */
export function runningVersion(moduleUrl: string): string | undefined {
  try {
    const path = realpathSync(fileURLToPath(moduleUrl));
    return /\/versions\/(\d+\.\d+\.\d+)(?:\/|$)/.exec(path)?.[1];
  } catch {
    return undefined;
  }
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
 * Points `current` at `versions/<version>`. A rename replaces the old
 * symlink. `mv` on macOS follows a symlink to a directory and would put the
 * new link inside the old version.
 */
export function switchCurrent(root: string, version: string): void {
  const next = join(root, "current.next");
  rmSync(next, { force: true });
  symlinkSync(join("versions", version), next);
  renameSync(next, join(root, "current"));
}

/**
 * Deletes every installed release but the two newest, the one that is
 * running and the one `current` names. The process is still executing its
 * own copy, so that copy stays even when it is older than those two.
 */
export function pruneVersions(root: string, running: string): void {
  const dir = join(root, "versions");
  if (!existsSync(dir)) return;
  const names = readdirSync(dir).filter((name) => /^\d+\.\d+\.\d+$/.test(name));
  const keep = new Set(
    [...names].sort((left, right) => compareVersions(right, left)).slice(0, 2),
  );
  keep.add(running);
  const current = currentVersion(root);
  if (current !== undefined) keep.add(current);
  for (const name of names) {
    if (!keep.has(name))
      rmSync(join(dir, name), { recursive: true, force: true });
  }
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".partial") || name.endsWith(".previous")) {
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
}

export function listedChecksum(text: string, name: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (match?.[2] === name) return match[1];
  }
  return undefined;
}

function refuse(message: string): UpdateRefused {
  return new UpdateRefused(
    message.endsWith(unchanged) ? message : `${message} ${unchanged}`,
  );
}

async function take(url: string, get: typeof fetch): Promise<Buffer> {
  const response = await get(url);
  if (!response.ok) {
    throw refuse(`${url} answered ${String(response.status)}.`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export interface UpdateRequest {
  root: string;
  version: string;
  platform: string;
  repository?: string;
  origin?: string;
  fetch?: typeof fetch;
}

/**
 * Downloads the newest release when it is newer than `version`, checks it,
 * unpacks it beside the one that is running and points `current` at it.
 */
export async function updateRelease(
  request: UpdateRequest,
): Promise<UpdateOutcome> {
  if (!hostPlatforms.some((known) => known === request.platform)) {
    throw refuse(
      `This system (${request.platform}) has no connector host build.`,
    );
  }
  const repo = request.repository ?? pluginsRepository;
  const origin = request.origin ?? "https://github.com";
  const get = request.fetch ?? fetch;
  let newest: string;
  try {
    const latest = await get(`${origin}/${repo}/releases/latest`);
    if (!latest.ok) {
      throw refuse(
        `${origin}/${repo}/releases/latest answered ${String(latest.status)}.`,
      );
    }
    const found = /\/releases\/tag\/v(\d+\.\d+\.\d+)\/?$/.exec(
      new URL(latest.url).pathname,
    );
    const named = found?.[1];
    if (named === undefined) {
      throw refuse(
        `The latest release did not name a version (${latest.url}).`,
      );
    }
    newest = named;
  } catch (error) {
    if (error instanceof UpdateRefused) throw error;
    throw refuse(error instanceof Error ? error.message : String(error));
  }
  if (compareVersions(newest, request.version) <= 0) return { kind: "stay" };
  const name = hostArchiveName(newest, request.platform);
  const base = `${origin}/${repo}/releases/download/v${newest}`;
  const scratch = await mkdtemp(join(tmpdir(), "host-update-"));
  const partial = join(request.root, "versions", `${newest}.partial`);
  try {
    const archive = await take(`${base}/${name}`, get);
    const checksums = await take(`${base}/checksums.txt`, get);
    const wanted = listedChecksum(checksums.toString("utf8"), name);
    const digest = createHash("sha256").update(archive).digest("hex");
    if (wanted === undefined || digest !== wanted) {
      throw refuse(`The checksum of ${name} does not match.`);
    }
    const archivePath = join(scratch, name);
    await writeFile(archivePath, archive);
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    try {
      execFileSync(
        "tar",
        ["-xzf", archivePath, "-C", partial, "--strip-components=1"],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (error) {
      throw refuse(
        `Could not unpack ${name}: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    for (const relative of [
      "bin/marfa-connector-host",
      "lib/node",
      "lib/host.mjs",
    ]) {
      if (!existsSync(join(partial, relative))) {
        throw refuse(`The archive has no ${relative}.`);
      }
    }
    const dest = join(request.root, "versions", newest);
    const backup = `${dest}.previous`;
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(dest)) renameSync(dest, backup);
    renameSync(partial, dest);
    try {
      switchCurrent(request.root, newest);
    } catch (error) {
      rmSync(dest, { recursive: true, force: true });
      if (existsSync(backup)) renameSync(backup, dest);
      throw refuse(
        `Could not switch to ${newest}: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    rmSync(join(request.root, "current.next"), { force: true });
    if (error instanceof UpdateRefused) throw error;
    throw refuse(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  pruneVersions(request.root, request.version);
  return { kind: "updated", version: newest };
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
