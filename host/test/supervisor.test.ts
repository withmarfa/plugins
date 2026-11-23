import { existsSync, realpathSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { maxHeapMb, permissionFlags } from "../src/permission-flags.js";
import {
  assigned,
  connectorCode,
  everyFile,
  logOf,
  sha256,
  supervised,
  until,
} from "./helpers.js";

const minute = 60_000;

describe("the connector host's supervisor", () => {
  it("mints a key it holds as mode 600 and starts the connector on it, with the key in no argument, log line or status", async () => {
    const { api, server, step, starts, home, supervisor, lines } = supervised();
    api.connectors = [
      assigned("rss", "0.0.1", server.serve("rss-1", connectorCode())),
    ];
    await step();
    await until(() => starts("rss").length === 1);
    const [started] = starts("rss");
    const key = api.keys[0] ?? "";
    expect(api.keys).toHaveLength(1);
    expect(started?.key).toBe(sha256(key));
    expect(statSync(home.key("rss")).mode & 0o777).toBe(0o600);
    expect(statSync(home.hostKey, { throwIfNoEntry: false })).toBeUndefined();
    const everything = [
      JSON.stringify(started?.args),
      JSON.stringify(started?.execArgv),
      lines.join("\n"),
      JSON.stringify(supervisor.status()),
      everyFile(home.logs),
    ].join("\n");
    expect(everything).not.toContain(key);
    // The witness: the key is there to find, in its own file.
    expect(everyFile(home.connectors)).toContain(key);
  });

  it("starts the connector with the permission model on, reading only its code file", async () => {
    const { api, server, step, starts, home } = supervised();
    const code = server.serve("rss-1", connectorCode());
    api.connectors = [assigned("rss", "0.0.1", code)];
    await step();
    await until(() => starts("rss").length === 1);
    const file = realpathSync(home.codeFile("rss", code.sha256));
    const [started] = starts("rss");
    expect(started?.execArgv).toEqual(permissionFlags(file));
    expect(started?.execArgv).not.toContain("--allow-worker");
    expect(started?.execArgv).toContain(
      `--max-old-space-size=${String(maxHeapMb)}`,
    );
    expect(started?.args).toEqual(["--every", "15m"]);
  });

  it("gives the connector exactly its listed environment", async () => {
    const env = {
      PATH: process.env["PATH"],
      HOME: "/srv/linux/someone",
      TZ: "Europe/London",
      LANG: "en_GB.UTF-8",
      LC_TIME: "en_GB.UTF-8",
      OTEL_SERVICE_NAME: "not-sent",
      SECRET_OF_THE_HOST: "kept",
      NODE_OPTIONS: "--inspect",
    };
    const { api, server, step, starts } = supervised(env);
    api.connectors = [
      assigned("rss", "0.0.1", server.serve("rss-1", connectorCode())),
    ];
    await step();
    await until(() => starts("rss").length === 1);
    const [started] = starts("rss");
    expect(started?.names).toEqual(
      [
        "HOME",
        "LANG",
        "LC_TIME",
        "MARFA_API_KEY",
        "MARFA_API_URL",
        "PATH",
        "TZ",
      ].sort(),
    );
    expect(started?.env["MARFA_API_URL"]).toBe("https://marfa.example.com");
    expect(started?.env["TZ"]).toBe("Europe/London");
  });

  it("passes the telemetry settings only when the host was given an endpoint", async () => {
    const { api, server, step, starts } = supervised({
      PATH: process.env["PATH"],
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com",
      OTEL_SERVICE_NAME: "a-connector",
    });
    api.connectors = [
      assigned("rss", "0.0.1", server.serve("rss-1", connectorCode())),
    ];
    await step();
    await until(() => starts("rss").length === 1);
    expect(starts("rss")[0]?.names).toEqual(
      [
        "MARFA_API_KEY",
        "MARFA_API_URL",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_SERVICE_NAME",
        "PATH",
      ].sort(),
    );
  });

  it("keeps no code whose SHA-256 differs, and the running version stays", async () => {
    const { api, server, step, poll, starts, home, supervisor, lines } =
      supervised();
    const first = server.serve("rss-1", connectorCode());
    api.connectors = [assigned("rss", "0.0.1", first)];
    await step();
    await until(() => starts("rss").length === 1);
    const pid = supervisor.status().connectors[0]?.pid;
    const second = server.serve("rss-2", `${connectorCode()}// two\n`);
    const wrong = { ...second, sha256: sha256("something else") };
    api.connectors = [assigned("rss", "0.0.2", wrong)];
    await poll();
    expect(lines.join("\n")).toContain(
      `has SHA-256 ${second.sha256} where the plugin names ${wrong.sha256}, so it was not kept`,
    );
    expect(existsSync(home.codeFile("rss", wrong.sha256))).toBe(false);
    expect(existsSync(home.codeFile("rss", second.sha256))).toBe(false);
    expect(supervisor.status().connectors[0]).toMatchObject({
      state: "running",
      pid,
    });
    expect(api.keys).toHaveLength(1);
    expect(starts("rss")).toHaveLength(1);
  });

  it("does not start a paused connector, and stops a running one when it is paused", async () => {
    const { api, server, step, poll, starts, supervisor } = supervised();
    const code = server.serve("rss-1", connectorCode());
    const news = server.serve("news-1", connectorCode());
    api.connectors = [
      assigned("rss", "0.0.1", code),
      assigned("news", "0.0.1", news, { paused: true }),
    ];
    await step();
    await until(() => starts("rss").length === 1);
    expect(starts("news")).toHaveLength(0);
    api.connectors = [
      assigned("rss", "0.0.1", code, { paused: true }),
      assigned("news", "0.0.1", news, { paused: true }),
    ];
    await poll();
    expect(supervisor.status().connectors.map((one) => one.state)).toEqual([
      "stopped",
      "stopped",
    ]);
    expect(supervisor.status().connectors[0]?.detail).toBe(
      "paused by the owner",
    );
  });

  it("wakes a running connector with SIGUSR2 for a run request, and starts a waiting one at once", async () => {
    const { api, server, step, starts, home, clock } = supervised();
    const code = server.serve("rss-1", connectorCode());
    const failing = server.serve("news-1", connectorCode({ exit: 1 }));
    api.connectors = [
      assigned("rss", "0.0.1", code),
      assigned("news", "0.0.1", failing),
    ];
    await step();
    await until(
      () => starts("rss").length === 1 && starts("news").length === 1,
    );
    await step();
    clock.advance(1000);
    api.connectors = [
      assigned("rss", "0.0.1", code, {
        run_requested_at: "2026-11-23T09:00:01Z",
      }),
      assigned("news", "0.0.1", failing, {
        run_requested_at: "2026-11-23T09:00:01Z",
      }),
    ];
    // Not yet due for its regular poll, so the clock moves to it.
    clock.advance(minute);
    await step();
    await until(() => logOf(home, "rss").includes("WOKEN"));
    await until(() => starts("news").length === 2);
    // The same request is acted on once.
    clock.advance(minute);
    await step();
    expect(logOf(home, "rss").split("WOKEN")).toHaveLength(2);
  });

  it("stops a connector that leaves the host, and deletes its key and code", async () => {
    const { api, server, step, poll, starts, home, supervisor } = supervised();
    api.connectors = [
      assigned("rss", "0.0.1", server.serve("rss-1", connectorCode())),
    ];
    await step();
    await until(() => starts("rss").length === 1);
    expect(existsSync(home.key("rss"))).toBe(true);
    api.connectors = [];
    await poll();
    await until(() => logOf(home, "rss").includes("TERM"));
    expect(existsSync(home.connector("rss"))).toBe(false);
    expect(supervisor.status().connectors).toEqual([]);
  });

  it("stops every connector and deletes their keys and code when Marfa refuses the host's key", async () => {
    const { api, server, step, poll, starts, home, lines } = supervised();
    api.connectors = [
      assigned("rss", "0.0.1", server.serve("rss-1", connectorCode())),
      assigned("news", "0.0.1", server.serve("news-1", connectorCode())),
    ];
    await step();
    await until(
      () => starts("rss").length === 1 && starts("news").length === 1,
    );
    api.answer = { kind: "unlinked" };
    expect(await poll()).toBe("unlinked");
    expect(logOf(home, "rss")).toContain("TERM");
    expect(logOf(home, "news")).toContain("TERM");
    expect(existsSync(home.connectors)).toBe(false);
    expect(lines.join("\n")).toContain("install with a new link");
  });

  it("keeps the connectors running when Marfa cannot be reached, asking again after growing waits", async () => {
    const { api, server, step, poll, starts, supervisor, clock } = supervised();
    api.connectors = [
      assigned("rss", "0.0.1", server.serve("rss-1", connectorCode())),
    ];
    await step();
    await until(() => starts("rss").length === 1);
    const pid = supervisor.status().connectors[0]?.pid;
    api.answer = { kind: "failed", reason: "connect ECONNREFUSED" };
    await poll();
    const polledAt: number[] = [clock.at];
    for (let second = 0; second < 20 * 60; second++) {
      clock.advance(1000);
      const before = api.polls;
      await step();
      if (api.polls > before) polledAt.push(clock.at);
    }
    const waits = polledAt
      .slice(1)
      .map((at, index) => at - (polledAt[index] ?? 0));
    expect(waits.slice(0, 7)).toEqual(
      [10, 20, 40, 80, 160, 300, 300].map((seconds) => seconds * 1000),
    );
    expect(supervisor.status().connectors[0]).toMatchObject({
      state: "running",
      pid,
    });
    expect(supervisor.status().pollError).toBe("connect ECONNREFUSED");
    // Marfa answering again puts the poll back on its minute.
    api.answer = undefined;
    clock.advance(5 * minute);
    await step();
    const back = api.polls;
    clock.advance(minute);
    await step();
    expect(api.polls).toBe(back + 1);
    expect(supervisor.status().pollError).toBeUndefined();
  });

  it("asks Marfa at once and wakes every connector when the clock jumps, as after sleep", async () => {
    const { api, server, step, starts, home, clock, lines } = supervised();
    api.connectors = [
      assigned("rss", "0.0.1", server.serve("rss-1", connectorCode())),
    ];
    await step();
    await until(() => starts("rss").length === 1);
    clock.advance(30_000);
    await step();
    const polls = api.polls;
    clock.advance(2 * minute + 1);
    await step();
    expect(api.polls).toBe(polls + 1);
    await until(() => logOf(home, "rss").includes("WOKEN"));
    expect(lines.join("\n")).toContain("as after sleep");
  });

  it("mints only when it holds no key, after an exit 3 not already answered by a mint, and for a new version", async () => {
    const { api, server, step, starts, clock, supervisor } = supervised();
    const crash = server.serve("rss-1", connectorCode({ exit: 1 }));
    api.connectors = [assigned("rss", "0.0.1", crash)];
    await step();
    await until(() => starts("rss").length === 1);
    expect(api.keys).toHaveLength(1);
    // A plain restart mints nothing.
    clock.advance(10_000);
    await step();
    await until(() => starts("rss").length === 2);
    expect(api.keys).toHaveLength(1);
    // Exit 3 mints once.
    const refused = server.serve("rss-2", connectorCode({ exit: 3 }));
    api.connectors = [assigned("rss", "0.0.2", refused)];
    clock.advance(minute);
    await step();
    await until(() => starts("rss").length === 4);
    expect(api.keys).toHaveLength(3);
    expect(starts("rss").map((one) => one.key)).toEqual(
      [0, 0, 1, 2].map((at) => sha256(api.keys[at] ?? "")),
    );
    // A second exit 3 on the key just minted for one holds it.
    await until(() => supervisor.status().connectors[0]?.state === "stopped");
    await step();
    clock.advance(60 * minute);
    await step();
    expect(starts("rss")).toHaveLength(4);
    expect(api.keys).toHaveLength(3);
    expect(supervisor.status().connectors[0]?.detail).toContain(
      "refused its key twice",
    );
    // Marfa answering another key for it lets it start again on the key it
    // holds, and a refusal of that is answered by one more mint, as at first.
    api.connectors = [assigned("rss", "0.0.2", refused, { key_minted: true })];
    clock.advance(minute);
    await step();
    await until(() => starts("rss").length === 6);
    await until(() => supervisor.status().connectors[0]?.state === "stopped");
    clock.advance(60 * minute);
    await step();
    expect(starts("rss")).toHaveLength(6);
    expect(api.keys).toHaveLength(4);
    expect(
      starts("rss")
        .slice(4)
        .map((one) => one.key),
    ).toEqual([2, 3].map((at) => sha256(api.keys[at] ?? "")));
  });

  it("does not restart after exit 2 until Marfa holds another version", async () => {
    const { api, server, step, starts, clock } = supervised();
    const wrong = server.serve("rss-1", connectorCode({ exit: 2 }));
    api.connectors = [assigned("rss", "0.0.1", wrong)];
    await step();
    await until(() => starts("rss").length === 1);
    for (let at = 0; at < 5; at++) {
      clock.advance(30 * minute);
      await step();
    }
    expect(starts("rss")).toHaveLength(1);
    api.connectors = [
      assigned("rss", "0.0.2", server.serve("rss-2", connectorCode())),
    ];
    clock.advance(minute);
    await step();
    await until(() => starts("rss").length === 2);
  });

  it("does not restart after exit 4 until the owner asks for a run, and tries again after 30 minutes", async () => {
    const { api, server, step, starts, clock } = supervised();
    const settings = server.serve("rss-1", connectorCode({ exit: 4 }));
    api.connectors = [assigned("rss", "0.0.1", settings)];
    await step();
    await until(() => starts("rss").length === 1);
    await step();
    clock.advance(10 * minute);
    await step();
    expect(starts("rss")).toHaveLength(1);
    api.connectors = [
      assigned("rss", "0.0.1", settings, {
        run_requested_at: "2026-11-23T09:10:00Z",
      }),
    ];
    clock.advance(minute);
    await step();
    await until(() => starts("rss").length === 2);
    await step();
    clock.advance(29 * minute);
    await step();
    expect(starts("rss")).toHaveLength(2);
    clock.advance(2 * minute);
    await step();
    await until(() => starts("rss").length === 3);
  });

  it("restarts after exit 1, and a crash loop waits longer each time", async () => {
    const { api, server, step, starts, clock, supervisor } = supervised();
    api.connectors = [
      assigned(
        "rss",
        "0.0.1",
        server.serve("rss-1", connectorCode({ exit: 1 })),
      ),
    ];
    await step();
    const waits: number[] = [];
    for (let crash = 1; crash <= 4; crash++) {
      await until(() => starts("rss").length === crash);
      await until(
        () => supervisor.status().connectors[0]?.nextStart !== undefined,
      );
      const next = Date.parse(
        supervisor.status().connectors[0]?.nextStart ?? "",
      );
      waits.push(next - clock.at);
      clock.advance(next - clock.at - 1);
      await step();
      expect(starts("rss")).toHaveLength(crash);
      clock.advance(1);
      await step();
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000]);
  });

  it("swaps the code and mints once for a new version, deleting the old code", async () => {
    const { api, server, step, poll, starts, home, supervisor } = supervised();
    const first = server.serve("rss-1", connectorCode());
    api.connectors = [assigned("rss", "0.0.1", first)];
    await step();
    await until(() => starts("rss").length === 1);
    const second = server.serve("rss-2", `${connectorCode()}// two\n`);
    api.connectors = [assigned("rss", "0.0.2", second)];
    await poll();
    await until(() => starts("rss").length === 2);
    expect(logOf(home, "rss")).toContain("TERM");
    expect(api.keys).toHaveLength(2);
    expect(starts("rss")[1]?.key).toBe(sha256(api.keys[1] ?? ""));
    expect(existsSync(home.codeFile("rss", first.sha256))).toBe(false);
    expect(existsSync(home.codeFile("rss", second.sha256))).toBe(true);
    expect(supervisor.status().connectors[0]).toMatchObject({
      state: "running",
      version: "0.0.2",
    });
  });

  it("reports one failed run for a connector that fails before it registers, once per failure", async () => {
    const { api, server, step, starts, clock } = supervised();
    const failing = server.serve(
      "rss-1",
      connectorCode({
        exit: 1,
        error: "could not start: the definition names no types",
      }),
    );
    api.connectors = [assigned("rss", "0.0.1", failing)];
    await step();
    await until(() => starts("rss").length === 1);
    clock.advance(minute);
    await step();
    await until(() => starts("rss").length === 2);
    clock.advance(minute);
    await step();
    expect(api.reports).toHaveLength(1);
    expect(api.reports[0]).toMatchObject({
      plugin: "rss",
      key: api.keys[0],
      readOnlyTypes: ["rss.entry"],
    });
    expect(api.reports[0]?.error).toBe(
      "The connector's process exited 1 (it failed) before it registered: could not start: the definition names no types",
    );
  });

  it("reports nothing for a connector whose key registered", async () => {
    const { api, server, step, starts, clock } = supervised();
    const failing = server.serve("rss-1", connectorCode({ exit: 1 }));
    api.connectors = [
      assigned("rss", "0.0.1", failing, { registration_id: "reg-1" }),
    ];
    await step();
    await until(() => starts("rss").length === 1);
    clock.advance(minute);
    await step();
    clock.advance(minute);
    await step();
    expect(api.reports).toHaveLength(0);
  });

  it("runs nothing for a plugin that carries no code, and says so once", async () => {
    const { api, step, lines, clock, home } = supervised();
    api.connectors = [assigned("rss", "0.0.1", undefined)];
    await step();
    clock.advance(minute);
    await step();
    expect(api.keys).toHaveLength(0);
    expect(
      lines.filter((line) => line.includes("carries no code")),
    ).toHaveLength(1);
    expect(existsSync(home.pluginLog("rss"))).toBe(false);
  });
});
