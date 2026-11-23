import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { MarfaClient } from "@withmarfa/client";
import { bundleConnector } from "../bundle-connectors.ts";
import { fetchNode, readPin } from "../node-pin.ts";
import { runMarfa } from "../release/plugins.ts";
import { check } from "./check.js";
import { rowsOf } from "./connector.js";
import { setSettings } from "./host.js";
import { installerKeyAt, installPlugin } from "./install.js";
import { serveFeeds } from "./rss.js";

const run = promisify(execFile);
// Compiled into scripts/dist/proof/, three folders below the repository.
const root = resolve(import.meta.dirname, "../../..");
const hostMain = join(root, "host", "dist", "main.js");
const pinFile = join(root, "host", "node.json");

/** Waits for `done`, polling each second; the host asks Marfa every minute,
 *  so a change reaches it within about that. */
async function until(
  done: () => boolean | Promise<boolean>,
  said: () => string,
  seconds = 150,
): Promise<void> {
  for (let tries = 0; tries < seconds; tries += 1) {
    if (await done()) return;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 1000));
  }
  throw new Error(said());
}

/** Node at the pinned version, as a host is installed with: this one when it
 *  is the pin, else the pin's own archive, checked as a release checks it. */
async function pinnedNode(work: string): Promise<string> {
  const pin = await readPin(pinFile);
  if (process.version === `v${pin.version}`) return process.execPath;
  const fetched = await fetchNode(
    `${process.platform}-${process.arch}`,
    join(work, "node"),
    pin,
  );
  return fetched.node;
}

/** A certificate for 127.0.0.1 that the host trusts through
 *  `NODE_EXTRA_CA_CERTS`, so the code is fetched over https as a release's
 *  would be. */
async function certificate(
  work: string,
): Promise<{ key: string; cert: string }> {
  const key = join(work, "code-key.pem");
  const cert = join(work, "code-cert.pem");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  return { key, cert };
}

/** Serves one file over https, counting the requests for it. */
async function serveCode(
  tls: { key: string; cert: string },
  code: Buffer,
): Promise<{ url: string; asked: () => number; close: () => Promise<void> }> {
  let asked = 0;
  const server = createServer(
    { key: readFileSync(tls.key), cert: readFileSync(tls.cert) },
    (req, res) => {
      if (req.url !== "/rss.mjs") {
        res.writeHead(404).end();
        return;
      }
      asked += 1;
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(code);
    },
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `https://127.0.0.1:${String((server.address() as AddressInfo).port)}/rss.mjs`,
    asked: () => asked,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}

/** `marfa-connector-host` run as its own process, as an owner runs it. */
class Host {
  private output = "";
  private child: ChildProcess | undefined;
  private exited: Promise<number | null> | undefined;

  constructor(
    private readonly node: string,
    private readonly env: Record<string, string>,
  ) {}

  command(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return run(this.node, [hostMain, ...args], { env: this.env }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      }),
    );
  }

  /** What the service runs. */
  start(): void {
    const child = spawn(this.node, ["--disable-sigusr1", hostMain, "run"], {
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (chunk: Buffer): void => {
      this.output += chunk.toString();
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    this.exited = new Promise((done) => {
      child.once("close", (code) => {
        done(code);
      });
    });
    this.child = child;
  }

  get log(): string {
    return this.output;
  }

  /** The process `status` says runs `plugin`'s connector, if one does. */
  async connectorPid(plugin: string): Promise<number | undefined> {
    const { stdout } = await this.command(["status"]);
    const found = new RegExp(
      `^${plugin} \\S+: running as process (\\d+)`,
      "m",
    ).exec(stdout);
    return found?.[1] === undefined ? undefined : Number(found[1]);
  }

  async stop(): Promise<number | null> {
    if (this.child === undefined || this.exited === undefined) return null;
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill("SIGTERM");
    return this.exited;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The connector host program end to end: an owner makes a host, the program
 * installs from its one-time link and runs, fetches the RSS connector's code
 * over https from the address its plugin names, checks its SHA-256, mints the
 * connector's key and starts it under the permission model; the connector
 * runs and reports. The owner's run now wakes it, pause stops it, and taking
 * the assignment away deletes its key and code. Runs no service.
 */
export async function proveConnectorHost(
  url: string,
  marfa: MarfaClient,
  manager: MarfaClient,
): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "proof-connector-host-"));
  const owner = { MARFA_API_URL: url, MARFA_API_KEY: installerKeyAt(url) };
  const feeds = await serveFeeds();
  let code: Awaited<ReturnType<typeof serveCode>> | undefined;
  let host: Host | undefined;
  try {
    const node = await pinnedNode(work);
    const bundled = await bundleConnector(
      "rss",
      "0.0.1",
      join(work, "bundle"),
      await readPin(pinFile),
      root,
    );
    const bytes = await readFile(bundled.file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const tls = await certificate(work);
    code = await serveCode(tls, bytes);
    const codeUrl = code.url;
    await installPlugin(url, "rss", undefined, {
      edit: async (folder) => {
        const file = join(folder, "plugin.json");
        const plugin = JSON.parse(await readFile(file, "utf8")) as {
          connector: Record<string, unknown>;
        };
        plugin.connector["code"] = {
          url: codeUrl,
          sha256,
          size: bytes.length,
        };
        await writeFile(file, JSON.stringify(plugin, null, 2));
      },
    });
    await setSettings(url, "rss", { rss_feeds: `${feeds.url}/atom.xml` });
    const made = await manager.POST("/connector-hosts", {
      body: { name: "proof machine" },
    });
    if (made.data === undefined)
      throw new Error(`the host was refused: ${JSON.stringify(made.error)}`);
    const link = made.data.link;
    const hostId = made.data.host.id;
    const home = join(work, "home");
    host = new Host(node, {
      PATH: process.env["PATH"] ?? "",
      HOME: work,
      MARFA_CONNECTOR_HOST_HOME: home,
      NODE_EXTRA_CA_CERTS: tls.cert,
    });
    const running = host;

    await check(
      "connector-host: install redeems the one-time link with no service, keeps the host's key as mode 600 and prints it nowhere, and the same link again is refused and changes nothing",
      async () => {
        const first = await running.command(["install", link, "--no-service"]);
        const keyFile = join(home, "host.key");
        if (first.code !== 0 || !existsSync(keyFile))
          throw new Error(
            `install exited ${String(first.code)}: ${first.stderr}`,
          );
        const key = readFileSync(keyFile, "utf8");
        const mode = statSync(keyFile).mode & 0o777;
        const again = await running.command(["install", link, "--no-service"]);
        const printed =
          first.stdout + first.stderr + again.stdout + again.stderr;
        if (
          mode !== 0o600 ||
          printed.includes(key) ||
          again.code !== 1 ||
          readFileSync(keyFile, "utf8") !== key
        )
          throw new Error(
            `mode ${mode.toString(8)}, second install exited ${String(again.code)}: ${again.stderr}`,
          );
        return `host.key mode ${mode.toString(8)}; the same link again exited ${String(again.code)}: ${again.stderr.trim()}`;
      },
    );

    const assigned = await manager.PUT("/plugins/{name}/connector", {
      params: { path: { name: "rss" } },
      body: { host: hostId },
    });
    if (assigned.data === undefined)
      throw new Error(
        `assigning rss was refused: ${JSON.stringify(assigned.error)}`,
      );
    const control = async () => {
      const { data, error } = await manager.GET("/plugins/{name}/connector", {
        params: { path: { name: "rss" } },
      });
      if (data === undefined)
        throw new Error(`the control door refused: ${JSON.stringify(error)}`);
      return data;
    };
    const lastRun = async () => {
      const id = (await control()).registration;
      if (id === null) return undefined;
      const { data } = await manager.GET("/connectors");
      return data?.data.find((one) => one.id === id)?.last_run ?? undefined;
    };
    running.start();
    let pid: number | undefined;

    await check(
      "connector-host: run fetches the plugin's code over https, keeps it only once its SHA-256 matches, mints the connector's key and starts it under the permission model with the key in its environment only, and the connector's run is reported",
      async () => {
        await until(
          async () => (await lastRun())?.outcome === "succeeded",
          () => `no run was reported:\n${running.log}`,
        );
        // The host writes its status once a second, so it can trail the run.
        await until(
          async () => (pid = await running.connectorPid("rss")) !== undefined,
          () => `status names no process:\n${running.log}`,
          10,
        );
        if (pid === undefined) throw new Error("status names no process");
        const { stdout: args } = await run("ps", [
          "-o",
          "command=",
          "-p",
          String(pid),
        ]);
        const cached = join(home, "connectors", "rss", "code", `${sha256}.mjs`);
        const key = join(home, "connectors", "rss", "key");
        const rows = await rowsOf(marfa, "rss.entry", "rss");
        const flags = [
          "--permission",
          `--allow-fs-read=${cached}`,
          "--allow-net",
          "--allow-worker",
        ];
        const missing = flags.filter((flag) => !args.includes(flag));
        if (
          missing.length > 0 ||
          args.includes("marfa_") ||
          !existsSync(cached) ||
          (statSync(key).mode & 0o777) !== 0o600 ||
          code?.asked() !== 1 ||
          rows.size === 0
        )
          throw new Error(
            `missing ${missing.join(", ")}; fetched ${String(code?.asked())} times; ${String(rows.size)} rows; ${args}`,
          );
        return `fetched once and kept as ${sha256.slice(0, 12)}….mjs; process ${String(pid)} started with ${flags.join(" ").replace(cached, "<code>")}; ${String(rows.size)} rows written`;
      },
    );

    await check(
      "connector-host: the owner's run now reaches the host at its next poll, which wakes the running connector with SIGUSR2, and the run clears the request",
      async () => {
        const before = await lastRun();
        const asked = await runMarfa(["plugins", "run", "rss"], {
          env: owner,
        });
        if (asked.code !== 0)
          throw new Error(`marfa plugins run exited ${String(asked.code)}`);
        await until(
          async () =>
            (await control()).run_requested_at === null &&
            (await lastRun())?.finished_at !== before?.finished_at,
          () => `the request was never cleared:\n${running.log}`,
        );
        const now = await running.connectorPid("rss");
        if (now !== pid || !running.log.includes("so it was woken"))
          throw new Error(
            `process ${String(now)} after ${String(pid)}:\n${running.log}`,
          );
        return `process ${String(pid)} was woken and ran; the request was cleared by its report`;
      },
    );

    await check(
      "connector-host: pausing the connector stops its process, and status says the owner paused it",
      async () => {
        const paused = await runMarfa(["plugins", "pause", "rss"], {
          env: owner,
        });
        if (paused.code !== 0)
          throw new Error(`marfa plugins pause exited ${String(paused.code)}`);
        await until(
          async () =>
            pid !== undefined &&
            !alive(pid) &&
            (await running.command(["status"])).stdout.includes(
              ": paused by the owner",
            ),
          () => `the connector was not stopped:\n${running.log}`,
        );
        return `process ${String(pid)} stopped; status says paused by the owner`;
      },
    );

    await check(
      "connector-host: taking the connector off the host deletes its key and code there",
      async () => {
        const off = await manager.PUT("/plugins/{name}/connector", {
          params: { path: { name: "rss" } },
          body: { host: null },
        });
        if (off.data === undefined)
          throw new Error(
            `unassigning was refused: ${JSON.stringify(off.error)}`,
          );
        const folder = join(home, "connectors", "rss");
        await until(
          () => !existsSync(folder),
          () => `the connector's folder is still there:\n${running.log}`,
        );
        const exit = await running.stop();
        if (exit !== 0)
          throw new Error(`the host exited ${String(exit)} on SIGTERM`);
        return `connectors/rss deleted; the host exited ${String(exit)} on SIGTERM`;
      },
    );
  } finally {
    await host?.stop();
    await code?.close();
    await feeds.close();
    await rm(work, { recursive: true, force: true });
  }
}
