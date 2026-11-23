import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
import { marfaAnswer, scratch, until } from "./helpers.js";

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

/** A service that records what it was asked, and loads nothing. */
function recordingService(folder: string): Service & { calls: string[] } {
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
    remove() {
      calls.push("remove");
    },
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

  it("says what it removes, then removes the service and the whole folder", async () => {
    const home = await linked();
    writeSecret(home.key("rss"), "marfa_k1_rss");
    const service = recordingService(scratch());
    writeFileSync(service.file, "service");
    expect(uninstallPlan(home, service)).toEqual([
      `the service, ${service.file}`,
      `the host's folder, with its key, its connectors' keys, their code and the logs: ${home.root}`,
    ]);
    uninstall(home, service);
    expect(service.calls).toEqual(["remove"]);
    expect(existsSync(home.root)).toBe(false);
    expect(uninstallPlan(home, undefined)).toEqual([]);
    expect(readdirSync(join(home.root, ".."))).toEqual([]);
  });
});
