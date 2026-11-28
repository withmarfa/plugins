import { randomUUID } from "node:crypto";
import { createClient } from "@withmarfa/client";
import type {
  ConnectionDefinition,
  Connector,
  ConnectorOf,
  SettingsDeclaration,
  SettingValues,
} from "./define.js";
import {
  checkDefinition,
  settingsRefused,
  ConfigurationError,
  readEnvironment,
  type Environment,
} from "./environment.js";
import { controlReadMs, Wake } from "./control.js";
import { exitCode } from "./exit.js";
import {
  defaulted,
  readSettings,
  secretsOf,
  shortSecretsProblem,
  type HeldSettings,
} from "./settings.js";
import { withoutBodies } from "./exception-text.js";
import { cap, Logger } from "./log.js";
import {
  causeOf,
  faultOf,
  Marfa,
  marfaFetch,
  Refusal,
  retryAfterOf,
  type Cause,
  type Control,
  type EdgeType,
  keyNarrowerThanTypes,
  type Key,
} from "./marfa.js";
import { answerPreviews } from "./preview.js";
import { Hold, type Ended } from "./hold.js";
import {
  describe,
  noPluginHolds,
  runOnce,
  specsOf,
  waitingInMarfa,
  type RunResult,
  type RunSetup,
  type Trigger,
} from "./run.js";
import { nodeRuntime, type Runtime } from "./runtime.js";
import {
  telemetrySecrets,
  noTelemetry,
  readTelemetry,
  startTelemetry,
  type Telemetry,
  type TelemetrySettings,
} from "./telemetry.js";
import { setUp } from "./setup.js";
import { edgeTypesOf, shippedConnection, turned } from "./shipped.js";
import {
  backoff,
  describeDuration,
  readSchedule,
  usage,
  type Schedule,
} from "./schedule.js";
import { edgeTypeDifferences } from "./type-check.js";
import {
  checkTypes,
  differenceProblem,
  type Narrowed,
  type TypeStep,
} from "./own-types.js";

const heartbeatMs = 60_000;

const beatTimeoutMs = 15_000;

/** A round of heartbeat and renewal never starts closer to the last than
 *  this, however long that one ran. */
const minimumBeatGapMs = 1000;

/** A registration lost again within this long of being made again is not
 *  made a third time. */
const reregisterAfterMs = 300_000;

/** The longest a `Retry-After` holds the start back. */
const longestRetryAfterMs = 300_000;

/** How far an ask of Marfa after an outage is spread, as a share of its
 *  wait, and how long the first run after an answer is spread over. */
const probeJitter = 0.2;
const afterAnswerMs = 5000;

/** How often a connector asks whether Marfa answers again after a run it
 *  could not finish for want of an answer. */
const probeMs = 15_000;

function startBackoff(intervalMs: number, attempts: number): number {
  return Math.min(intervalMs, 60_000) * Math.min(2 ** (attempts - 1), 8);
}

/** An app's key stays that app's, so the connector refuses it before it
 *  registers anything. */
function appKeyProblem(key: Key, guide: string): string | undefined {
  return key.oauth_client_id === undefined
    ? undefined
    : `the key ${key.id} is refused: an app made it, and it stays that app's. Start the connector with the key its connector host mints for it, as ${guide} says.`;
}

/** Where an owner is told to mint the connector's key. */
function keyGuide(connector: Pick<Connector, "readme">): string {
  return connector.readme ?? "the template's README";
}

/** A connector's key writes under the connector's source as its own, as the
 *  key a connector host mints does, and claims no other: a claim reaches rows
 *  that are not the connector's. */
function keySourceProblem(
  key: Key,
  source: string,
  guide: string,
): string | undefined {
  if (key.source !== source) {
    return `the key ${key.id} writes under its own source ${key.source}, not the connector's, ${source}, so every row it wrote would be refused: mint a key as ${guide} says.`;
  }
  if (key.sources.length > 0) {
    return `the key ${key.id} claims sources besides its own, ${source}, and is refused: ${key.sources.join(", ")}. Mint a key as ${guide} says.`;
  }
  return undefined;
}

function keyWiderThanTypes(
  key: Key,
  types: ReadonlySet<string>,
  connections: readonly ConnectionDefinition[],
): string[] {
  const edges = edgeTypesOf(connections);
  const wider: string[] = [];
  wider.push(...key.permissions);
  const held = (
    family: string,
    map: Record<string, string> | undefined,
    allowed: (name: string) => boolean,
  ): void => {
    for (const [name, level] of Object.entries(map ?? {})) {
      if (level === "none" || allowed(name)) continue;
      wider.push(`${family} ${name}=${level}`);
    }
  };
  held("type", key.type_permissions, (name) => types.has(name));
  held("metadata", key.metadata_permissions, () => false);
  held("edge", key.edge_permissions, (name) => edges.has(name));
  held("extension", key.extension_permissions, () => false);
  held("profile", key.profile_permissions, () => false);
  // An exemption from the instance's own rules is never a connector's.
  for (const lever of Object.keys(key.enforcement_override ?? {})) {
    wider.push(`an enforcement override of ${lever}`);
  }
  return wider;
}

/** How a declaration of a shipped type's reverse name differs from the
 *  type, which it reads from the other end. */
function inboundDifferences(
  connection: ConnectionDefinition,
  held: EdgeType,
): string[] {
  const differences: string[] = [];
  const there = turned(held.cardinality);
  if (connection.cardinality !== there) {
    differences.push(
      `cardinality is ${JSON.stringify(connection.cardinality)} here and ${JSON.stringify(there)} on the server, read from ${connection.id}'s side`,
    );
  }
  if (held.reverse_name !== connection.id) {
    differences.push(
      `${connection.id} is not the instance's reverse name, ${JSON.stringify(held.reverse_name)}`,
    );
  }
  return differences;
}

/**
 * Reads each connection type the connector writes as the instance serves it,
 * and holds it to what this build carries. Registers nothing: installing the
 * plugin registered the ones the instance does not ship. A type that is
 * missing or differs, beyond endpoints the installed type takes wider, stops
 * the start, since an edge written to it would be refused or wrongly typed.
 */
async function checkConnections(
  plugin: string,
  connections: readonly ConnectionDefinition[],
  marfa: Marfa,
): Promise<string | undefined> {
  if (connections.length === 0) return undefined;
  const served = await marfa.edgeTypes();
  const problems: string[] = [];
  for (const connection of connections) {
    const shipped = shippedConnection(connection.id);
    const held = served.find(
      (type) => type.id === (shipped?.edge ?? connection.id),
    );
    if (held === undefined) {
      problems.push(
        shipped === undefined
          ? `the connection type ${connection.id} is not installed`
          : `the connection type ${connection.id} differs from the instance's own: the instance does not hold it`,
      );
      continue;
    }
    let differences: string[];
    if (shipped === undefined) {
      differences = edgeTypeDifferences(connection, held);
    } else {
      // A declaration of the reverse name reads from the other end of the
      // edge, so its cardinality is the server's turned about.
      differences = [
        ...edgeTypeDifferences(
          {
            ...connection,
            id: held.id,
            cardinality: held.cardinality,
            from_type_constraints: held.from_type_constraints,
            to_type_constraints: held.to_type_constraints,
            ...(held.reverse_name !== undefined && {
              reverse_name: held.reverse_name,
            }),
            written_from: held.written_from,
          },
          held,
        ),
        ...(shipped.inbound
          ? inboundDifferences(connection, held)
          : connection.cardinality !== held.cardinality
            ? [
                `cardinality is ${JSON.stringify(connection.cardinality)} here and ${JSON.stringify(held.cardinality)} on the server`,
              ]
            : []),
      ];
    }
    if (differences.length === 0) continue;
    problems.push(
      shipped === undefined
        ? `the connection type ${connection.id} differs: ${differences.join("; ")}`
        : `the connection type ${connection.id} differs from the instance's own: ${differences.join("; ")}`,
    );
  }
  return problems.length === 0
    ? undefined
    : differenceProblem(plugin, problems.join("; "));
}

/** Every way the key is wrong at once, so one new key mends them all. */
function keyProblems<E extends SettingsDeclaration>(
  connector: Connector<E>,
  key: Key,
): string | undefined {
  const types = new Set(connector.types.map((kind) => kind.type.id));
  const connections = connector.connections ?? [];
  const edges = edgeTypesOf(connections);
  const named = [...types, ...edges].join(", ");
  const wider = keyWiderThanTypes(key, types, connections);
  const narrower = keyNarrowerThanTypes(key, types, edges);
  const problems = [
    keySourceProblem(key, connector.source, keyGuide(connector)),
    wider.length === 0
      ? undefined
      : `the key ${key.id} holds more than read and write on ${named}, and is refused: ${wider.join(", ")}. Revoke it and mint another as ${keyGuide(connector)} says.`,
    narrower.length === 0
      ? undefined
      : `the key ${key.id} may not write ${narrower.join(", ")}, which the connector writes, and is refused. Revoke it and mint another as ${keyGuide(connector)} says.`,
  ].filter((problem) => problem !== undefined);
  return problems.length === 0 ? undefined : problems.join(" ");
}

/**
 * Gives the source the name and mark the connector declares, where the source
 * has none set: a name or mark an owner chose in an app outlasts a restart.
 * Marfa refusing it never stops the start, since the rows sync under their code
 * all the same; the next start asks again. An answer that does not come, or a
 * key Marfa refuses, ends the attempt as it ends any other call of the start.
 */
async function nameSource<E extends SettingsDeclaration>(
  connector: Connector<E>,
  marfa: Marfa,
  logger: Logger,
): Promise<void> {
  const { sourceName, sourceMark } = connector;
  if (sourceName === undefined && sourceMark === undefined) return;
  try {
    const held = await marfa.source(connector.source);
    const body = {
      ...(sourceName !== undefined &&
        held.name_from !== "set" && { name: sourceName }),
      ...(sourceMark !== undefined &&
        held.mark === undefined && { mark: sourceMark }),
    };
    if (Object.keys(body).length > 0) {
      await marfa.nameSource(connector.source, body);
    }
  } catch (error) {
    if (causeOf(error) !== "refused") throw error;
    logger.warn(
      `could not set the name or mark of the source ${connector.source}, so apps may show its key's label or its code instead; the next start tries again:${describe(error)}`,
    );
  }
}

/**
 * Checks the key, registers, reads the settings, then checks the installed
 * types against the build. The settings' door is the registration's, so until
 * they are read the registration holds every type read only, and no edit is
 * taken that the settings might not carry back; the first run registers again
 * with the types its settings carry back. They are read before anything else
 * Marfa answers, so a secret an answer echoes is already redacted. Setup runs
 * no run, so it keeps what the registration holds, which a connector running
 * beside it set from its settings.
 */
async function registerAndCheck<E extends SettingsDeclaration>(
  connector: Connector<E>,
  marfa: Marfa,
  logger: Logger,
  keep: boolean,
): Promise<Started | Unregistered> {
  const key = await marfa.currentKey();
  const refusal = appKeyProblem(key, keyGuide(connector));
  if (refusal !== undefined) return { refusal };
  const readOnly =
    (keep ? await marfa.heldReadOnlyTypes(key.id) : undefined) ??
    connector.types.map((kind) => kind.type.id);
  let id: string;
  try {
    id = await marfa.register(connector.name, connector.description, readOnly);
  } catch (error) {
    // The registration is the connector's own door, so a 403 there is the key.
    if (error instanceof Refusal && error.status === 403) {
      return {
        refusal: `could not start: the server will not register this connector (${describe(error)}). MARFA_API_KEY must be the key a connector host minted for the connector itself, not an app's or a session's.`,
      };
    }
    throw error;
  }
  let held: HeldSettings | undefined;
  if ((connector.settings ?? []).length > 0) {
    try {
      held = await marfa.settings(id);
      logger.keep(secretsOf(connector.settings ?? [], held));
    } catch {
      // Read again before the first run, which says why it cannot be.
      held = undefined;
    }
  }
  const problems = keyProblems(connector, key);
  const stopped = (problem: string, keyRefused = false): Started => ({
    id,
    held,
    narrowed: undefined,
    problem,
    keyRefused,
  });
  if (problems !== undefined) return stopped(problems, true);
  const step = await checkTypes(
    connector.name,
    connector.types.map((kind) => kind.type),
    marfa,
  );
  if (step.problem !== undefined) return stopped(step.problem);
  const problem = await checkConnections(
    connector.name,
    connector.connections ?? [],
    marfa,
  );
  if (problem !== undefined) return stopped(problem);
  await nameSource(connector, marfa, logger);
  return {
    id,
    held,
    narrowed: step.narrowed,
    problem: undefined,
    keyRefused: false,
  };
}

/** A key refused before the connector registered, so there is no
 *  registration to report the failure against. */
interface Unregistered {
  readonly refusal: string;
}

interface Started {
  readonly id: string;
  /** The settings as read on registering, which the first run uses. */
  readonly held: HeldSettings | undefined;
  readonly narrowed: Narrowed | undefined;
  readonly problem: string | undefined;
  /** Whether the problem is the key, which Marfa or the kit refused. */
  readonly keyRefused: boolean;
}

function looks<E extends SettingsDeclaration>(
  connector: Connector<E>,
  values: SettingValues<E>,
): boolean {
  return (
    connector.inbound !== undefined ||
    [...specsOf(connector, values, undefined).values()].some(
      (spec) => spec.twoWay,
    )
  );
}

async function awaitChanges<E extends SettingsDeclaration>(
  setup: RunSetup<E>,
  held: (trigger: Trigger) => Promise<RunResult | undefined>,
  previews: () => Promise<void>,
  wake: Wake,
  everyMs: number,
  next: number,
  cursor: string | undefined,
): Promise<void> {
  const { clock, signal, marfa, connectorId, logger, connector } = setup;
  // Read through a call, since the signal can abort while a sleep waits.
  const stopped = (): boolean => signal.aborted;
  let unreachable = false;
  let peeked = cursor;
  while (!stopped()) {
    const left = next - clock.now().getTime();
    if (left <= 0) return;
    const woken = await wake.sleep(Math.min(left, everyMs), signal);
    if (woken || stopped() || clock.now().getTime() >= next) return;
    await previews();
    if (stopped()) return;
    let waiting = false;
    try {
      if (connector.inbound !== undefined) {
        waiting =
          (await marfa.pendingDeliveries(connectorId, 1, signal)).length > 0;
      }
      if (!waiting) {
        const log = await waitingInMarfa(setup, peeked);
        waiting = log.waiting;
        if (!waiting) peeked = log.cursor;
      }
      if (unreachable) logger.info("the look between runs is answered again");
      unreachable = false;
    } catch (error) {
      if (stopped()) return;
      // A type or registration the server lost is found by a run, which ends
      // the process to register again and check its types.
      if (causeOf(error) === "registration") waiting = true;
      else {
        if (!unreachable) {
          logger.warn(`the look between runs failed: ${describe(error)}`);
        }
        unreachable = true;
        continue;
      }
    }
    if (!waiting || stopped()) continue;
    const run = await held("look");
    if (run === undefined || !run.succeeded || !run.settled) {
      await wake.sleep(Math.max(0, next - clock.now().getTime()), signal);
      return;
    }
    peeked = run.cursor;
  }
}

function helpOf<E extends SettingsDeclaration>(
  connector: Connector<E>,
): string[] {
  const named = (connector.settings ?? []).map(
    (setting) =>
      `  ${setting.name} (${setting.label}, ${setting.kind}${setting.required === true ? "" : ", optional"}${setting.secret === true ? ", secret" : ""})`,
  );
  return [
    `${connector.name}: ${usage}`,
    "It reads from the environment:",
    "  MARFA_API_URL (the address of the Marfa server)",
    `  MARFA_API_KEY (the key its connector host minted for it, as ${keyGuide(connector)} says)`,
    "  OTEL_EXPORTER_OTLP_ENDPOINT (optional: where to send logs and traces, with a failed run's error, over OTLP; nothing is sent while it is unset)",
    ...(named.length === 0
      ? []
      : [
          `It reads its settings from Marfa at the start of every run; the owner sets them with \`marfa plugins settings ${connector.name}\` and \`marfa plugins secret ${connector.name}\`:`,
          ...named,
        ]),
    "It reads what the owner chose for it at the start of every run: a paused connector skips the run (under --every it then exits 0, and the host starts it again once the owner resumes it), SIGUSR2 runs it now, and it answers the mapping previews that wait, again on each look between runs.",
    "It exits 0 once stopped, 1 for any other failure, including a host not found or a certificate refused (tried again under --every), 2 when its definition or command line is wrong or MARFA_API_URL is malformed or redirected, 3 when Marfa or the kit refuses its key, and 4 when a required setting is missing, a value is invalid, or a run found settings only the owner can mend (SettingsRefused).",
    "  Startup failures found before telemetry starts, including a missing MARFA_API_URL or MARFA_API_KEY, are logged only.",
  ];
}

/**
 * Says why the connector cannot start and the process is ending. The text is
 * made safe to leave the machine first, with the secrets removed, any JSON
 * value replaced and its length bounded, so the log line and its copy in the
 * OpenTelemetry logs are the same text.
 */
function cannotStart(logger: Logger, problem: string): void {
  logger.error(cap(withoutBodies(logger.redact(problem))));
}

function addressProblem(error: unknown, server: string): string {
  const fault = faultOf(error);
  return fault === undefined
    ? `could not start: MARFA_API_URL (${server}) cannot be used (${describe(error)}). It must name the Marfa server itself, with no redirect in front of it.`
    : `could not start: MARFA_API_URL (${server}) cannot be used, since ${fault} (${describe(error)}). Check the address, and that the server's certificate is one this machine trusts.`;
}

/** Said once a connector that has run cannot reach Marfa for a fault in the
 *  address, which may mend itself, so it waits. */
function faultWarning(error: unknown): string | undefined {
  const fault = faultOf(error);
  return fault === undefined
    ? undefined
    : `MARFA_API_URL cannot be used for now, since ${fault} (${describe(error)}); the connector waits for it to mend, and stops only when told to`;
}

function startProblem(error: unknown, server: string, guide: string): string {
  const cause = causeOf(error);
  if (cause === "key") {
    return `could not start: the server at MARFA_API_URL (${server}) refused MARFA_API_KEY (${describe(error)}): the key is wrong or revoked. Set MARFA_API_KEY to a key minted for this connector, as ${guide} says.`;
  }
  if (cause === "marfa") {
    return `could not start: the server at MARFA_API_URL (${server}) did not answer (${describe(error)}). Check MARFA_API_URL and that the server is up, then start the connector again.`;
  }
  if (error instanceof Refusal && error.status === 403) {
    return `could not start: the server at MARFA_API_URL (${server}) will not register this connector (${describe(error)}). MARFA_API_KEY must be a key minted for the connector itself, not an app's or a session's.`;
  }
  return `could not start against the server at MARFA_API_URL (${server}): ${describe(error)}`;
}

/** Why the settings door refused this key, where it did: `404` for a key a
 *  connector host did not mint, or `403` for a caller that is not the
 *  registration's key. */
function settingsRefusal(
  error: unknown,
  connector: Pick<Connector, "name" | "readme">,
): string | undefined {
  if (!(error instanceof Refusal)) return undefined;
  if (error.status === 404 || error.status === 403) {
    return `${unhostedProblem(connector)} (${describe(error)})`;
  }
  return undefined;
}

/** What makes the connector a run's settings build differ from the one its
 *  key and installed plugin were checked against, which is the definition's
 *  fault, never the settings'. */
function shapeProblem<E extends SettingsDeclaration>(
  widest: Connector<E>,
  shaped: Connector<E>,
  values: SettingValues<E>,
): string | undefined {
  const types = new Set(widest.types.map((kind) => kind.type.id));
  const connections = new Set(
    (widest.connections ?? []).map((connection) => connection.id),
  );
  const problems: string[] = [];
  if (shaped.name !== widest.name || shaped.source !== widest.source) {
    problems.push("its name and source the same whatever its settings");
  }
  const outside = [
    ...shaped.types
      .map((kind) => kind.type.id)
      .filter((type) => !types.has(type)),
    ...(shaped.connections ?? [])
      .map((connection) => connection.id)
      .filter((id) => !connections.has(id)),
  ];
  if (outside.length > 0) {
    problems.push(
      `its widest shape to hold every type and connection type its settings can add, where ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not`,
    );
  }
  // Without a link, a row made in Marfa cannot be told to the vendor, nor a
  // purge found there.
  const unlinked = [...specsOf(shaped, values, undefined).values()].filter(
    (spec) => spec.twoWay && spec.link === undefined,
  );
  if (unlinked.length > 0) {
    problems.push(
      `a link_field on each type it carries back, where ${unlinked.map((spec) => spec.type).join(", ")} ${unlinked.length === 1 ? "has" : "have"} none`,
    );
  }
  return problems.length === 0
    ? undefined
    : `the connector needs ${problems.join("; ")}`;
}

interface Shared<E extends SettingsDeclaration> {
  /** The connector in its widest shape, which the key, the installed types
   *  and the registration are held to. */
  readonly connector: Connector<E>;
  /** The connector as the settings a run reads make it. */
  readonly build: (values: SettingValues<E>) => Connector<E>;
  readonly environment: Environment;
  readonly schedule: Exclude<Schedule, { mode: "help" }>;
  readonly marfa: Marfa;
  readonly logger: Logger;
  readonly clock: Runtime["clock"];
  readonly random: () => number;
  readonly stop: AbortController;
  /** Wakes the schedule when the host asks for a run now. */
  readonly wake: Wake;
  readonly print: (text: string) => void;
  readonly telemetry: Telemetry;
}

/**
 * Starts a connector and answers the code its process exits with, as
 * `exitCode` names them. `definition` is the connector, or, for one whose
 * shape depends on its settings, the function that builds it from them, with
 * `widest` the settings that give its widest shape.
 */
export async function start<E extends SettingsDeclaration>(
  definition: Connector<E> | ConnectorOf<E>,
  runtime: Runtime,
  widest?: Readonly<Partial<SettingValues<E>>>,
): Promise<number> {
  const widestValues = (widest ?? {}) as unknown as SettingValues<E>;
  const { clock } = runtime;
  const write = (line: string): void => {
    runtime.write(line);
  };
  const build: ConnectorOf<E> =
    typeof definition === "function" ? definition : () => definition;
  let connector: Connector<E>;
  let schedule: Schedule;
  let environment;
  let telemetrySettings: TelemetrySettings | undefined;
  try {
    connector = build(widestValues);
    checkDefinition(connector);
    schedule = readSchedule(runtime.argv);
    if (schedule.mode === "help") {
      for (const line of helpOf(connector)) write(line);
      return exitCode.stopped;
    }
    if (schedule.mode === "setup" && connector.setup === undefined) {
      throw new ConfigurationError(
        "--setup is for a connector with a setup, which this one has not",
      );
    }
    environment = readEnvironment(runtime.env);
    telemetrySettings = readTelemetry(runtime.env);
    if (schedule.mode === "every" && schedule.lookGiven) {
      const values = defaulted(
        connector.settings ?? ([] as unknown as E),
        widestValues,
      );
      if (!looks(build(values), values)) {
        throw new ConfigurationError(
          "--look-every is for a connector that receives webhooks or carries changes back, which this one does not",
        );
      }
    }
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    new Logger(write, clock).error(error.message);
    return exitCode.definition;
  }
  const logger = new Logger(write, clock, [environment.key]);
  const wake = new Wake(clock);
  runtime.onWake(() => {
    wake.request();
  });
  const shared = (telemetry: Telemetry): Shared<E> => ({
    connector,
    build: (values) => build(values),
    environment,
    schedule,
    marfa: new Marfa((signal, timing) =>
      createClient({
        baseUrl: environment.url,
        credential: environment.key,
        fetch: marfaFetch(runtime.requestTimeoutMs, signal, timing),
      }),
    ),
    logger,
    clock,
    random: runtime.random,
    stop: new AbortController(),
    wake,
    print: (text) => {
      (runtime.print ?? runtime.write)(text);
    },
    telemetry,
  });
  if (telemetrySettings === undefined) {
    return started(runtime, shared(noTelemetry));
  }
  logger.keep(telemetrySecrets(telemetrySettings));
  const telemetry = await startTelemetry(
    telemetrySettings,
    connector.name,
    logger,
    clock,
    runtime.random,
  );
  try {
    return await started(runtime, shared(telemetry));
  } finally {
    await telemetry.shutdown();
  }
}

/** The start, once the environment is read. */
async function started<E extends SettingsDeclaration>(
  runtime: Runtime,
  shared: Shared<E>,
): Promise<number> {
  const { clock, logger, stop } = shared;
  runtime.onStop(() => {
    logger.info("asked to stop");
    stop.abort();
  });
  let lostAt: number | undefined;
  for (;;) {
    const ended = await serve(shared);
    if (ended !== "registration") return ended;
    // A server that loses the registration as fast as it is made would
    // have this loop register it for good.
    const now = clock.now().getTime();
    if (lostAt !== undefined && now - lostAt < reregisterAfterMs) {
      logger.error(
        "the server keeps losing this connector's registration or one of its types, so the connector stops; check what removes it, then start it again",
      );
      return exitCode.failed;
    }
    lostAt = now;
    logger.warn(
      "the server no longer holds this connector's registration or one of its types, so it registers again and checks its types",
    );
  }
}

/** Why a session ended that no run mends. */
type Halt =
  Ended | "settings" | "unhosted" | "definition" | "keyRefused" | "paused";

/** Said when the settings door answers that this key is not the one a
 *  connector host minted for the plugin's connector. */
function unhostedProblem(
  connector: Pick<Connector, "name" | "readme">,
): string {
  return `Marfa will not give this connector its settings: MARFA_API_KEY is not the key a connector host minted for the ${connector.name} plugin's connector, or the plugin no longer holds it. Install the plugin, assign its connector to a host, and start the connector with the key the host mints, as ${keyGuide(connector)} says.`;
}

/** Registers, then runs, until the process is told to stop or its key or
 *  registration is lost. Answers `registration` where registering again
 *  would mend it. */
async function serve<E extends SettingsDeclaration>(
  shared: Shared<E>,
): Promise<number | "registration"> {
  const {
    connector,
    build,
    environment,
    schedule,
    marfa,
    logger,
    clock,
    random,
    stop,
    wake,
    print,
    telemetry,
  } = shared;
  const stopped = (): boolean => stop.signal.aborted;
  const intervalMs = schedule.mode === "every" ? schedule.intervalMs : 0;

  let started: Started | Unregistered | undefined;
  for (let failures = 1; started === undefined; failures += 1) {
    try {
      started = await registerAndCheck(
        connector,
        marfa,
        logger,
        schedule.mode === "setup",
      );
    } catch (error) {
      if (causeOf(error) === "address") {
        cannotStart(logger, addressProblem(error, environment.url));
        return exitCode.definition;
      }
      // A host not found or a certificate refused may mend, as when the
      // connector starts before the network does.
      if (faultOf(error) !== undefined && schedule.mode !== "every") {
        cannotStart(logger, addressProblem(error, environment.url));
        return exitCode.failed;
      }
      if (schedule.mode !== "every" || causeOf(error) !== "marfa") {
        cannotStart(
          logger,
          startProblem(error, environment.url, keyGuide(connector)),
        );
        return causeOf(error) === "key" ? exitCode.key : exitCode.failed;
      }
      const wait = Math.max(
        startBackoff(intervalMs, failures),
        Math.min(retryAfterOf(error) ?? 0, longestRetryAfterMs),
      );
      const fault = faultOf(error);
      logger.warn(
        `could not reach the server at MARFA_API_URL (${environment.url})${fault === undefined ? "" : `, since ${fault}`}, trying again in ${describeDuration(wait)}: ${describe(error)}`,
      );
      await clock.sleep(wait, stop.signal);
      if (stopped()) return exitCode.stopped;
    }
  }
  if ("refusal" in started) {
    cannotStart(logger, started.refusal);
    return exitCode.key;
  }
  const connectorId = started.id;
  logger.info(`registered as ${connectorId}`);

  // A start that cannot go on is the registration's failed run.
  const refuseStart = async (problem: string): Promise<void> => {
    const at = clock.now().toISOString();
    cannotStart(logger, problem);
    try {
      await marfa.report(connectorId, {
        outcome: "failed",
        started_at: at,
        finished_at: at,
        error: cap(withoutBodies(logger.redact(problem))),
      });
    } catch (error) {
      logger.warn(`the failure could not be reported: ${describe(error)}`);
    }
  };
  if (started.problem !== undefined) {
    await refuseStart(started.problem);
    return started.keyRefused ? exitCode.key : exitCode.failed;
  }
  if (stopped()) return exitCode.stopped;

  /** Reads the settings, their secrets redacted from every later line as
   *  soon as they arrive. The first read takes what registering read. */
  let fresh = started.held;
  let settingsRead = fresh !== undefined;
  const readHeld = async (
    signal: AbortSignal,
  ): Promise<HeldSettings | undefined> => {
    if ((connector.settings ?? []).length === 0) return undefined;
    if (fresh !== undefined) {
      const held = fresh;
      fresh = undefined;
      return held;
    }
    const held = await marfa.settings(connectorId, signal);
    logger.keep(secretsOf(connector.settings ?? [], held));
    settingsRead = true;
    return held;
  };

  if (schedule.mode === "setup") {
    let held: HeldSettings | undefined;
    try {
      held = await readHeld(stop.signal);
    } catch (error) {
      if (stopped()) return exitCode.stopped;
      const refused = settingsRefusal(error, connector);
      cannotStart(
        logger,
        refused ??
          `could not read the connector's settings from Marfa: ${describe(error)}`,
      );
      return refused === undefined ? exitCode.failed : exitCode.key;
    }
    const short =
      held === undefined
        ? undefined
        : shortSecretsProblem(connector.settings ?? [], held);
    if (short !== undefined) {
      cannotStart(
        logger,
        `the connector cannot set up with its settings: ${short}`,
      );
      return exitCode.settings;
    }
    // Setup makes what the connector needs later, so it needs none of it.
    const values: Record<string, unknown> = {};
    for (const setting of connector.settings ?? []) {
      const answered = held?.settings.find((one) => one.name === setting.name);
      values[setting.name] =
        answered?.value ??
        (setting.secret === true ? undefined : setting.default);
    }
    return setUp(
      connector,
      marfa,
      connectorId,
      environment,
      values as Readonly<Partial<SettingValues<E>>>,
      held?.plugin ?? connector.name,
      logger,
      stop.signal,
      print,
      clock.now().toISOString(),
    );
  }

  // The key refused, the registration gone, an address that cannot be used
  // or settings the connector cannot run with end the session, whatever it
  // was doing: no run mends any.
  const halt = new AbortController();
  let halted: Halt | undefined;
  let haltedBy: unknown;
  const end = (why: Halt, error?: unknown): void => {
    if (halted !== undefined) return;
    halted = why;
    haltedBy = error;
    halt.abort();
  };
  const ends = (cause: Cause): cause is Ended =>
    cause === "key" || cause === "registration" || cause === "address";
  const lasting = AbortSignal.any([stop.signal, halt.signal]);
  const over = (): boolean => lasting.aborted;

  const hold = new Hold(marfa, connectorId, randomUUID(), logger, clock);
  const beating = new AbortController();
  const beat = AbortSignal.any([beating.signal, lasting]);
  const beatingEnded = (): boolean => beat.aborted;
  const heartbeat = (async () => {
    let failing = false;
    let beatBegan = Number.NEGATIVE_INFINITY;
    let beatInFlight: Promise<void> | undefined;
    const beating = async (): Promise<void> => {
      try {
        await marfa.heartbeat(
          connectorId,
          AbortSignal.any([beat, AbortSignal.timeout(beatTimeoutMs)]),
        );
        if (failing) logger.info("the heartbeat is answered again");
        failing = false;
      } catch (error) {
        const cause = causeOf(error);
        if (ends(cause)) {
          end(cause, error);
          return;
        }
        // A heartbeat cut short because beating ended is not a failure.
        if (!beatingEnded() && !failing) {
          logger.warn(
            faultWarning(error) ??
              `the heartbeat failed, and is tried again with the next beat: ${describe(error)}`,
          );
          failing = true;
        }
      }
    };
    let renewBegan = Number.NEGATIVE_INFINITY;
    while (!beatingEnded()) {
      const began = clock.now().getTime();
      // Not waited for, so a heartbeat that has not answered never holds up
      // a renewal, which has its own timer and its own timeout.
      if (beatInFlight === undefined && began - beatBegan >= heartbeatMs) {
        beatBegan = began;
        beatInFlight = beating().finally(() => {
          beatInFlight = undefined;
        });
      }
      if (began - renewBegan >= hold.renewEvery) {
        renewBegan = began;
        const lost = await hold.renew();
        if (lost !== undefined) end(lost);
        if (beatingEnded()) break;
      }
      // Until the sooner of the next renewal and the next heartbeat, each
      // counted from its own start, and never closer than half a renewal,
      // whatever the window.
      const left =
        Math.min(renewBegan + hold.renewEvery, beatBegan + heartbeatMs) -
        clock.now().getTime();
      await clock.sleep(
        Math.max(Math.min(minimumBeatGapMs, hold.renewEvery / 2), left),
        AbortSignal.any([beat, hold.rearmed]),
      );
    }
    await beatInFlight;
  })();

  // The run's connector and settings, as the last settings read made them;
  // the look between runs reads with these.
  const setup: RunSetup<E> = {
    connector,
    values: {} as SettingValues<E>,
    marfa,
    connectorId,
    process: hold.process,
    logger,
    clock,
    signal: lasting,
    stopping: stopped,
    narrowed: started.narrowed,
    plugin: started.held?.plugin ?? connector.name,
    mapped: { version: undefined, plan: undefined },
  };
  const failedOn = (error: unknown): RunResult => ({
    succeeded: false,
    cause: causeOf(error),
    retryAfterMs: retryAfterOf(error),
    settled: false,
    cursor: undefined,
  });
  /**
   * Reads the settings and builds the run's connector from them, so a value
   * the owner changed between runs is the next run's. Settings the connector
   * cannot run with stop the session before anything is read or written.
   * Answers a failed run where Marfa did not answer, and nothing where the
   * session ends.
   */
  let keyChecked = true;
  const prepare = async (): Promise<RunResult | undefined> => {
    // A key widened since the last run would write past its connector.
    if (!keyChecked) {
      let problem: string | undefined;
      try {
        problem = keyProblems(connector, await marfa.currentKey());
      } catch (error) {
        if (over()) return undefined;
        const cause = causeOf(error);
        if (ends(cause)) {
          end(cause, error);
          return undefined;
        }
        logger.error(
          `the key could not be checked, so this run does not start: ${describe(error)}`,
        );
        return failedOn(error);
      }
      if (problem !== undefined) {
        await refuseStart(problem);
        end("keyRefused");
        return undefined;
      }
    }
    keyChecked = false;
    let held: HeldSettings | undefined;
    try {
      held = await readHeld(lasting);
    } catch (error) {
      if (over()) return undefined;
      // The door answering for a registration it answered before has lost
      // it, as any other door would say.
      if (
        settingsRead &&
        error instanceof Refusal &&
        error.status === 404 &&
        error.code === "connector_not_found"
      ) {
        end("registration", error);
        return undefined;
      }
      const refused = settingsRefusal(error, connector);
      if (refused !== undefined) {
        await refuseStart(refused);
        end("unhosted", error);
        return undefined;
      }
      const cause = causeOf(error);
      if (ends(cause)) {
        end(cause, error);
        return undefined;
      }
      logger.error(
        `the settings could not be read from Marfa, so this run does not start: ${describe(error)}`,
      );
      return failedOn(error);
    }
    let values = {} as SettingValues<E>;
    if (held !== undefined) {
      const read = readSettings(
        connector.settings ?? ([] as unknown as E),
        held,
      );
      if (read.problem !== undefined) {
        await refuseStart(read.problem);
        end("settings");
        return undefined;
      }
      values = read.values;
    }
    let shaped: Connector<E>;
    try {
      shaped = build(values);
    } catch (error) {
      await refuseStart(
        `the connector cannot run with its settings: ${describe(error)}`,
      );
      end("settings", error);
      return undefined;
    }
    const definitionProblem = shapeProblem(connector, shaped, values);
    if (definitionProblem !== undefined) {
      await refuseStart(definitionProblem);
      end("definition");
      return undefined;
    }
    try {
      await shaped.checkEnv?.(values);
    } catch (error) {
      await refuseStart(
        `the connector cannot run with its settings: ${describe(error)}`,
      );
      end("settings", error);
      return undefined;
    }
    setup.connector = shaped;
    if (held !== undefined) setup.plugin = held.plugin;
    setup.values = values;
    return undefined;
  };
  let heldUntil: string | undefined;
  // A key that is no plugin connector's has no choices of an owner to read.
  let unowned = false;
  let controlFailing = false;
  /** What the owner chose for the connector, read once as a run starts.
   *  Answers nothing where the key is no plugin connector's, or Marfa did
   *  not answer, and the run goes ahead as scheduled. */
  const controlled = async (): Promise<Control | undefined> => {
    if (unowned) return undefined;
    try {
      const read = await marfa.control(
        setup.plugin ?? connector.name,
        AbortSignal.any([lasting, AbortSignal.timeout(controlReadMs)]),
      );
      if (controlFailing)
        logger.info("the connector's control door is answered again");
      controlFailing = false;
      return read;
    } catch (error) {
      if (over()) return undefined;
      if (noPluginHolds(error)) {
        unowned = true;
        return undefined;
      }
      const cause = causeOf(error);
      if (ends(cause)) {
        end(cause, error);
        return undefined;
      }
      if (!controlFailing) {
        logger.warn(
          `the owner's choices to pause the connector or run it now could not be read, so it runs as scheduled until they can: ${describe(error)}`,
        );
        controlFailing = true;
      }
      return undefined;
    }
  };
  /** Answers the mapping previews the owner's choices say wait. Writes
   *  nothing, so it needs no hold. */
  const answerWaiting = async (control: Control | undefined): Promise<void> => {
    if (control === undefined || control.paused || control.previews === 0)
      return;
    await answerPreviews({
      connector: setup.connector,
      values: setup.values,
      marfa,
      plugin: setup.plugin ?? connector.name,
      logger,
      signal: lasting,
    });
  };
  /** What a look between runs does besides reading Marfa's log: answers
   *  the previews that wait, so one is answered within a look. */
  const previewsOnLook = async (): Promise<void> => {
    const control = await controlled();
    if (over()) return;
    await answerWaiting(control);
  };
  const held = async (trigger: Trigger): Promise<RunResult | undefined> => {
    heldUntil = undefined;
    const control = await controlled();
    if (over()) return undefined;
    if (control?.paused === true) {
      if (schedule.mode === "every") {
        logger.info(
          "the owner paused this connector, so this run does not start and reports nothing, and the connector stops; the host starts it again when the owner resumes it",
        );
        end("paused");
      } else {
        logger.info(
          "the owner paused this connector, so this run does not start and reports nothing",
        );
      }
      return undefined;
    }
    const unprepared = await prepare();
    if (unprepared !== undefined || over()) return unprepared;
    await answerWaiting(control);
    if (over()) return undefined;
    let taken;
    try {
      taken = await hold.take();
    } catch (error) {
      if (over()) return undefined;
      const cause = causeOf(error);
      if (ends(cause)) {
        end(cause, error);
        return undefined;
      }
      logger.error(
        `the hold could not be taken, so this run does not start: ${describe(error)}`,
      );
      return failedOn(error);
    }
    if (!taken.held) {
      logger.warn(
        `another process holds this connector until ${taken.until}, so this one does not run`,
      );
      heldUntil = taken.until;
      return undefined;
    }
    const ran = await telemetry.run(trigger, () =>
      runOnce(
        {
          ...setup,
          marfa: marfa.scoped(hold.signal),
          signal: AbortSignal.any([lasting, hold.signal]),
          fenced: () => hold.check(),
          requested: control?.run_requested_at ?? undefined,
        },
        trigger,
      ),
    );
    // A run fenced for want of an answer to its renewals failed on Marfa.
    const run =
      !ran.succeeded && ran.cause === "run" && hold.fencedBy !== undefined
        ? { ...ran, cause: hold.fencedBy }
        : ran;
    if (run.cause !== undefined && ends(run.cause)) end(run.cause);
    // Only the owner can mend it, so trying again would mend nothing.
    else if (settingsRefused(run.failure)) end("settings", run.failure);
    return run;
  };
  // Asks Marfa, the cheapest way it can be asked, until it answers: not
  // sooner than a refusal's `Retry-After`, nor in step with other
  // connectors, and the run that follows is spread the same way.
  const untilMarfaAnswers = async (
    named: number | undefined,
  ): Promise<void> => {
    const every = Math.min(intervalMs, probeMs);
    const spread = (ms: number): number => ms * (1 + probeJitter * random());
    const asked = (ms: number | undefined): number =>
      Math.min(ms ?? 0, longestRetryAfterMs);
    let faultSaid = false;
    let wait = spread(Math.max(every, asked(named)));
    logger.info(
      `Marfa did not answer, so the connector asks every ${describeDuration(every)} and runs again once it does`,
    );
    while (!over()) {
      await clock.sleep(wait, lasting);
      if (over()) return;
      try {
        await marfa.heartbeat(
          connectorId,
          AbortSignal.any([lasting, AbortSignal.timeout(beatTimeoutMs)]),
        );
        break;
      } catch (error) {
        if (over()) return;
        const cause = causeOf(error);
        if (ends(cause)) {
          end(cause, error);
          return;
        }
        // Marfa answered, though it refused: the run can find out why.
        if (cause !== "marfa") break;
        const said = faultWarning(error);
        if (said !== undefined && !faultSaid) {
          faultSaid = true;
          logger.warn(said);
        }
        wait = spread(Math.max(every, asked(retryAfterOf(error))));
      }
    }
    logger.info("Marfa answers again, so the connector runs now");
    const after = Math.round(random() * Math.min(afterAnswerMs, intervalMs));
    if (after > 0) await clock.sleep(after, lasting);
  };
  // Updating the plugin lifts the narrowing at the next scheduled run, without
  // a restart.
  const narrowAgain = async (): Promise<string | undefined> => {
    const was = setup.narrowed;
    let step: TypeStep;
    try {
      step = await checkTypes(
        connector.name,
        connector.types.map((kind) => kind.type),
        marfa,
      );
    } catch (error) {
      if (over()) return undefined;
      const cause = causeOf(error);
      if (ends(cause)) {
        end(cause, error);
        return undefined;
      }
      logger.warn(
        `the connector's types could not be checked again, so it goes on without the fields it lacked: ${describe(error)}`,
      );
      return undefined;
    }
    if (step.problem !== undefined) return step.problem;
    for (const type of was?.fields.keys() ?? []) {
      if (step.narrowed?.fields.has(type) !== true) {
        logger.info(
          `the type ${type} now holds every field this connector declares, so it writes them all`,
        );
      }
    }
    for (const type of was?.tables.keys() ?? []) {
      if (step.narrowed?.tables.has(type) !== true) {
        logger.info(
          `the type ${type} now holds every table this connector declares, so it writes their rows`,
        );
      }
    }
    setup.narrowed = step.narrowed;
    return undefined;
  };
  let code = 0;
  let succeeded = false;
  try {
    if (schedule.mode === "once") {
      const run = await held("schedule");
      succeeded = run?.succeeded === true;
      code =
        run === undefined || run.succeeded || stopped()
          ? exitCode.stopped
          : exitCode.failed;
    } else {
      let failures = 0;
      // Asked for once until a run succeeds or fails for another cause, so a
      // Marfa that answers but keeps failing runs is given no more load than
      // the backoff gives.
      let hurried = false;
      let first = true;
      while (!over()) {
        if (!first && setup.narrowed !== undefined) {
          const problem = await narrowAgain();
          if (over()) break;
          if (problem !== undefined) {
            await refuseStart(problem);
            code = exitCode.failed;
            break;
          }
        }
        first = false;
        const run = await held("schedule");
        if (over()) break;
        if (run === undefined) {
          await wake.sleep(
            untilLapsed(heldUntil, clock.now().getTime(), schedule.intervalMs),
            lasting,
          );
          continue;
        }
        failures = run.succeeded ? 0 : failures + 1;
        if (run.cause !== "marfa") hurried = false;
        if (run.cause === "marfa" && !hurried) {
          hurried = true;
          await untilMarfaAnswers(run.retryAfterMs);
          continue;
        }
        const wait = Math.max(
          backoff(schedule.intervalMs, failures),
          Math.min(run.retryAfterMs ?? 0, longestRetryAfterMs),
        );
        if (failures > 0) {
          logger.info(`the next run is in ${describeDuration(wait)}`);
        }
        const next = clock.now().getTime() + wait;
        if (!looks(setup.connector, setup.values) || !run.settled) {
          await wake.sleep(wait, lasting);
          continue;
        }
        await awaitChanges(
          setup,
          held,
          previewsOnLook,
          wake,
          schedule.lookMs,
          next,
          run.cursor,
        );
      }
    }
  } finally {
    beating.abort();
    await heartbeat;
    // A lost type leaves the registration, and so the hold, in place.
    if (halted === "key" || halted === "address") hold.abandon();
    else await hold.release();
  }
  if (halted === undefined || halted === "paused" || (succeeded && code === 0))
    return code;
  if (halted === "settings") return exitCode.settings;
  if (halted === "unhosted" || halted === "keyRefused") return exitCode.key;
  if (halted === "definition") return exitCode.definition;
  if (halted === "key") {
    logger.error(
      `the server refused MARFA_API_KEY, or the key no longer reaches the connector's types, so the connector stops: the key is wrong, revoked or narrowed. Mint another as ${keyGuide(connector)} says, set MARFA_API_KEY, and start the connector again.`,
    );
    return exitCode.key;
  }
  if (halted === "address") {
    logger.error(
      `the server's address stopped working (${describe(haltedBy)}), so the connector stops: MARFA_API_URL must name the Marfa server itself, with no redirect in front of it and a certificate this machine trusts.`,
    );
    return exitCode.definition;
  }
  if (schedule.mode === "once") {
    logger.error(
      "the server no longer holds this connector's registration or one of its types, so this run stops; start it again to register it anew and check its types",
    );
    return exitCode.failed;
  }
  return "registration";
}

/**
 * How long a process refused the hold waits: until a second after the
 * hold would lapse, since one a stopped process left lapses well within an
 * interval; at least half a minute, so a clock ahead of the instance's does
 * not ask every second; at most the interval.
 */
export function untilLapsed(
  until: string | undefined,
  now: number,
  intervalMs: number,
): number {
  const at = until === undefined ? Number.NaN : Date.parse(until);
  if (!Number.isFinite(at)) return intervalMs;
  return Math.min(intervalMs, Math.max(30_000, at - now + 1000));
}

/** Runs the connector as its process, which exits as `exitCode` names. */
export async function main<E extends SettingsDeclaration>(
  definition: Connector<E> | ConnectorOf<E>,
  widest?: Readonly<Partial<SettingValues<E>>>,
): Promise<void> {
  process.exitCode = await start(definition, nodeRuntime(), widest);
}
