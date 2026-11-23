import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnConnector } from "./child.js";
import { CodeStore, type Transport } from "./code.js";
import { readIfThere, writeSecret, writeWhole } from "./files.js";
import type { Home } from "./home.js";
import { parseLink } from "./link.js";
import { holder, takeLock, type Lock } from "./lock.js";
import { CappedLog, hostLog } from "./log.js";
import { hostApi, redeem } from "./marfa.js";
import type { Program, Service } from "./service.js";
import { Supervisor, type HostStatus } from "./supervisor.js";

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

/**
 * The `run` that uses the folder, which `service` would stop: refused when a
 * `run` it would not stop uses it, since that one would go on with the old
 * key or write into a folder that was removed.
 */
function ownRun(home: Home, service: Service | undefined): number | undefined {
  const pid = holder(home.lock);
  if (pid !== undefined && service?.pid() !== pid)
    throw new Refused(
      `Stop the running host first: marfa-connector-host run, process ${String(pid)}, uses ${home.root}.`,
    );
  return pid;
}

/** Takes the folder's run lock, waiting for a stopped `run` to let it go,
 *  so no `run` starts while the folder changes. */
async function folderLock(home: Home): Promise<Lock> {
  const until = Date.now() + runEndsMs;
  for (;;) {
    const taken = takeLock(home.lock);
    if ("lock" in taken) return taken.lock;
    if (Date.now() > until)
      throw new Refused(
        `Stop the running host first: marfa-connector-host run${taken.holder === undefined ? "" : `, process ${String(taken.holder)},`} still uses ${home.root}.`,
      );
    await new Promise((done) => setTimeout(done, 200));
  }
}

/**
 * Redeems the link, keeps the host's identity and key, and starts the
 * service. Nothing is written until Marfa took the link. Linking again
 * replaces the identity and forgets every connector's key and code, which the
 * new link made worthless.
 */
export async function install(
  home: Home,
  link: string,
  io: Io,
  service: { service: Service; program: Program } | undefined,
  send: typeof fetch = fetch,
): Promise<void> {
  const { origin, code } = parseLink(link);
  const running = ownRun(home, service?.service);
  const redeemed = await redeem(origin, code, send);
  if (running !== undefined) service?.service.stop();
  const lock = await folderLock(home);
  try {
    rmSync(home.connectors, { recursive: true, force: true });
    writeSecret(home.hostKey, redeemed.key);
    writeWhole(
      home.hostJson,
      `${JSON.stringify(
        {
          origin,
          id: redeemed.host.id,
          name: redeemed.host.name,
        } satisfies HostFile,
        null,
        2,
      )}\n`,
    );
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
  tickMs?: number;
}

/**
 * Runs every connector Marfa assigns to the host until it is asked to stop,
 * or until Marfa refuses its key, and answers the exit code: `0` either way,
 * so the service does not restart a host that was removed.
 */
export async function run(options: RunOptions): Promise<number> {
  const { home } = options;
  const host = readHost(home);
  const key = readIfThere(home.hostKey)?.trim();
  if (host === undefined || key === undefined || key === "")
    throw new Refused(
      `This host is not linked yet. Run: marfa-connector-host install '<link>'`,
    );
  const taken = takeLock(home.lock);
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
  try {
    while (!asked.stop) {
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
    rmSync(home.status, { force: true });
    lock.release();
  }
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

/**
 * What `uninstall` removes, said before it removes anything: the service
 * and the host's folder, keys and logs included.
 */
export function uninstallPlan(
  home: Home,
  service: Service | undefined,
): string[] {
  return [
    ...(service !== undefined && existsSync(service.file)
      ? [`the service, ${service.file}`]
      : []),
    ...(existsSync(home.root)
      ? [
          `the host's folder, with its key, its connectors' keys, their code and the logs: ${home.root}`,
        ]
      : []),
  ];
}

export async function uninstall(
  home: Home,
  service: Service | undefined,
): Promise<void> {
  ownRun(home, service);
  service?.remove();
  if (!existsSync(home.root)) return;
  const lock = await folderLock(home);
  try {
    rmSync(home.root, { recursive: true, force: true });
  } finally {
    lock.release();
  }
}
