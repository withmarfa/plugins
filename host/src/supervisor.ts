import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  childEnvironment,
  wakeSignal,
  type Child,
  type Exit,
  type Spawn,
} from "./child.js";
import { CodeRefused, type CodeStore } from "./code.js";
import { readIfThere, writeSecret, writeWhole } from "./files.js";
import { safePluginName, type Home } from "./home.js";
import type { Log } from "./log.js";
import type { Assigned, Code, HostApi } from "./marfa.js";

const second = 1000;
const minute = 60 * second;

/** How often the host asks Marfa what it runs. */
export const pollMs = minute;

/** The first wait after a failed poll, which doubles up to five minutes. */
const pollRetryMs = 10 * second;
const longestPollRetryMs = 5 * minute;

/** The first wait before a crashed connector starts again, which doubles up
 *  to five minutes, and how long it must run for the count to start over. */
const restartMs = 5 * second;
const longestRestartMs = 5 * minute;
const healthyMs = 10 * minute;

/** How long a connector that exited `4` waits before it tries again with no
 *  sign from Marfa, which says nothing when its settings change. */
const settingsRetryMs = 30 * minute;

/** The first wait after a fetch of code failed, which doubles up to an hour. */
const codeRetryMs = minute;
const longestCodeRetryMs = 60 * minute;

/** How far the wall clock may part from the monotonic clock between two
 *  looks before the host takes it as sleep or a clock that was set. */
const jumpMs = 30 * second;

/** How long after its start a connector is not signalled: until the kit
 *  listens for the wake signal, the signal ends the process. A run asked for
 *  then is still run, since the kit reads the request as its first run
 *  starts. */
const settlingMs = 5 * second;

/** How long a connector has to stop after `SIGTERM` before `SIGKILL`. */
export const stopGraceMs = 30 * second;

/** The longest error a run report takes. */
const reportCap = 2000;

function doubling(first: number, longest: number, count: number): number {
  return Math.min(first * 2 ** Math.max(0, Math.min(count - 1, 20)), longest);
}

function duration(ms: number): string {
  if (ms < minute) return `${String(Math.round(ms / second))} s`;
  return `${String(Math.round(ms / minute))} min`;
}

const exitMeaning: Record<number, string> = {
  1: "it failed",
  2: "its code or command line is wrong",
  3: "Marfa or the kit refused its key",
  4: "a setting is missing or not one it can use",
};

/** The types a connector brings in and takes no edits back for, which the
 *  kit registers as read only: those of its `in` kinds. */
function readOnlyTypes(entry: Assigned): string[] {
  return [
    ...new Set(
      entry.connector.kinds
        .filter((kind) => kind.direction === "in")
        .map((kind) => kind.type),
    ),
  ];
}

function describeExit(exit: Exit): string {
  if (exit.signal !== null) return `was ended by ${exit.signal}`;
  if (exit.code === null) return "could not be started";
  const meaning = exitMeaning[exit.code];
  return `exited ${String(exit.code)}${meaning === undefined ? "" : ` (${meaning})`}`;
}

/** Why a connector that has stopped does not start again. */
type Hold =
  /** Exit 2: until Marfa holds another version, bundle or code. */
  | {
      kind: "definition";
      version: string;
      fingerprint: string;
      sha256: string;
    }
  /** Exit 3 after a key minted for an exit 3: until Marfa holds another
   *  version or bundle, or the key it answers for changes. */
  | {
      kind: "key";
      version: string;
      fingerprint: string;
      keyMinted: boolean;
    }
  /** Exit 4: until the owner asks for a run, the version changes, or the
   *  wait is over. */
  | { kind: "settings"; version: string; until: number };

// Every wait below is timed on the monotonic clock, which no setting of the
// wall clock moves; the wall clock only dates what `status` shows.

interface Running {
  child: Child;
  version: string;
  sha256: string;
  startedAt: number;
  /** The wall clock at the start, for `status`. */
  startedOn: number;
  stopping: boolean;
}

interface Slot {
  plugin: string;
  entry: Assigned;
  /** When the poll that gave `entry` was answered. */
  seenAt: number;
  removed: boolean;
  running?: Running | undefined;
  hold?: Hold | undefined;
  restartAt?: number | undefined;
  crashes: number;
  /** The wall clock at the last exit, for `status`. */
  lastExit?: (Exit & { on: number }) | undefined;
  /** The next start mints, since the last child exited `3`. */
  mintFor3: boolean;
  /** The key on disk was minted because a child exited `3`. */
  mintedFor3: boolean;
  /** The run request the host last acted on. */
  actedRequest?: string | undefined;
  codeFailures: number;
  codeRetryAt?: number | undefined;
  codeError?: string | undefined;
  /** The version whose missing code the log already named. */
  noCodeVersion?: string | undefined;
  /** A non-zero exit not yet weighed against `registration_id`. */
  pending?:
    (Exit & { at: number; on: number; line: string | undefined }) | undefined;
  /** The last failure the host reported for the connector. */
  reported?: string | undefined;
  busy: boolean;
  again: boolean;
  work: Promise<void>;
}

export interface ConnectorStatus {
  plugin: string;
  version: string;
  state: "running" | "stopped";
  /** Why it is not running, or what it is doing. */
  detail: string;
  pid?: number;
  since?: string;
  lastExit?: string;
  nextStart?: string;
}

export interface HostStatus {
  pid: number;
  polledAt?: string;
  pollError?: string;
  connectors: ConnectorStatus[];
}

export interface SupervisorOptions {
  api: HostApi;
  code: CodeStore;
  home: Home;
  spawn: Spawn;
  log: Log;
  origin: string;
  /** The host's own environment, which a connector's is drawn from. */
  env: NodeJS.ProcessEnv;
  /** The wall clock. */
  now?: () => number;
  /** A clock in milliseconds that only moves forward, at the pace of time
   *  awake. */
  monotonic?: () => number;
  pollMs?: number;
  stopGraceMs?: number;
}

/**
 * Runs each connector `GET /connector-hosts/self` assigns to this host as a
 * process of its own, on a key minted for it, and follows what Marfa and the
 * process's exit code say. Each connector's work is done one step at a time,
 * so a slow fetch or stop for one holds up no other.
 */
export class Supervisor {
  private readonly slots = new Map<string, Slot>();
  private readonly wall: () => number;
  private readonly now: () => number;
  private readonly pollEvery: number;
  private readonly grace: number;
  private nextPollAt = 0;
  private pollFailures = 0;
  private lastStep: { wall: number; monotonic: number } | undefined;
  /** The wall clock at the last answer, for `status`. */
  private polledAt: number | undefined;
  private pollError: string | undefined;
  private firstPoll = true;
  private stopping = false;
  private unlinked = false;
  private readonly skipped = new Set<string>();

  constructor(private readonly options: SupervisorOptions) {
    this.wall = options.now ?? Date.now;
    this.now = options.monotonic ?? (() => performance.now());
    this.pollEvery = options.pollMs ?? pollMs;
    this.grace = options.stopGraceMs ?? stopGraceMs;
  }

  private log(line: string): void {
    this.options.log(line);
  }

  /**
   * One turn of the loop: notices a jump of the wall clock either way, as
   * after sleep or when the clock is set, polls when due, and moves each
   * connector on. Answers `unlinked` once Marfa refused the host's key and
   * every connector is stopped.
   */
  async step(): Promise<"running" | "unlinked"> {
    if (this.unlinked) return "unlinked";
    const now = this.now();
    const wall = this.wall();
    if (this.lastStep !== undefined) {
      const parted =
        wall - this.lastStep.wall - (now - this.lastStep.monotonic);
      if (Math.abs(parted) > jumpMs) {
        this.log(
          `the clock moved ${parted < 0 ? "back " : ""}${duration(Math.abs(parted))} more than time passed, as after sleep or when it is set: asking Marfa now and waking every connector`,
        );
        for (const slot of this.slots.values()) this.wake(slot, now);
        this.nextPollAt = now;
      }
    }
    this.lastStep = { wall, monotonic: now };
    if (now >= this.nextPollAt && !this.stopping) {
      if ((await this.poll()) === "unlinked") return "unlinked";
    }
    for (const slot of this.slots.values()) this.kick(slot);
    return "running";
  }

  /** Waits until no connector has work under way. */
  async settled(): Promise<void> {
    for (;;) {
      const busy = [...this.slots.values()].filter((slot) => slot.busy);
      if (busy.length === 0) return;
      await Promise.all(busy.map((slot) => slot.work));
    }
  }

  private async poll(): Promise<"ok" | "unlinked"> {
    const answer = await this.options.api.self();
    const now = this.now();
    const wall = this.wall();
    if (answer.kind === "unlinked") {
      await this.unlink();
      return "unlinked";
    }
    if (answer.kind === "failed") {
      this.pollFailures += 1;
      const wait = doubling(pollRetryMs, longestPollRetryMs, this.pollFailures);
      this.nextPollAt = now + wait;
      this.pollError = answer.reason;
      this.log(
        `could not ask Marfa what this host runs (${answer.reason}); the connectors keep running, and the host asks again in ${duration(wait)}`,
      );
      return "ok";
    }
    this.pollFailures = 0;
    this.pollError = undefined;
    this.polledAt = wall;
    this.nextPollAt = now + this.pollEvery;
    const seen = new Set<string>();
    for (const entry of answer.self.connectors) {
      if (!safePluginName(entry.plugin)) {
        if (!this.skipped.has(entry.plugin))
          this.log(
            `skipping ${JSON.stringify(entry.plugin)}, which is not a plugin's name`,
          );
        this.skipped.add(entry.plugin);
        continue;
      }
      seen.add(entry.plugin);
      const slot = this.slots.get(entry.plugin);
      if (slot === undefined) {
        this.slots.set(entry.plugin, {
          plugin: entry.plugin,
          entry,
          seenAt: now,
          removed: false,
          crashes: 0,
          mintFor3: false,
          mintedFor3: false,
          codeFailures: 0,
          busy: false,
          again: false,
          work: Promise.resolve(),
        });
      } else {
        slot.entry = entry;
        slot.seenAt = now;
        slot.removed = false;
      }
    }
    for (const slot of this.slots.values())
      if (!seen.has(slot.plugin)) slot.removed = true;
    if (this.firstPoll) {
      this.firstPoll = false;
      await this.forgetUnassigned(seen);
    }
    return "ok";
  }

  /** Deletes the folder of each connector this host holds files for and
   *  Marfa no longer assigns to it. */
  private async forgetUnassigned(seen: ReadonlySet<string>): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.options.home.connectors);
    } catch {
      return;
    }
    for (const name of names) {
      if (seen.has(name)) continue;
      await rm(join(this.options.home.connectors, name), {
        recursive: true,
        force: true,
      });
      this.log(
        `${name}: deleted its key and code, since it is no longer assigned to this host`,
      );
    }
  }

  private async unlink(): Promise<void> {
    this.unlinked = true;
    this.log(
      "Marfa refused this host's key: the host was removed, or linked again on another machine. Its connectors are stopped and their keys and code deleted. To run connectors here again, install with a new link: marfa-connector-host install '<link>'",
    );
    await this.stop();
    await rm(this.options.home.connectors, { recursive: true, force: true });
  }

  /** Stops every connector: `SIGTERM`, then `SIGKILL` for any still running
   *  after the grace period. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(
      [...this.slots.values()].map((slot) =>
        this.stopChild(slot, "the host is stopping"),
      ),
    );
  }

  private kick(slot: Slot): void {
    if (slot.busy) {
      slot.again = true;
      return;
    }
    slot.busy = true;
    slot.work = (async () => {
      try {
        // `kick` sets `again` while `drive` runs.
        const asked = (): boolean => slot.again;
        do {
          slot.again = false;
          await this.drive(slot);
        } while (asked());
      } catch (error) {
        this.log(
          `${slot.plugin}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        slot.busy = false;
      }
    })();
  }

  /** Moves one connector towards what Marfa says it should be. */
  private async drive(slot: Slot): Promise<void> {
    if (this.stopping) return;
    const { plugin } = slot;
    if (slot.removed) {
      await this.stopChild(slot, "it is no longer assigned to this host");
      this.slots.delete(plugin);
      await rm(this.options.home.connector(plugin), {
        recursive: true,
        force: true,
      });
      this.log(
        `${plugin}: deleted its key and code, since it is no longer assigned to this host`,
      );
      return;
    }
    await this.reportPending(slot);
    const entry = slot.entry;
    const now = this.now();
    const code = entry.connector.code;
    if (code === undefined) {
      await this.stopChild(slot, `version ${entry.version} carries no code`);
      await this.options.code.prune(plugin, undefined);
      if (slot.noCodeVersion !== entry.version) {
        slot.noCodeVersion = entry.version;
        this.log(
          `${plugin} ${entry.version}: its plugin carries no code, so nothing runs`,
        );
      }
      return;
    }
    if (entry.paused) {
      await this.stopChild(slot, "the owner paused it");
      return;
    }
    const request = entry.run_requested_at;
    const asked = request !== null && request !== slot.actedRequest;
    if (slot.hold !== undefined) {
      if (!this.lifted(slot.hold, entry, code, now, asked)) return;
      if (slot.hold.kind === "key") slot.mintedFor3 = false;
      this.log(`${plugin}: what held it back changed, so it starts again`);
      slot.hold = undefined;
      slot.restartAt = undefined;
    }
    const running = slot.running;
    if (running !== undefined) {
      if (running.stopping) return;
      const current =
        running.sha256 === code.sha256 && running.version === entry.version;
      const waiting =
        !current && slot.codeRetryAt !== undefined && now < slot.codeRetryAt;
      if (current || waiting) {
        if (asked) {
          slot.actedRequest = request;
          if (this.wake(slot, now))
            this.log(`${plugin}: the owner asked for a run, so it was woken`);
        }
        return;
      }
      const file = await this.fetchCode(slot, code);
      if (file === undefined) {
        if (asked && slot.running === running) {
          slot.actedRequest = request;
          if (this.wake(slot, this.now()))
            this.log(`${plugin}: the owner asked for a run, so it was woken`);
        }
        return;
      }
      await this.stopChild(
        slot,
        `version ${entry.version} replaces ${running.version}`,
      );
      slot.crashes = 0;
      slot.restartAt = undefined;
      await this.start(slot, file, code, request);
      return;
    }
    if (asked && slot.restartAt !== undefined) {
      this.log(`${plugin}: the owner asked for a run, so it starts now`);
      slot.restartAt = undefined;
    }
    if (slot.restartAt !== undefined && now < slot.restartAt) return;
    if (slot.codeRetryAt !== undefined && now < slot.codeRetryAt) return;
    const file = await this.fetchCode(slot, code);
    if (file === undefined) return;
    await this.start(slot, file, code, request);
  }

  /**
   * Sends the wake signal to a running connector past its first moments, and
   * answers whether it was sent or the connector will read the request as
   * its first run starts.
   */
  private wake(slot: Slot, now: number): boolean {
    const running = slot.running;
    if (running === undefined || running.stopping) return false;
    if (now - running.startedAt >= settlingMs) running.child.signal(wakeSignal);
    return true;
  }

  private lifted(
    hold: Hold,
    entry: Assigned,
    code: Code,
    now: number,
    asked: boolean,
  ): boolean {
    switch (hold.kind) {
      case "definition":
        return (
          entry.version !== hold.version ||
          entry.fingerprint !== hold.fingerprint ||
          code.sha256 !== hold.sha256
        );
      case "key":
        return (
          entry.version !== hold.version ||
          entry.fingerprint !== hold.fingerprint ||
          entry.key_minted !== hold.keyMinted
        );
      case "settings":
        return asked || entry.version !== hold.version || now >= hold.until;
    }
  }

  private async fetchCode(slot: Slot, code: Code): Promise<string | undefined> {
    try {
      const file = await this.options.code.ensure(slot.plugin, code);
      slot.codeFailures = 0;
      slot.codeRetryAt = undefined;
      slot.codeError = undefined;
      return file;
    } catch (error) {
      const message =
        error instanceof CodeRefused
          ? error.message
          : `could not keep its code: ${error instanceof Error ? error.message : String(error)}`;
      slot.codeFailures += 1;
      const wait = doubling(codeRetryMs, longestCodeRetryMs, slot.codeFailures);
      slot.codeRetryAt = this.now() + wait;
      slot.codeError = message;
      this.log(
        `${slot.plugin} ${slot.entry.version}: ${message}${slot.running === undefined ? "" : `; version ${slot.running.version} keeps running`}; trying again in ${duration(wait)}`,
      );
      return undefined;
    }
  }

  /** Mints a key when one of the three causes calls for it, then starts the
   *  connector's process. */
  private async start(
    slot: Slot,
    file: string,
    code: Code,
    request: string | null,
  ): Promise<void> {
    const { plugin, entry } = slot;
    const home = this.options.home;
    let key = readIfThere(home.key(plugin));
    const mintedFor = readIfThere(home.minted(plugin));
    const cause =
      key === undefined
        ? "it held none"
        : slot.mintFor3
          ? "Marfa or the kit refused the last one"
          : mintedFor !== entry.version
            ? `version ${entry.version} replaces ${mintedFor ?? "an unknown version"}`
            : undefined;
    if (cause !== undefined) {
      const minted = await this.options.api.mint(plugin);
      if (minted.kind !== "ok") {
        const now = this.now();
        if (minted.kind === "unlinked" || minted.kind === "unassigned") {
          this.nextPollAt = now;
          this.log(
            `${plugin}: Marfa would not mint its key (${minted.kind === "unlinked" ? "it refused this host's key" : "it is not assigned to this host"}), so the host asks Marfa again`,
          );
          return;
        }
        slot.crashes += 1;
        const wait = doubling(restartMs, longestRestartMs, slot.crashes);
        slot.restartAt = now + wait;
        this.log(
          `${plugin}: could not mint its key (${minted.reason}); trying again in ${duration(wait)}`,
        );
        return;
      }
      key = minted.key;
      writeSecret(home.key(plugin), key);
      writeWhole(home.minted(plugin), entry.version);
      slot.mintedFor3 = slot.mintFor3;
      slot.mintFor3 = false;
      this.log(`${plugin}: minted its key, since ${cause}`);
    }
    if (this.stopping || slot.removed || key === undefined) return;
    const child = this.options.spawn(
      plugin,
      file,
      childEnvironment(this.options.env, this.options.origin, key),
    );
    const running: Running = {
      child,
      version: entry.version,
      sha256: code.sha256,
      startedAt: this.now(),
      startedOn: this.wall(),
      stopping: false,
    };
    slot.running = running;
    // The connector reads the request as its first run starts.
    if (request !== null) slot.actedRequest = request;
    this.log(
      `${plugin}: started version ${entry.version}${child.pid === undefined ? "" : ` as process ${String(child.pid)}`}`,
    );
    void child.exited.then((exit) => {
      this.exited(slot, running, exit);
    });
    await this.options.code.prune(plugin, code.sha256);
  }

  private exited(slot: Slot, running: Running, exit: Exit): void {
    const now = this.now();
    const wall = this.wall();
    if (slot.running === running) slot.running = undefined;
    slot.lastExit = { ...exit, on: wall };
    const { plugin } = slot;
    if (running.stopping) {
      this.log(`${plugin}: stopped, ${describeExit(exit)}`);
      return;
    }
    if (now - running.startedAt >= healthyMs) {
      slot.crashes = 0;
      slot.mintedFor3 = false;
    }
    const entry = slot.entry;
    const said = `${plugin}: ${describeExit(exit)}`;
    if (exit.code === 2) {
      slot.hold = {
        kind: "definition",
        version: entry.version,
        fingerprint: entry.fingerprint,
        sha256: running.sha256,
      };
      this.log(
        `${said}; it starts again once Marfa holds another version of it`,
      );
    } else if (exit.code === 3 && !slot.mintedFor3) {
      slot.mintFor3 = true;
      this.log(`${said}; it starts again on a new key`);
    } else if (exit.code === 3) {
      slot.hold = {
        kind: "key",
        version: entry.version,
        fingerprint: entry.fingerprint,
        keyMinted: entry.key_minted,
      };
      this.log(
        `${said} again, on a key minted for it just now; it starts again once Marfa holds another version or key for it`,
      );
    } else if (exit.code === 4) {
      slot.hold = {
        kind: "settings",
        version: entry.version,
        until: now + settingsRetryMs,
      };
      this.log(
        `${said}; it starts again when the owner asks it to run, or in ${duration(settingsRetryMs)}`,
      );
    } else {
      slot.crashes += 1;
      const wait = doubling(restartMs, longestRestartMs, slot.crashes);
      slot.restartAt = now + wait;
      this.log(`${said}; it starts again in ${duration(wait)}`);
    }
    if (exit.code !== 0)
      slot.pending = {
        ...exit,
        at: now,
        on: wall,
        line: running.child.lastError(),
      };
    this.kick(slot);
  }

  /**
   * A connector whose process failed before its key registered has no
   * registration to report on, so the host registers with that key, as the
   * kit does, and reports the failure once.
   */
  private async reportPending(slot: Slot): Promise<void> {
    const pending = slot.pending;
    if (pending === undefined || slot.seenAt <= pending.at) return;
    slot.pending = undefined;
    if (slot.entry.registration_id !== null) return;
    const signature = JSON.stringify([
      pending.code,
      pending.signal,
      pending.line,
    ]);
    if (signature === slot.reported) return;
    const key = readIfThere(this.options.home.key(slot.plugin));
    if (key === undefined) return;
    const line =
      pending.line === undefined
        ? ""
        : `: ${pending.line.split(key).join("[redacted]")}`;
    const error = `The connector's process ${describeExit(pending)} before it registered${line}`;
    try {
      await this.options.api.reportStartFailure({
        plugin: slot.plugin,
        key,
        readOnlyTypes: readOnlyTypes(slot.entry),
        at: new Date(pending.on),
        error:
          error.length > reportCap
            ? `${error.slice(0, reportCap - 1)}…`
            : error,
      });
      slot.reported = signature;
      this.log(`${slot.plugin}: reported the failure to Marfa as a failed run`);
    } catch (failure) {
      slot.pending = pending;
      this.log(
        `${slot.plugin}: could not report the failure to Marfa (${failure instanceof Error ? failure.message : String(failure)}); trying again after the next poll`,
      );
    }
  }

  private async stopChild(slot: Slot, why: string): Promise<void> {
    const running = slot.running;
    if (running === undefined) return;
    if (!running.stopping) {
      running.stopping = true;
      this.log(`${slot.plugin}: stopping, since ${why}`);
      running.child.signal("SIGTERM");
    }
    const timer = setTimeout(() => {
      running.child.signal("SIGKILL");
    }, this.grace);
    try {
      await running.child.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  /** What `status` shows: no key, ever. */
  status(): HostStatus {
    const iso = (ms: number): string => new Date(ms).toISOString();
    const now = this.now();
    const wall = this.wall();
    /** A deadline on the monotonic clock, dated on the wall clock. */
    const dated = (deadline: number): number => wall + (deadline - now);
    const connectors = [...this.slots.values()]
      .filter((slot) => !slot.removed)
      .map((slot): ConnectorStatus => {
        const { entry, running } = slot;
        const exit = slot.lastExit;
        const base = {
          plugin: slot.plugin,
          version: entry.version,
          ...(exit !== undefined && {
            lastExit: `${describeExit(exit)} at ${iso(exit.on)}`,
          }),
        };
        if (running !== undefined)
          return {
            ...base,
            state: "running",
            detail: running.stopping ? "stopping" : "running",
            ...(running.child.pid !== undefined && { pid: running.child.pid }),
            since: iso(running.startedOn),
          };
        const stopped = (detail: string, next?: number): ConnectorStatus => ({
          ...base,
          state: "stopped",
          detail,
          ...(next !== undefined && { nextStart: iso(dated(next)) }),
        });
        if (entry.connector.code === undefined)
          return stopped("its plugin carries no code");
        if (entry.paused) return stopped("paused by the owner");
        const hold = slot.hold;
        if (hold?.kind === "definition")
          return stopped(
            "its code or command line is wrong; it waits for another version",
          );
        if (hold?.kind === "key")
          return stopped(
            "Marfa refused its key twice; it waits for another version or key",
          );
        if (hold?.kind === "settings")
          return stopped(
            "a setting is missing or wrong; it waits for the owner to change its settings and run it",
            hold.until,
          );
        if (slot.codeError !== undefined)
          return stopped(slot.codeError, slot.codeRetryAt);
        if (slot.restartAt !== undefined)
          return stopped("waiting to start again", slot.restartAt);
        return stopped("starting");
      });
    return {
      pid: process.pid,
      ...(this.polledAt !== undefined && { polledAt: iso(this.polledAt) }),
      ...(this.pollError !== undefined && { pollError: this.pollError }),
      connectors,
    };
  }
}
