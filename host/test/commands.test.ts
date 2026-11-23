import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandLink,
  install,
  logs,
  Refused,
  run,
  status,
  uninstall,
  uninstallPlan,
  type Io,
} from "../src/commands.js";
import { writeSecret } from "../src/files.js";
import { Home } from "../src/home.js";
import { LinkRefused } from "../src/link.js";
import { takeLock } from "../src/lock.js";
import { RedeemRefused } from "../src/marfa.js";
import type { Service } from "../src/service.js";
import { assigned, marfaAnswer, scratch, until } from "./helpers.js";

function printed(): Io & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  };
}

const redeemed = (key = "marfa_k1_host_secret") =>
  marfaAnswer(201, {
    host: { id: "host-1", name: "Studio Mac" },
    key,
    key_id: "key-1",
  });

/** A folder that does not exist yet, as before a first install. */
function freshHome(): Home {
  return new Home(join(scratch(), "Connector Host"));
}

/** A service that records what it was asked, and loads nothing. Its
 *  process is `pid`, and stopping it runs `stopped`. */
function recordingService(
  folder: string,
  pid?: number,
  stopped: () => void = () => undefined,
): Service & { calls: string[] } {
  const calls: string[] = [];
  const file = join(folder, "so.marfa.connector-host.plist");
  return {
    calls,
    file,
    install(program) {
      calls.push(`install ${program.args.join(" ")}`);
      writeFileSync(file, "service");
      return [];
    },
    stop() {
      calls.push("stop");
      stopped();
    },
    start() {
      calls.push("start");
    },
    remove() {
      calls.push("remove");
      stopped();
      rmSync(file, { force: true });
    },
    pid() {
      return pid;
    },
  };
}

/** A monotonic clock that moves ten seconds each time it is read, so a wait
 *  for the folder runs out after a few tries. */
function leaping(): { monotonic: () => number } {
  let at = 0;
  return { monotonic: () => (at += 10_000) };
}

/** Holds the folder's run lock as a running `run` does, in this process. */
function holdLock(home: Home): () => void {
  mkdirSync(home.root, { recursive: true });
  const taken = takeLock(home.lock);
  if (!("lock" in taken)) throw new Error("the lock is held");
  return () => {
    taken.lock.release();
  };
}

describe("installing the connector host", () => {
  it.each([
    ["not a link", LinkRefused],
    ["http://marfa.example.com/connect#code", LinkRefused],
  ])("writes nothing for %s", async (link, refusal) => {
    const home = freshHome();
    let asked = 0;
    const send: typeof fetch = () => {
      asked += 1;
      return Promise.resolve(redeemed());
    };
    await expect(
      install(home, link, printed(), undefined, send),
    ).rejects.toThrow(refusal);
    expect(asked).toBe(0);
    expect(existsSync(home.root)).toBe(false);
  });

  it("writes nothing for a link Marfa refuses as used or expired", async () => {
    const home = freshHome();
    const send: typeof fetch = () =>
      Promise.resolve(marfaAnswer(404, { code: "connector_link_not_found" }));
    await expect(
      install(
        home,
        "https://marfa.example.com/connect#old",
        printed(),
        undefined,
        send,
      ),
    ).rejects.toThrow(RedeemRefused);
    expect(existsSync(home.root)).toBe(false);
  });

  it("keeps the instance and identity, and the key as mode 600 in a file of its own", async () => {
    const home = freshHome();
    const io = printed();
    const service = recordingService(scratch());
    await install(
      home,
      "https://marfa.example.com/connect#code",
      io,
      {
        service,
        program: {
          args: ["/node", "--disable-sigusr1", "/main.js"],
          home: undefined,
        },
      },
      () => Promise.resolve(redeemed()),
    );
    expect(JSON.parse(readFileSync(home.hostJson, "utf8"))).toEqual({
      origin: "https://marfa.example.com",
      id: "host-1",
      name: "Studio Mac",
    });
    expect(readFileSync(home.hostKey, "utf8")).toBe("marfa_k1_host_secret");
    expect(statSync(home.hostKey).mode & 0o777).toBe(0o600);
    expect(readFileSync(home.hostJson, "utf8")).not.toContain(
      "marfa_k1_host_secret",
    );
    expect(io.lines.join("\n")).not.toContain("marfa_k1_host_secret");
    expect(service.calls).toEqual(["install /node --disable-sigusr1 /main.js"]);
  });

  it("replaces the identity on a new link and deletes every connector's key and code", async () => {
    const home = freshHome();
    await install(
      home,
      "https://marfa.example.com/connect#one",
      printed(),
      undefined,
      () => Promise.resolve(redeemed("marfa_k1_first")),
    );
    writeSecret(home.key("rss"), "marfa_k1_rss");
    mkdirSync(home.code("rss"), { recursive: true });
    writeFileSync(home.codeFile("rss", "a".repeat(64)), "code");
    await install(
      home,
      "https://marfa.example.com/connect#two",
      printed(),
      undefined,
      () => Promise.resolve(redeemed("marfa_k1_second")),
    );
    expect(readFileSync(home.hostKey, "utf8")).toBe("marfa_k1_second");
    expect(existsSync(home.connectors)).toBe(false);
  });

  it("refuses while a run it would not stop uses the folder, and redeems nothing", async () => {
    const home = await linked();
    writeSecret(home.key("rss"), "marfa_k1_rss");
    const release = holdLock(home);
    let asked = 0;
    const send: typeof fetch = () => {
      asked += 1;
      return Promise.resolve(redeemed("marfa_k1_second"));
    };
    const elsewhere = recordingService(scratch(), process.pid + 1);
    for (const service of [
      undefined,
      { service: elsewhere, program: { args: ["/node"], home: undefined } },
    ])
      await expect(
        install(
          home,
          "https://marfa.example.com/connect#two",
          printed(),
          service,
          send,
        ),
      ).rejects.toThrow("Stop the running host first");
    expect(asked).toBe(0);
    expect(elsewhere.calls).toEqual([]);
    expect(readFileSync(home.hostKey, "utf8")).toBe("marfa_k1_host_secret");
    expect(readFileSync(home.key("rss"), "utf8")).toBe("marfa_k1_rss");
    release();
  });

  it("stops the service's own run before it writes the new identity", async () => {
    const home = await linked();
    writeSecret(home.key("rss"), "marfa_k1_rss");
    const release = holdLock(home);
    let keyWhenStopped: string | undefined;
    const service = recordingService(scratch(), process.pid, () => {
      keyWhenStopped = readFileSync(home.hostKey, "utf8");
      release();
    });
    await install(
      home,
      "https://marfa.example.com/connect#two",
      printed(),
      { service, program: { args: ["/node"], home: undefined } },
      () => {
        service.calls.push("redeem");
        return Promise.resolve(redeemed("marfa_k1_second"));
      },
    );
    expect(service.calls).toEqual(["stop", "redeem", "install /node"]);
    expect(keyWhenStopped).toBe("marfa_k1_host_secret");
    expect(readFileSync(home.hostKey, "utf8")).toBe("marfa_k1_second");
    expect(existsSync(home.connectors)).toBe(false);
  });

  it("redeems nothing and starts the service again when its run does not stop, or the link is refused", async () => {
    const home = await linked();
    writeSecret(home.key("rss"), "marfa_k1_rss");
    const release = holdLock(home);
    const service = recordingService(scratch(), process.pid);
    writeFileSync(service.file, "service");
    let asked = 0;
    const send: typeof fetch = () => {
      asked += 1;
      return Promise.resolve(redeemed("marfa_k1_second"));
    };
    const target = { service, program: { args: ["/node"], home: undefined } };
    await expect(
      install(
        home,
        "https://marfa.example.com/connect#two",
        printed(),
        target,
        send,
        leaping(),
      ),
    ).rejects.toThrow(
      `Stop the running host first: marfa-connector-host run, process ${String(process.pid)}, still uses ${home.root}. Once it has stopped, run marfa-connector-host install again with the same link, which was not used.`,
    );
    expect(asked).toBe(0);
    expect(service.calls).toEqual(["stop", "start"]);
    expect(readFileSync(home.hostKey, "utf8")).toBe("marfa_k1_host_secret");
    expect(readFileSync(home.key("rss"), "utf8")).toBe("marfa_k1_rss");
    expect(takeLock(home.lock)).toEqual({ holder: process.pid });
    release();
    // Refused by Marfa once the lock is free: the service starts again too.
    await expect(
      install(
        home,
        "https://marfa.example.com/connect#two",
        printed(),
        target,
        () =>
          Promise.resolve(
            marfaAnswer(404, { code: "connector_link_not_found" }),
          ),
      ),
    ).rejects.toThrow(RedeemRefused);
    expect(service.calls).toEqual(["stop", "start", "stop", "start"]);
    expect(readFileSync(home.hostKey, "utf8")).toBe("marfa_k1_host_secret");
    expect(existsSync(home.lock)).toBe(false);
    // The witness: with the lock free, the link is redeemed.
    await install(
      home,
      "https://marfa.example.com/connect#two",
      printed(),
      target,
      send,
    );
    expect(asked).toBe(1);
    expect(readFileSync(home.hostKey, "utf8")).toBe("marfa_k1_second");
  });

  it("keeps the old identity and connectors when a new link is refused", async () => {
    const home = freshHome();
    await install(
      home,
      "https://marfa.example.com/connect#one",
      printed(),
      undefined,
      () => Promise.resolve(redeemed("marfa_k1_first")),
    );
    writeSecret(home.key("rss"), "marfa_k1_rss");
    await expect(
      install(
        home,
        "https://marfa.example.com/connect#two",
        printed(),
        undefined,
        () =>
          Promise.resolve(
            marfaAnswer(404, { code: "connector_link_not_found" }),
          ),
      ),
    ).rejects.toThrow(RedeemRefused);
    expect(readFileSync(home.hostKey, "utf8")).toBe("marfa_k1_first");
    expect(readFileSync(home.key("rss"), "utf8")).toBe("marfa_k1_rss");
  });

  it("keeps updates turned off when it links again", async () => {
    const home = freshHome();
    mkdirSync(home.root, { recursive: true });
    writeFileSync(
      home.hostJson,
      `${JSON.stringify({ origin: "https://old.example", id: "old", name: "Old", updates: false }, null, 2)}\n`,
    );
    await install(
      home,
      "https://marfa.example.com/connect#code",
      printed(),
      undefined,
      () => Promise.resolve(redeemed()),
    );
    expect(JSON.parse(readFileSync(home.hostJson, "utf8"))).toEqual({
      origin: "https://marfa.example.com",
      id: "host-1",
      name: "Studio Mac",
      updates: false,
    });
  });

  it("links again when host.json is not JSON, and leaves updates on", async () => {
    const home = freshHome();
    mkdirSync(home.root, { recursive: true });
    writeFileSync(home.hostJson, "{");
    await install(
      home,
      "https://marfa.example.com/connect#code",
      printed(),
      undefined,
      () => Promise.resolve(redeemed()),
    );
    expect(JSON.parse(readFileSync(home.hostJson, "utf8"))).toEqual({
      origin: "https://marfa.example.com",
      id: "host-1",
      name: "Studio Mac",
    });
  });
});

/** A linked host's folder. */
async function linked(): Promise<Home> {
  const home = freshHome();
  await install(
    home,
    "https://marfa.example.com/connect#code",
    printed(),
    undefined,
    () => Promise.resolve(redeemed()),
  );
  return home;
}

describe("running the connector host", () => {
  it("refuses to run before it is linked", async () => {
    await expect(
      run({
        home: freshHome(),
        env: {},
        execPath: process.execPath,
        stopped: new Promise(() => undefined),
      }),
    ).rejects.toThrow("not linked yet");
  });

  it("refuses a second run on one folder", async () => {
    const home = await linked();
    let stop = (): void => undefined;
    const first = run({
      home,
      env: {},
      execPath: process.execPath,
      stopped: new Promise((done) => {
        stop = done;
      }),
      send: () =>
        Promise.resolve(
          marfaAnswer(200, {
            id: "host-1",
            name: "Studio Mac",
            connectors: [],
          }),
        ),
      tickMs: 10,
    });
    await until(() => existsSync(home.status));
    const second = run({
      home,
      env: {},
      execPath: process.execPath,
      stopped: new Promise(() => undefined),
    });
    await expect(second).rejects.toThrow(Refused);
    await expect(second).rejects.toThrow(
      `Another marfa-connector-host run, process ${String(process.pid)}, already uses`,
    );
    stop();
    await expect(first).resolves.toBe(0);
    expect(existsSync(home.lock)).toBe(false);
  });

  it("ends its process promptly when stopped while a connector's code is being fetched", async () => {
    const home = freshHome();
    const tls = scratch();
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(tls, "key.pem"),
        "-out",
        join(tls, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    // Code that starts to arrive and then never ends.
    let reached = false;
    const silent = createHttpsServer(
      {
        key: readFileSync(join(tls, "key.pem")),
        cert: readFileSync(join(tls, "cert.pem")),
      },
      (_request, response) => {
        reached = true;
        response.writeHead(200, { "Content-Type": "text/javascript" });
        response.write("// the first bytes\n");
      },
    );
    await new Promise<void>((done) => silent.listen(0, "127.0.0.1", done));
    const codePort = (silent.address() as AddressInfo).port;
    const marfa = createHttpServer((request, response) => {
      const answer = marfaAnswer(200, {
        id: "host-1",
        name: "Studio Mac",
        connectors: [
          assigned("rss", "0.0.1", {
            url: `https://127.0.0.1:${String(codePort)}/rss.mjs`,
            sha256: "a".repeat(64),
            size: 100,
          }),
        ],
      });
      response.writeHead(
        request.url === "/connector-hosts/self" ? 200 : 404,
        Object.fromEntries(answer.headers),
      );
      void answer.text().then((text) => response.end(text));
    });
    await new Promise<void>((done) => marfa.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${String((marfa.address() as AddressInfo).port)}`;
    try {
      mkdirSync(home.root, { recursive: true });
      writeFileSync(
        home.hostJson,
        JSON.stringify({ origin, id: "host-1", name: "Studio Mac" }),
      );
      writeSecret(home.hostKey, "marfa_k1_host_secret");
      const child = spawn(
        process.execPath,
        [resolve(import.meta.dirname, "../dist/main.js"), "run"],
        {
          env: {
            PATH: process.env["PATH"],
            MARFA_CONNECTOR_HOST_HOME: home.root,
            NODE_EXTRA_CA_CERTS: join(tls, "cert.pem"),
          },
          stdio: "ignore",
        },
      );
      const exited = new Promise<number | null>((done) =>
        child.once("exit", (code) => {
          done(code);
        }),
      );
      await until(() => reached, "the host never asked for the code");
      child.kill("SIGTERM");
      const ended = await Promise.race([
        exited,
        new Promise<"still running">((done) =>
          setTimeout(() => {
            done("still running");
          }, 15_000),
        ),
      ]);
      if (ended === "still running") child.kill("SIGKILL");
      expect(ended).toBe(0);
    } finally {
      silent.close();
      silent.closeAllConnections();
      marfa.close();
      marfa.closeAllConnections();
    }
  });

  it("exits 0 and deletes every connector's key once Marfa refuses the host's key", async () => {
    const home = await linked();
    writeSecret(home.key("rss"), "marfa_k1_rss");
    const exit = await run({
      home,
      env: {},
      execPath: process.execPath,
      stopped: new Promise(() => undefined),
      send: () => Promise.resolve(marfaAnswer(401, { code: "unauthorized" })),
      tickMs: 10,
    });
    expect(exit).toBe(0);
    expect(existsSync(home.connectors)).toBe(false);
    expect(readFileSync(home.hostLog, "utf8")).toContain(
      "install with a new link: marfa-connector-host install '<link>'",
    );
  });
});

describe("the connector host's status, logs and uninstall", () => {
  it("says the host is not running, and prints no key", async () => {
    const home = await linked();
    const io = printed();
    status(home, io, undefined);
    expect(io.lines).toEqual([
      'Host "Studio Mac" (host-1) for https://marfa.example.com',
      `Files: ${home.root}`,
      "Not running.",
    ]);
  });

  it("prints what a running host wrote of each connector, and no key", async () => {
    const home = await linked();
    writeFileSync(
      home.status,
      JSON.stringify({
        pid: process.pid,
        polledAt: "2026-11-23T09:00:00.000Z",
        connectors: [
          {
            plugin: "rss",
            version: "0.0.1",
            state: "running",
            detail: "running",
            pid: 4242,
            since: "2026-11-23T08:59:00.000Z",
          },
          {
            plugin: "github",
            version: "0.0.3",
            state: "stopped",
            detail: "waiting to start again",
            lastExit: "exited 1 (it failed) at 2026-11-23T08:59:30.000Z",
            nextStart: "2026-11-23T09:00:10.000Z",
          },
        ],
      }),
    );
    const taken = takeLock(home.lock);
    const io = printed();
    status(home, io, undefined);
    if ("lock" in taken) taken.lock.release();
    expect(io.lines.slice(2)).toEqual([
      `Running as process ${String(process.pid)}.`,
      "Last asked Marfa at 2026-11-23T09:00:00.000Z.",
      "rss 0.0.1: running as process 4242 since 2026-11-23T08:59:00.000Z",
      "github 0.0.3: waiting to start again",
      "  last exit: exited 1 (it failed) at 2026-11-23T08:59:30.000Z",
      "  next start: 2026-11-23T09:00:10.000Z",
    ]);
    expect(io.lines.join("\n")).not.toContain("marfa_k1");
  });

  it("prints the host's log or one connector's", async () => {
    const home = await linked();
    const io = printed();
    logs(home, "rss", io);
    expect(io.lines).toEqual(["rss has written no log yet."]);
    mkdirSync(home.logs, { recursive: true });
    writeFileSync(home.pluginLog("rss"), "one\ntwo\n");
    logs(home, "rss", io);
    expect(io.lines.at(-1)).toBe("one\ntwo");
  });

  it("refuses to uninstall while a run the service does not own uses the folder", async () => {
    const home = await linked();
    const release = holdLock(home);
    const service = recordingService(scratch(), process.pid + 1);
    for (const one of [undefined, service])
      await expect(uninstall(home, one)).rejects.toThrow(
        "Stop the running host first",
      );
    expect(service.calls).toEqual([]);
    expect(existsSync(home.hostKey)).toBe(true);
    release();
    // The witness: once it has stopped, the folder goes.
    await uninstall(home, service);
    expect(existsSync(home.root)).toBe(false);
  });

  it("removes nothing when the service's own run does not stop, and says what to run", async () => {
    const home = await linked();
    const release = holdLock(home);
    const service = recordingService(scratch(), process.pid);
    writeFileSync(service.file, "service");
    await expect(uninstall(home, service, leaping())).rejects.toThrow(
      `Stop the running host first: marfa-connector-host run, process ${String(process.pid)}, still uses ${home.root}. Once it has stopped, run marfa-connector-host uninstall again.`,
    );
    expect(service.calls).toEqual(["stop"]);
    expect(existsSync(service.file)).toBe(true);
    expect(existsSync(home.hostKey)).toBe(true);
    release();
  });

  it("stops the service's own run, then removes the folder", async () => {
    const home = await linked();
    const release = holdLock(home);
    const service = recordingService(scratch(), process.pid, release);
    await uninstall(home, service);
    expect(service.calls).toEqual(["stop", "remove"]);
    expect(existsSync(home.root)).toBe(false);
  });

  it("says what it removes, then removes the service and the whole folder", async () => {
    const home = await linked();
    writeSecret(home.key("rss"), "marfa_k1_rss");
    const service = recordingService(scratch());
    writeFileSync(service.file, "service");
    expect(uninstallPlan(home, service)).toEqual([
      `the service, ${service.file}`,
      `the host's folder, with its key, its connectors' keys, their code and the logs: ${home.root}`,
    ]);
    await uninstall(home, service);
    expect(service.calls).toEqual(["stop", "remove"]);
    expect(existsSync(home.root)).toBe(false);
    expect(uninstallPlan(home, undefined)).toEqual([]);
    expect(readdirSync(join(home.root, ".."))).toEqual([]);
  });

  it("removes the command only when it points inside this install", async () => {
    const home = await linked();
    const userHome = scratch();
    mkdirSync(join(userHome, ".local", "bin"), { recursive: true });
    const link = commandLink(userHome);
    symlinkSync(join(home.root, "bin", "marfa-connector-host"), link);
    expect(uninstallPlan(home, undefined, userHome)).toEqual([
      `the command, ${link}`,
      `the host's folder, with its key, its connectors' keys, their code and the logs: ${home.root}`,
    ]);
    await uninstall(home, undefined, {}, userHome);
    expect(() => readlinkSync(link)).toThrow();

    const other = await linked();
    const outside = join(scratch(), "marfa-connector-host");
    symlinkSync(outside, link);
    expect(uninstallPlan(other, undefined, userHome)).toEqual([
      `the host's folder, with its key, its connectors' keys, their code and the logs: ${other.root}`,
    ]);
    await uninstall(other, undefined, {}, userHome);
    expect(readlinkSync(link)).toBe(outside);
    expect(existsSync(other.root)).toBe(false);
  });
});
