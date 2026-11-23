import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawnConnector } from "./child.js";
import { CodeStore, type Transport } from "./code.js";
import { readIfThere, writeSecret, writeWhole } from "./files.js";
import type { Home } from "./home.js";
import { parseLink } from "./link.js";
import { holder, takeLock, type Lock } from "./lock.js";
import { CappedLog, hostLog } from "./log.js";
import { hostApi, redeem } from "./marfa.js";
import { updateExit, type Program, type Service } from "./service.js";
import { Supervisor, type HostStatus } from "./supervisor.js";
import {
  currentPointsElsewhere,
  dailyUpdate,
  dayMs,
  hostPlatform,
  installedVersion,
  updatesOff,
  type UpdateOutcome,
} from "./update.js";

/** What `install` keeps of the host's identity. The key is kept apart. */
export interface HostFile {
  origin: string;
  id: string;
  name: string;
}

export function readHost(home: Home): HostFile | undefined {
  const text = readIfThere(home.hostJson);
  if (text === undefined) return undefined;
  const parsed = JSON.parse(text) as Partial<HostFile>;
  if (
    typeof parsed.origin !== "string" ||
    typeof parsed.id !== "string" ||
    typeof parsed.name !== "string"
  )
    throw new Error(`${home.hostJson} is not a host's file`);
  return { origin: parsed.origin, id: parsed.id, name: parsed.name };
}

/** What a command prints, and the code it ends with. */
export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export class Refused extends Error {
  override name = "Refused";
}

/** How long a stopped service's `run` may take to end: its children's grace
 *  and some more. */
const runEndsMs = 75_000;

/** How `install` and `uninstall` wait for a stopped `run` to let the folder
 *  go: a clock that only moves forward, and how long. */
export interface FolderWait {
  monotonic?: () => number;
  ms?: number;
}

/**
 * The `run` that uses the folder, which `service` would stop: refused when a
 * `run` it would not stop uses it, since that one would go on with the old
 * key or write into a folder that was removed.
 */
export function ownRun(
  home: Home,
  service: Service | undefined,
): number | undefined {
  const pid = holder(home.lock);
  if (pid !== undefined && service?.pid() !== pid)
    throw new Refused(
      `Stop the running host first: marfa-connector-host run, process ${String(pid)}, uses ${home.root}.`,
    );
  return pid;
}

/** Takes the folder's run lock, waiting for a stopped `run` to let it go, so
 *  no `run` starts while the folder changes. `then` says what to run once
 *  the `run` that holds it is stopped. */
async function folderLock(
  home: Home,
  wait: FolderWait,
  then: string,
): Promise<Lock> {
  const now = wait.monotonic ?? (() => performance.now());
  const until = now() + (wait.ms ?? runEndsMs);
  for (;;) {
    const taken = takeLock(home.lock);
    if ("lock" in taken) return taken.lock;
    if (now() > until)
      throw new Refused(
        `Stop the running host first: marfa-connector-host run${taken.holder === undefined ? "" : `, process ${String(taken.holder)},`} still uses ${home.root}. Once it has stopped, run ${then}.`,
      );
    await new Promise((done) => setTimeout(done, 200));
  }
}

/** Removes the folders `mkdirSync` made, from `root` up to `made`, where
 *  nothing else was put in them. */
function unmake(root: string, made: string | undefined): void {
  if (made === undefined) return;
  for (let folder = root; ; folder = dirname(folder)) {
    try {
      rmdirSync(folder);
    } catch {
      return;
    }
    if (folder === made || dirname(folder) === folder) return;
  }
}

/**
 * Redeems the link, keeps the host's identity and key, and starts the
 * service. Redeeming ends the old key and gives the new one only in its
 * answer, so the link is redeemed only once this process holds the folder's
 * lock, with the service stopped: a failure before then leaves everything as
 * it was, the link unused. Linking again replaces the identity and forgets
 * every connector's key and code, which the new link made worthless.
 */
export async function install(
  home: Home,
  link: string,
  io: Io,
  service: { service: Service; program: Program } | undefined,
  send: typeof fetch = fetch,
  wait: FolderWait = {},
): Promise<void> {
  const { origin, code } = parseLink(link);
  const running = ownRun(home, service?.service);
  const stopped =
    service !== undefined &&
    (running !== undefined || existsSync(service.service.file));
  if (stopped) service.service.stop();
  const made = mkdirSync(home.root, { recursive: true, mode: 0o700 });
  let lock: Lock | undefined;
  let redeemed: Awaited<ReturnType<typeof redeem>>;
  try {
    lock = await folderLock(
      home,
      wait,
      "marfa-connector-host install again with the same link, which was not used",
    );
    redeemed = await redeem(origin, code, send);
  } catch (error) {
    lock?.release();
    unmake(home.root, made);
    if (stopped)
      try {
        service.service.start();
      } catch (again) {
        io.err(again instanceof Error ? again.message : String(again));
      }
    throw error;
  }
  try {
    const keepUpdatesOff = updatesOff(home.root);
    rmSync(home.connectors, { recursive: true, force: true });
    writeSecret(home.hostKey, redeemed.key);
    const record: HostFile & { updates?: false } = {
      origin,
      id: redeemed.host.id,
      name: redeemed.host.name,
    };
    if (keepUpdatesOff) record.updates = false;
    writeWhole(home.hostJson, `${JSON.stringify(record, null, 2)}\n`);
  } finally {
    lock.release();
  }
  io.out(`Linked as "${redeemed.host.name}" to ${origin}.`);
  io.out(`Files: ${home.root}`);
  if (service === undefined) {
    io.out(
      "No service was installed. Run `marfa-connector-host run` to run the connectors Marfa assigns to this host.",
    );
    return;
  }
  const notes = service.service.install(service.program);
  io.out(`The host runs as a service: ${service.service.file}`);
  for (const line of notes) io.out(line);
}

export interface RunOptions {
  home: Home;
  env: NodeJS.ProcessEnv;
  execPath: string;
  echo?: (line: string) => void;
  /** Answers once the host is asked to stop. */
  stopped: Promise<void>;
  transport?: Transport;
  send?: typeof fetch;
  /** Fetches a release. Marfa is asked with `send`. */
  fetch?: typeof fetch;
  tickMs?: number;
  /** The release this process is, when it was installed as one. */
  version?: string;
  /** The daily check. A release uses `dailyUpdate`. */
  maintain?: (version: string, signal: AbortSignal) => Promise<UpdateOutcome>;
  /** How often `maintain` is started; a day unless a test says otherwise. */
  checkEveryMs?: number;
}

/**
 * Runs every connector Marfa assigns to the host until it is asked to stop,
 * or until Marfa refuses its key. The exit code is `0` either way, so the
 * service does not restart a host that was removed, or `updateExit` when
 * `current` names a newer release, so the service starts that one.
 */
export async function run(options: RunOptions): Promise<number> {
  const { home } = options;
  const host = readHost(home);
  const key = readIfThere(home.hostKey)?.trim();
  if (host === undefined || key === undefined || key === "")
    throw new Refused(
      `This host is not linked yet. Run: marfa-connector-host install '<link>'`,
    );
  const version =
    options.version ?? installedVersion(home.root, import.meta.url);
  // The lock names the release this process runs, so no update prunes it.
  const taken = takeLock(home.lock, Date.now, version);
  if (!("lock" in taken))
    throw new Refused(
      `Another marfa-connector-host run${taken.holder === undefined ? "" : `, process ${String(taken.holder)},`} already uses ${home.root}.`,
    );
  const { lock } = taken;
  const log = hostLog(new CappedLog(home.hostLog), options.echo);
  const logs = new Map<string, CappedLog>();
  const supervisor = new Supervisor({
    api: hostApi(host.origin, key, options.send),
    code: new CodeStore(home, options.transport),
    home,
    spawn: spawnConnector(options.execPath, (plugin) => {
      let file = logs.get(plugin);
      if (file === undefined) {
        file = new CappedLog(home.pluginLog(plugin));
        logs.set(plugin, file);
      }
      return file;
    }),
    log,
    origin: host.origin,
    env: options.env,
  });
  const asked = { stop: false };
  void options.stopped.then(() => {
    asked.stop = true;
  });
  let written = "";
  const writeStatus = (): void => {
    const text = `${JSON.stringify(supervisor.status(), null, 2)}\n`;
    if (text === written) return;
    written = text;
    try {
      writeWhole(home.status, text, 0o600);
    } catch {
      // Status is a convenience, and stops nothing.
    }
  };
  log(
    `running as "${host.name}" for ${host.origin}, process ${String(process.pid)}`,
  );
  const maintain =
    options.maintain ??
    ((running: string, signal: AbortSignal) => {
      const request = {
        root: home.root,
        version: running,
        platform: hostPlatform() ?? `${process.platform}-${process.arch}`,
        env: options.env,
        signal,
      };
      return dailyUpdate(
        options.fetch === undefined
          ? request
          : { ...request, fetch: options.fetch },
      );
    });
  // The check runs beside the loop, which keeps supervising while it
  // downloads; one at a time, stopped when the host stops.
  const checks = new AbortController();
  void options.stopped.then(() => {
    checks.abort();
  });
  let checking: Promise<void> | undefined;
  let updatedTo: string | undefined;
  let nextCheck = performance.now();
  try {
    while (!asked.stop) {
      if (
        version !== undefined &&
        (updatedTo !== undefined || currentPointsElsewhere(home.root, version))
      ) {
        log(
          `${updatedTo === undefined ? "current names another version" : `updated to ${updatedTo}`}, so this one is stopping for it`,
        );
        await supervisor.stop();
        return updateExit;
      }
      if (
        version !== undefined &&
        checking === undefined &&
        performance.now() >= nextCheck
      ) {
        nextCheck = performance.now() + (options.checkEveryMs ?? dayMs);
        checking = maintain(version, checks.signal)
          .then(
            (outcome) => {
              if (outcome.kind === "updated") updatedTo = outcome.version;
            },
            (error: unknown) => {
              if (!checks.signal.aborted)
                log(
                  `could not check for an update: ${error instanceof Error ? error.message : String(error)}`,
                );
            },
          )
          .finally(() => {
            checking = undefined;
          });
      }
      if ((await supervisor.step()) === "unlinked") {
        writeStatus();
        return 0;
      }
      writeStatus();
      await Promise.race([
        options.stopped,
        new Promise((done) => setTimeout(done, options.tickMs ?? 1000)),
      ]);
    }
    log("stopping every connector");
    await supervisor.stop();
    log("stopped");
    return 0;
  } finally {
    checks.abort();
    await checking;
    rmSync(home.status, { force: true });
    lock.release();
  }
}

/**
 * Turns the daily update check on or off in `host.json`, which `run` reads
 * at each check, so the service follows it without a restart.
 */
export function setUpdates(home: Home, on: boolean, io: Io): void {
  const text = readIfThere(home.hostJson);
  if (text === undefined || readHost(home) === undefined)
    throw new Refused(
      `This host is not linked yet. Run: marfa-connector-host install '<link>'`,
    );
  const record = JSON.parse(text) as Record<string, unknown>;
  record["updates"] = on;
  writeWhole(home.hostJson, `${JSON.stringify(record, null, 2)}\n`);
  io.out(
    on
      ? "The daily update check is on."
      : "The daily update check is off. `marfa-connector-host update` still installs a newer release.",
  );
}

function connectorLines(status: HostStatus): string[] {
  if (status.connectors.length === 0)
    return ["No connector is assigned to this host."];
  return status.connectors.flatMap((one) => [
    `${one.plugin} ${one.version}: ${one.state === "running" ? `running${one.pid === undefined ? "" : ` as process ${String(one.pid)}`} since ${one.since ?? "now"}` : one.detail}`,
    ...(one.lastExit === undefined ? [] : [`  last exit: ${one.lastExit}`]),
    ...(one.nextStart === undefined ? [] : [`  next start: ${one.nextStart}`]),
  ]);
}

/** Prints the host and each connector it runs. Never prints a key. */
export function status(home: Home, io: Io, service: Service | undefined): void {
  const host = readHost(home);
  if (host === undefined) {
    io.out(
      `This host is not linked. Run: marfa-connector-host install '<link>'`,
    );
    return;
  }
  io.out(`Host "${host.name}" (${host.id}) for ${host.origin}`);
  io.out(`Files: ${home.root}`);
  const release = installedVersion(home.root, import.meta.url);
  if (release !== undefined) io.out(`Release: ${release}`);
  io.out(`Daily update check: ${updatesOff(home.root) ? "off" : "on"}`);
  if (service !== undefined)
    io.out(
      `Service: ${existsSync(service.file) ? service.file : "not installed"}`,
    );
  const pid = holder(home.lock);
  const text = readIfThere(home.status);
  if (pid === undefined || text === undefined) {
    io.out("Not running.");
    return;
  }
  const current = JSON.parse(text) as HostStatus;
  io.out(`Running as process ${String(pid)}.`);
  io.out(
    current.pollError !== undefined
      ? `Could not reach Marfa: ${current.pollError}`
      : `Last asked Marfa at ${current.polledAt ?? "not yet"}.`,
  );
  for (const line of connectorLines(current)) io.out(line);
}

/** Prints the host's log, or one connector's. */
export function logs(home: Home, plugin: string | undefined, io: Io): void {
  const path = plugin === undefined ? home.hostLog : home.pluginLog(plugin);
  if (!existsSync(path)) {
    io.out(
      plugin === undefined
        ? "The host has written no log yet."
        : `${plugin} has written no log yet.`,
    );
    return;
  }
  io.out(readFileSync(path, "utf8").replace(/\n$/, ""));
}

/** `~/.local/bin/marfa-connector-host`, the command the installer links. */
export function commandLink(userHome: string): string {
  return join(userHome, ".local", "bin", "marfa-connector-host");
}

/** Whether `link` points at a file inside `root`, and not at another install. */
function linkInside(link: string, root: string): boolean {
  let target: string;
  try {
    target = readlinkSync(link);
  } catch {
    return false;
  }
  const resolved = isAbsolute(target) ? target : resolve(dirname(link), target);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return resolved === root || resolved.startsWith(prefix);
}

/**
 * What `uninstall` removes, said before it removes anything: the service,
 * the command when it points at this install, and the host's folder.
 */
export function uninstallPlan(
  home: Home,
  service: Service | undefined,
  userHome = homedir(),
): string[] {
  const command = commandLink(userHome);
  return [
    ...(service !== undefined && existsSync(service.file)
      ? [`the service, ${service.file}`]
      : []),
    ...(linkInside(command, home.root) ? [`the command, ${command}`] : []),
    ...(existsSync(home.root)
      ? [
          `the host's folder, with its key, its connectors' keys, their code and the logs: ${home.root}`,
        ]
      : []),
  ];
}

/** Stops the service, waits for its `run` to let the folder go, and only
 *  then removes the service's file and the folder. */
export async function uninstall(
  home: Home,
  service: Service | undefined,
  wait: FolderWait = {},
  userHome = homedir(),
): Promise<void> {
  ownRun(home, service);
  service?.stop();
  const command = commandLink(userHome);
  if (existsSync(home.root)) {
    const lock = await folderLock(
      home,
      wait,
      "marfa-connector-host uninstall again",
    );
    try {
      service?.remove();
      if (linkInside(command, home.root)) rmSync(command);
      rmSync(home.root, { recursive: true, force: true });
    } finally {
      lock.release();
    }
    return;
  }
  service?.remove();
  if (linkInside(command, home.root)) rmSync(command);
}
