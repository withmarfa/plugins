import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  Connector,
  SettingsDeclaration,
  LocalCallback,
  SetupContext,
  SettingValues,
} from "./define.js";
import type { Environment } from "./environment.js";
import { keepSecret, type Logger } from "./log.js";
import type { Marfa } from "./marfa.js";
import { describe } from "./run.js";

const done =
  "<!doctype html><title>Done</title><p>Done: go back to the terminal.</p>";
const failed =
  "<!doctype html><title>Failed</title><p>Setup failed: the terminal says why.</p>";

interface Served {
  readonly server: Server;
  release(succeeded: boolean): void;
}

/** `text` as one word in a POSIX shell, whatever it holds. */
export function shellWord(text: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(text)
    ? text
    : `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The commands that give Marfa what setup made: `marfa plugins settings
 * --set` for a value, and for a secret, which `marfa plugins secret` takes
 * only on standard input, the value piped in by `printf`, a shell builtin, so
 * it is in no process list.
 */
export function settingCommands(
  plugin: string,
  secret: ReadonlySet<string>,
  answered: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(answered).map(([name, value]) =>
    secret.has(name)
      ? `printf '%s' ${shellWord(value)} | marfa plugins secret ${shellWord(plugin)} ${shellWord(name)}`
      : `marfa plugins settings ${shellWord(plugin)} --set ${shellWord(`${name}=${value}`)}`,
  );
}

/**
 * Runs the connector's setup with its vendor, then prints on standard output
 * the commands that set what it answered, which the owner runs where
 * `marfa` is signed in as the owner. The log, which redacts every secret,
 * says where they are; nothing is written to a file.
 */
export async function setUp<E extends SettingsDeclaration>(
  connector: Connector<E>,
  marfa: Marfa,
  connectorId: string,
  environment: Environment,
  values: Readonly<Partial<SettingValues<E>>>,
  plugin: string,
  logger: Logger,
  signal: AbortSignal,
  print: (text: string) => void,
  at: string,
): Promise<number> {
  const setup = connector.setup;
  if (setup === undefined) throw new Error("the connector has no setup");
  const servers: Served[] = [];
  const made: { id: string; label: string }[] = [];
  const context: SetupContext<E> = {
    env: values,
    signal,
    log: {
      info: (message) => {
        logger.info(message);
      },
      warn: (message) => {
        logger.warn(message);
      },
    },
    secret: (value) => {
      keepSecret(logger, value);
    },
    listen: (page) => serve(page, servers, logger, signal),
    endpoint: async (options = {}) => {
      // The listing shows an address by its last four characters, so the
      // label is what tells this setup's endpoint from an earlier one's.
      const suffix = `, set up ${at}`;
      const label = `${(options.label ?? connector.name).slice(0, 200 - suffix.length)}${suffix}`;
      const endpoint = await marfa.createEndpoint(connectorId, {
        ...options,
        label,
      });
      made.push({ id: endpoint.id, label });
      // Anyone holding the address can post to it.
      logger.keep([endpoint.path]);
      return {
        path: endpoint.path,
        url: `${environment.url.replace(/\/+$/, "")}${endpoint.path}`,
      };
    },
  };
  const answeredBySetup = async (): Promise<number> => {
    let answered: Readonly<Record<string, string>>;
    try {
      answered = await setup(context);
    } catch (error) {
      logger.error(`setup failed: ${describe(error)}`);
      // An address handed to a vendor whose secrets are gone only takes
      // deliveries no one can verify, and holds one of the ten places.
      await retire(marfa, connectorId, made, logger);
      return 1;
    }
    const declared = connector.settings ?? [];
    const names = Object.keys(answered);
    const unknown = names.filter(
      (name) => !declared.some((setting) => setting.name === name),
    );
    if (unknown.length > 0) {
      logger.error(
        `setup answered ${unknown.join(", ")}, which the connector does not declare`,
      );
      return 1;
    }
    for (const endpoint of made) {
      logger.info(
        `setup made the inbound endpoint ${endpoint.id} (${endpoint.label}); once the vendor posts to it, retire any endpoint it replaces with \`marfa connectors endpoints retire ${connectorId} <endpoint-id>\``,
      );
    }
    if (names.length === 0) return 0;
    const secret = new Set(
      declared
        .filter((setting) => setting.secret === true)
        .map((setting) => setting.name),
    );
    for (const line of settingCommands(plugin, secret, answered)) print(line);
    logger.info(
      `setup made ${names.join(", ")}: run the commands it printed on standard output where \`marfa\` is signed in as the owner, such as by piping them to \`sh\`. They hold the secrets in full, so keep them out of a file or a shared terminal`,
    );
    return 0;
  };
  let succeeded = false;
  try {
    const code = await answeredBySetup();
    succeeded = code === 0;
    return code;
  } finally {
    for (const served of servers) {
      served.release(succeeded);
      served.server.close();
    }
  }
}

async function retire(
  marfa: Marfa,
  connectorId: string,
  made: readonly { id: string }[],
  logger: Logger,
): Promise<void> {
  for (const { id } of made) {
    try {
      await marfa.retireEndpoint(connectorId, id);
      logger.info(`the inbound endpoint ${id} it made was retired`);
    } catch (error) {
      logger.error(
        `the inbound endpoint ${id} it made could not be retired, and still takes deliveries: retire it with \`marfa connectors endpoints retire ${connectorId} ${id}\`: ${describe(error)}`,
      );
    }
  }
}

function serve(
  page: string | ((callback: string) => string) | undefined,
  servers: Served[],
  logger: Logger,
  signal: AbortSignal,
): Promise<LocalCallback> {
  let arrived!: (query: URLSearchParams) => void;
  let stopped!: (reason: Error) => void;
  const redirected = new Promise<URLSearchParams>((resolve, reject) => {
    arrived = resolve;
    stopped = reject;
  });
  let came = false;
  signal.addEventListener("abort", () => {
    stopped(new Error("stopped before the vendor redirected back"));
  });
  // A setup that never waits for the redirect leaves nothing unhandled.
  redirected.catch(() => undefined);
  // Unguessable, so no other local process or page can answer for the vendor.
  const base = `/${randomUUID()}`;
  let shown: string | undefined;
  let held: ServerResponse | undefined;
  const answer = (response: ServerResponse, html: string): void => {
    response
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(html);
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === `${base}/callback` && !came) {
      came = true;
      held = response;
      arrived(url.searchParams);
      return;
    }
    if (url.pathname !== base || shown === undefined) {
      response.writeHead(404).end();
      return;
    }
    answer(response, shown);
  });
  const release = (html: string): void => {
    if (held !== undefined && !held.writableEnded) answer(held, html);
  };
  servers.push({
    server,
    release: (succeeded) => {
      release(succeeded ? done : failed);
    },
  });
  const onward = (address: string): void => {
    const target = URL.parse(address);
    if (target?.protocol !== "https:" && target?.protocol !== "http:") {
      throw new Error("onward sends the browser only to a web address");
    }
    if (held === undefined) {
      throw new Error(
        "onward sends on the browser the vendor sent back, which has not arrived",
      );
    }
    if (held.writableEnded) return;
    held.writeHead(303, { Location: target.toString() }).end();
  };
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // The address the server bound, never `localhost`, which a browser may
    // reach over IPv6 instead.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${String(port)}${base}`;
      const callback = `${url}/callback`;
      try {
        shown = typeof page === "function" ? page(callback) : page;
      } catch (error) {
        server.close();
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      logger.info(`open ${url} in a browser`);
      resolve({ url, callback, redirected, onward });
    });
  });
}
