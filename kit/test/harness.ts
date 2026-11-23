import { createHmac } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import {
  defineConnector,
  type Change,
  type ConnectionDefinition,
  type Entry,
  type Inbound,
  type Log,
  type RunContext,
  type SettingsDeclaration,
  type Target,
  type TypeDefinition,
} from "../src/define.js";
import { start } from "./installed.js";
import { Declined, Refused, Unreachable } from "../src/rows.js";
import { verifyHmac } from "../src/verify.js";
import type { Clock, Runtime } from "../src/runtime.js";
import { ScriptedServer } from "./scripted-server.js";

/** An address nothing listens on: a port that was free a moment ago. */
export async function closedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return `http://127.0.0.1:${String(port)}`;
}

interface Sleep {
  ms: number;
  wake: () => void;
}

export class ManualClock implements Clock {
  readonly requested: number[] = [];
  private readonly pending: Sleep[] = [];
  private readonly waiters: (() => void)[] = [];
  private time = Date.parse("2026-09-25T09:00:00.000Z");

  now(): Date {
    return new Date(this.time);
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    this.requested.push(ms);
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const sleep: Sleep = {
        ms,
        wake: () => {
          const at = this.pending.indexOf(sleep);
          if (at !== -1) this.pending.splice(at, 1);
          signal.removeEventListener("abort", sleep.wake);
          resolve();
        },
      };
      signal.addEventListener("abort", sleep.wake, { once: true });
      this.pending.push(sleep);
      for (const waiter of this.waiters.splice(0)) waiter();
    });
  }

  async sleeping(ms: number): Promise<void> {
    while (!this.pending.some((sleep) => sleep.ms === ms)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  get waiting(): number {
    return this.pending.length;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  async wake(ms: number): Promise<void> {
    for (;;) {
      await this.sleeping(ms);
      const sleep = this.pending.find((candidate) => candidate.ms === ms);
      // Ended by its own signal between being found and being woken: the
      // one meant is still to come.
      if (sleep === undefined) continue;
      this.time += ms;
      sleep.wake();
      return;
    }
  }
}

export const testType: TypeDefinition = {
  id: "test.entry",
  label: "Entry",
  description: "An entry from the test vendor.",
  fields: {
    title: { type: "string", required: true },
    note: { type: "string" },
    link: { type: "url" },
    vendor_id: { type: "string" },
  },
};

export const linkedType: TypeDefinition = {
  ...testType,
  link_field: "vendor_id",
};

export const noteType: TypeDefinition = {
  ...linkedType,
  id: "test.note",
  label: "Note",
  description: "A note from the test vendor.",
};

/** `toString` is a name every object answers. */
export const testFields = ["title", "note", "link", "vendor_id", "toString"];

export const testSettings = [
  {
    name: "test_token",
    label: "Test token",
    kind: "text",
    secret: true,
    required: true,
  },
  { name: "test_region", label: "Test region", kind: "text" },
] as const satisfies SettingsDeclaration;

export interface Vendor {
  read?: (context: RunContext<typeof testSettings>) => Promise<void>;
  entries: Entry[];
  archived: string[];
  token: string | undefined;
  gate?: Promise<void> | undefined;
  fail?: Error | undefined;
  conditions?: [string, string][];
  unreached?: Parameters<Log["unreached"]>[0];
  unreachedBatches?: Parameters<Log["unreached"]>[0][];
  logs?: string[];
  warnings?: string[];
  runs: number;
  changes: Change[];
  answer?: ((change: Change) => Entry | undefined) | undefined;
  /** onChange keeps each change in the outbound journal before the vendor
   *  takes it, and acknowledges it after. */
  journaled?: boolean;
  duringRemake?: (() => void) | undefined;
  failAfter?: Error | undefined;
  pushFail?: { id: string; error: Error } | undefined;
  /** Thrown once the row is linked, as a step after the create fails. */
  failAfterLink?: { id: string; error: Error } | undefined;
  remakeFail?: { id: string; error: Error } | undefined;
  unreachable?: Set<string> | undefined;
  refused?: Map<string, string> | undefined;
  declined?: Set<string> | undefined;
  unreachableIn?: Map<string, string> | undefined;
  vendorIdFor?: ((change: Change) => string | undefined) | undefined;
  gone?: Map<string, string>;
  remakes?: { change: Change; runsBefore: number }[];
  hints?: (ReadonlySet<string> | undefined)[];
  revive?: boolean;
  /** Whether the vendor holds a row archived, as its properties say. */
  archivedWhen?:
    ((properties: Readonly<Record<string, unknown>>) => boolean) | undefined;
  connections?: ConnectionDefinition[];
  retired?: { type: string; connection: string }[];
  readOnly?: string[];
  derived?: string[];
  derive?: { keys: string[]; values: Record<string, unknown> };
  ask?:
    { connection: string; target: Target; rows?: "told" | "all" } | undefined;
  answers?: string[][];
  askEach?:
    | {
        connection: string;
        targets: { type: string; ids: string[] };
        rows?: "told" | "all";
      }
    | undefined;
  /** Each `askEach` answer: every target's rows' vendor ids, sorted. */
  eachAnswers?: Record<string, string[]>[];
  askHeld?: boolean;
  heldAnswers?: string[][];
  /** The two-way kind's own type in place of `linkedType`, under its id. */
  kindType?: TypeDefinition;
  kindFields?: string[];
  /** The rows of a second two-way kind, `note`, of `noteType`. */
  notes?: Entry[];
}

export function vendor(entries: Entry[] = []): Vendor {
  return { entries, archived: [], token: undefined, runs: 0, changes: [] };
}

export function testConnector(held: Vendor) {
  return defineConnector({
    name: "test",
    description: "A connector the kit's tests drive.",
    source: "test",
    types: [
      {
        name: "entry",
        type: testType,
        fields: testFields,
        ...(held.archivedWhen !== undefined && { archived: held.archivedWhen }),
      },
    ],
    ...(held.connections !== undefined && { connections: held.connections }),
    ...(held.retired !== undefined && { retired: held.retired }),
    settings: testSettings,
    async run(context) {
      held.runs += 1;
      if (held.gate !== undefined) await held.gate;
      for (const line of held.logs ?? []) context.log.info(line);
      for (const line of held.warnings ?? []) context.log.warn(line);
      for (const [key, message] of held.conditions ?? []) {
        context.log.condition(key, message);
      }
      if (held.unreached !== undefined) context.log.unreached(held.unreached);
      for (const selectors of held.unreachedBatches ?? [])
        context.log.unreached(selectors);
      if (held.fail !== undefined) throw held.fail;
      if (held.read !== undefined) return held.read(context);
      if (held.token !== undefined) context.state.set("token", held.token);
      await context.upsert(testType.id, held.entries);
      if (held.archived.length > 0) {
        await context.archive(testType.id, held.archived);
      }
    },
  });
}

function twoWayConnector(held: Vendor) {
  return defineConnector({
    name: "test",
    description: "A two-way connector the kit's tests drive.",
    source: "test",
    types: [
      {
        name: "entry",
        type: held.kindType ?? linkedType,
        fields: held.kindFields ?? testFields,
        revive: held.revive === true,
        ...(held.archivedWhen !== undefined && { archived: held.archivedWhen }),
        ...(held.readOnly !== undefined && { readOnly: held.readOnly }),
        ...(held.derived !== undefined && { derived: held.derived }),
      },
      ...(held.notes === undefined
        ? []
        : [{ name: "note", type: noteType, fields: testFields }]),
    ],
    ...(held.connections !== undefined && { connections: held.connections }),
    ...(held.retired !== undefined && { retired: held.retired }),
    settings: testSettings,
    async run(context) {
      held.runs += 1;
      if (held.gate !== undefined) await held.gate;
      for (const [key, message] of held.conditions ?? []) {
        context.log.condition(key, message);
      }
      if (held.unreached !== undefined) context.log.unreached(held.unreached);
      for (const selectors of held.unreachedBatches ?? [])
        context.log.unreached(selectors);
      if (held.fail !== undefined) throw held.fail;
      if (held.token !== undefined) context.state.set("token", held.token);
      await context.upsert(testType.id, held.entries);
      if (held.notes !== undefined)
        await context.upsert(noteType.id, held.notes);
      if (held.archived.length > 0) {
        await context.archive(testType.id, held.archived);
      }
      if (held.derive !== undefined) {
        await context.derive(testType.id, held.derive.keys, held.derive.values);
      }
      if (held.ask !== undefined) {
        const rows = await context.linked(
          testType.id,
          held.ask.connection,
          held.ask.target,
          held.ask.rows === undefined ? undefined : { rows: held.ask.rows },
        );
        (held.answers ??= []).push(
          rows.map((row) => String(row.properties["vendor_id"])),
        );
      }
      if (held.askEach !== undefined) {
        const found = await context.linkedEach(
          testType.id,
          held.askEach.connection,
          held.askEach.targets,
          held.askEach.rows === undefined
            ? undefined
            : { rows: held.askEach.rows },
        );
        (held.eachAnswers ??= []).push(
          Object.fromEntries(
            [...found].map(([id, rows]) => [
              id,
              rows.map((row) => String(row.properties["vendor_id"])).sort(),
            ]),
          ),
        );
      }
      if (held.askHeld === true) {
        const rows = await context.held(testType.id);
        (held.heldAnswers ??= []).push(
          rows.map((row) => String(row.properties["vendor_id"])).sort(),
        );
      }
      if (held.failAfter !== undefined) throw held.failAfter;
    },
    async onChange(change, context) {
      held.changes.push(change);
      const intent =
        held.journaled === true
          ? (context.outbound.get(change.item.id) ??
            (await context.outbound.save(change, {
              request: { id: change.item.id },
              baseline: null,
            })))
          : undefined;
      if (held.unreachable?.has(change.item.id) === true) {
        throw new Unreachable(`${change.item.id} cannot be reached`);
      }
      if (held.declined?.has(change.item.id) === true) {
        throw new Declined(`${change.item.id} is not the vendor's to take`);
      }
      const scope = held.unreachableIn?.get(change.item.id);
      if (scope !== undefined) {
        throw new Unreachable(`${scope} cannot be reached`, { scope });
      }
      const reason = held.refused?.get(change.item.id);
      if (reason !== undefined) throw new Refused(reason);
      if (held.pushFail?.id === change.item.id) {
        const { error } = held.pushFail;
        held.pushFail = undefined;
        throw error;
      }
      const id = held.vendorIdFor?.(change);
      if (id !== undefined) await context.setLink(change.item, id);
      if (held.failAfterLink?.id === change.item.id) {
        const { error } = held.failAfterLink;
        held.failAfterLink = undefined;
        throw error;
      }
      if (intent !== undefined)
        await context.outbound.acknowledge(change.item.id, intent.token);
      return held.answer?.(change);
    },
    async remake(change, context) {
      (held.remakes ??= []).push({ change, runsBefore: held.runs });
      if (held.unreachable?.has(change.item.id) === true) {
        throw new Unreachable(`${change.item.id} cannot be reached`);
      }
      const reason = held.refused?.get(change.item.id);
      if (reason !== undefined) throw new Refused(reason);
      if (held.declined?.has(change.item.id) === true) {
        throw new Declined(`${change.item.id} is not the vendor's to take`);
      }
      if (held.remakeFail?.id === change.item.id) {
        const { error } = held.remakeFail;
        held.remakeFail = undefined;
        throw error;
      }
      const id = held.gone?.get(change.item.id);
      if (id === undefined) return false;
      held.gone?.delete(change.item.id);
      held.duringRemake?.();
      await context.setLink(change.item, id);
      return true;
    },
  });
}

export const hung: AbortSignal[] = [];

const testInbound: Inbound<typeof testSettings> = {
  verify: (delivery, env, signal) => {
    if (delivery.header("x-hang") !== undefined) {
      hung.push(signal);
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          resolve(true);
        });
      });
    }
    if (delivery.header("x-throw") !== undefined) {
      throw new Error(`cannot read ${new TextDecoder().decode(delivery.body)}`);
    }
    return verifyHmac({
      secret: env.test_token,
      body: delivery.body,
      signature: delivery.header("x-signature"),
    });
  },
  hints: (delivery) => {
    const said = JSON.parse(new TextDecoder().decode(delivery.body)) as {
      ids?: string[];
      type?: string;
      everything?: boolean;
    };
    return said.everything === true
      ? "everything"
      : (said.ids ?? []).map((id) => ({ type: said.type ?? testType.id, id }));
  },
};

export function inboundConnector(held: Vendor) {
  const base = testConnector(held);
  return defineConnector({
    ...base,
    async run(context) {
      (held.hints ??= []).push(
        context.hints === undefined
          ? undefined
          : (context.hints.get(testType.id) ?? new Set()),
      );
      await base.run(context);
    },
    inbound: testInbound,
  });
}

function inboundTwoWayConnector(held: Vendor) {
  const base = twoWayConnector(held);
  return defineConnector({
    ...base,
    async run(context) {
      const named =
        context.hints === undefined
          ? undefined
          : (context.hints.get(testType.id) ?? new Set<string>());
      (held.hints ??= []).push(named);
      if (named === undefined) {
        await base.run(context);
        return;
      }
      held.runs += 1;
      await context.upsert(
        testType.id,
        held.entries.filter((entry) =>
          named.has(String(entry.properties["vendor_id"])),
        ),
      );
      if (held.archived.length > 0) {
        await context.archive(testType.id, held.archived);
      }
    },
    inbound: testInbound,
  });
}

export function signed(
  said: { ids?: string[]; type?: string; everything?: boolean },
  secret = secretToken,
): { body: string; headers: [string, string][] } {
  return signedText(JSON.stringify(said), secret);
}

export function signedText(
  body: string,
  secret = secretToken,
): { body: string; headers: [string, string][] } {
  return {
    body,
    headers: [
      ["X-Signature", createHmac("sha256", secret).update(body).digest("hex")],
    ],
  };
}

export const secretToken = "tok_vendor_secret_value";

export class Harness {
  readonly lines: string[] = [];
  /** What the connector printed on standard output. */
  readonly printed: string[] = [];
  readonly clock = new ManualClock();
  requestTimeoutMs = 5000;
  random = (): number => 0;
  private stopListener: (() => void) | undefined;
  private wakeListener: (() => void) | undefined;

  constructor(readonly server: ScriptedServer) {
    server.settings = { test_token: secretToken };
    server.kindTypes = { entry: testType.id, note: noteType.id };
  }

  static async create(): Promise<Harness> {
    return new Harness(
      await new ScriptedServer("test", { types: ["test.entry"] }).start(),
    );
  }

  async close(): Promise<void> {
    await this.server.stop();
  }

  /** A runtime whose environment holds what `values` names in capitals.
   *  Where it names a setting, in lowercase, the server's settings become
   *  those it names beside the test token; otherwise they stay as set. */
  runtime(
    argv: readonly string[],
    values: Readonly<Record<string, unknown>> = {},
  ): Runtime {
    const env: Record<string, string | undefined> = {};
    const settings: Record<string, unknown> = { test_token: secretToken };
    let named = false;
    for (const [name, value] of Object.entries(values)) {
      if (!/^[a-z]/.test(name)) {
        env[name] =
          value === undefined
            ? undefined
            : typeof value === "string"
              ? value
              : JSON.stringify(value);
        continue;
      }
      named = true;
      if (value !== undefined) settings[name] = value;
    }
    if (named) this.server.settings = settings;
    return {
      argv,
      env: {
        MARFA_API_URL: this.server.url,
        MARFA_API_KEY: this.server.key,
        ...env,
      },
      write: (line) => this.lines.push(line),
      print: (text) => this.printed.push(text),
      clock: this.clock,
      requestTimeoutMs: this.requestTimeoutMs,
      random: () => this.random(),
      onStop: (listener) => {
        this.stopListener = listener;
      },
      onWake: (listener) => {
        this.wakeListener = listener;
      },
    };
  }

  stop(): void {
    this.stopListener?.();
  }

  /** The host's `SIGUSR1`: a run now. */
  wake(): void {
    this.wakeListener?.();
  }

  once(
    held: Vendor,
    env?: Record<string, string | undefined>,
  ): Promise<number> {
    return start(testConnector(held), this.runtime(["--once"], env));
  }

  inbound(
    held: Vendor,
    argv: readonly string[] = ["--once"],
    env?: Record<string, string | undefined>,
  ): Promise<number> {
    return start(inboundConnector(held), this.runtime(argv, env));
  }

  inboundTwoWay(held: Vendor, argv: readonly string[]): Promise<number> {
    return start(inboundTwoWayConnector(held), this.runtime(argv));
  }

  twoWayRunning(held: Vendor, argv: readonly string[]): Promise<number> {
    return start(twoWayConnector(held), this.runtime(argv));
  }

  twoWay(
    held: Vendor,
    env?: Record<string, string | undefined>,
  ): Promise<number> {
    return start(twoWayConnector(held), this.runtime(["--once"], env));
  }

  kept(): Record<string, unknown> {
    return this.server.connectorState ?? {};
  }

  problems(): Record<string, string> {
    return this.server.problems.get(this.server.keySource) ?? {};
  }

  agreement(id: string): Record<string, unknown> | undefined {
    return this.server.agreements.get(id)?.record;
  }

  lastRun() {
    const run = this.server.runs.at(-1);
    if (run === undefined) throw new Error("no run was reported");
    return run;
  }
}
