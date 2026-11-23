import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  launchAgent,
  ServiceRefused,
  serviceFor,
  systemdService,
} from "../src/service.js";
import { scratch } from "./helpers.js";

const program = {
  args: [
    "/opt/Marfa Host/node",
    "--disable-sigusr1",
    "/opt/Marfa Host/main.js",
  ],
  home: undefined,
};

describe("the connector host's service", () => {
  it("is a LaunchAgent that starts at load, restarts only after a failure and runs in the background", () => {
    expect(launchAgent(program)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>so.marfa.connector-host</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/Marfa Host/node</string>
    <string>--disable-sigusr1</string>
    <string>/opt/Marfa Host/main.js</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ExitTimeOut</key>
  <integer>70</integer>
</dict>
</plist>
`);
  });

  it("names a chosen folder in the LaunchAgent, escaped", () => {
    expect(launchAgent({ ...program, home: "/srv/a&b" }))
      .toContain(`  <key>EnvironmentVariables</key>
  <dict>
    <key>MARFA_CONNECTOR_HOST_HOME</key>
    <string>/srv/a&amp;b</string>
  </dict>`);
  });

  it("is a systemd user unit that restarts on failure, every argument quoted", () => {
    expect(systemdService({ ...program, home: "/srv/50%" })).toBe(`[Unit]
Description=Marfa connector host
After=network-online.target

[Service]
ExecStart="/opt/Marfa Host/node" "--disable-sigusr1" "/opt/Marfa Host/main.js" "run"
Environment="MARFA_CONNECTOR_HOST_HOME=/srv/50%%"
Restart=on-failure
KillMode=mixed
TimeoutStopSec=70

[Install]
WantedBy=default.target
`);
  });

  it("loads the LaunchAgent with launchctl bootstrap in the user's GUI domain", () => {
    const home = scratch();
    const ran: string[] = [];
    const service = serviceFor("darwin", {}, home, 501, (file, args) => {
      ran.push([file, ...args].join(" "));
      return "";
    });
    const file = join(
      home,
      "Library",
      "LaunchAgents",
      "so.marfa.connector-host.plist",
    );
    expect(service?.file).toBe(file);
    expect(service?.install(program)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(launchAgent(program));
    expect(ran).toEqual([
      "launchctl bootout gui/501/so.marfa.connector-host",
      `launchctl bootstrap gui/501 ${file}`,
    ]);
    service?.remove();
    expect(existsSync(file)).toBe(false);
  });

  it("enables the systemd unit and prints the linger line rather than running it", () => {
    const home = scratch();
    const ran: string[] = [];
    const service = serviceFor("linux", {}, home, 1000, (file, args) => {
      ran.push([file, ...args].join(" "));
      return "";
    });
    const file = join(
      home,
      ".config",
      "systemd",
      "user",
      "marfa-connector-host.service",
    );
    expect(service?.file).toBe(file);
    expect(service?.install(program)).toEqual([
      "To keep the host running while you are logged out, run:",
      '  loginctl enable-linger "$USER"',
    ]);
    expect(ran).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable marfa-connector-host.service",
      "systemctl --user restart marfa-connector-host.service",
    ]);
    expect(serviceFor("win32", {}, home, 0)).toBeUndefined();
  });

  it("tries launchctl bootstrap again when it fails just after bootout", () => {
    const home = scratch();
    const ran: string[] = [];
    let failures = 2;
    const waits: number[] = [];
    const service = serviceFor(
      "darwin",
      {},
      home,
      501,
      (file, args) => {
        ran.push(args[0] ?? "");
        if (args[0] === "bootstrap" && failures-- > 0)
          throw new Error("Bootstrap failed: 5: Input/output error");
        return "";
      },
      (ms) => waits.push(ms),
    );
    service?.install(program);
    expect(ran).toEqual(["bootout", "bootstrap", "bootstrap", "bootstrap"]);
    expect(waits).toHaveLength(2);
  });

  it("names the command to run in one line when launchctl bootstrap keeps failing", () => {
    const home = scratch();
    const file = join(
      home,
      "Library",
      "LaunchAgents",
      "so.marfa.connector-host.plist",
    );
    const service = serviceFor(
      "darwin",
      {},
      home,
      501,
      (_file, args) => {
        if (args[0] === "bootstrap")
          throw new Error("Bootstrap failed: 5: Input/output error");
        return "";
      },
      () => undefined,
    );
    let refusal: unknown;
    try {
      service?.install(program);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ServiceRefused);
    expect((refusal as Error).message).toBe(
      `The service is written but launchd did not load it. Run: launchctl bootstrap gui/501 '${file}'`,
    );
  });

  it("starts a stopped service again from its file, naming the command when it cannot", () => {
    const home = scratch();
    const ran: string[] = [];
    const failing = { darwin: 1, linux: 0 };
    const exec =
      (platform: "darwin" | "linux") =>
      (file: string, args: string[]): string => {
        ran.push(`${file} ${args.join(" ")}`);
        if (failing[platform]-- > 0) throw new Error("failed");
        return "";
      };
    serviceFor(
      "darwin",
      {},
      home,
      501,
      exec("darwin"),
      () => undefined,
    )?.start();
    const file = join(
      home,
      "Library",
      "LaunchAgents",
      "so.marfa.connector-host.plist",
    );
    expect(ran).toEqual([
      `launchctl bootstrap gui/501 ${file}`,
      `launchctl bootstrap gui/501 ${file}`,
    ]);
    ran.length = 0;
    serviceFor("linux", {}, home, 1000, exec("linux"))?.start();
    expect(ran).toEqual([
      "systemctl --user start marfa-connector-host.service",
    ]);
    failing.linux = 1;
    expect(() =>
      serviceFor("linux", {}, home, 1000, exec("linux"))?.start(),
    ).toThrow(
      "systemd did not start the service again. Run: systemctl --user start marfa-connector-host.service",
    );
    failing.darwin = 5;
    expect(() =>
      serviceFor(
        "darwin",
        {},
        home,
        501,
        exec("darwin"),
        () => undefined,
      )?.start(),
    ).toThrow(
      `launchd did not load the service again. Run: launchctl bootstrap gui/501 '${file}'`,
    );
  });

  it("names the process the service runs, or none", () => {
    const home = scratch();
    const answers: Record<string, string> = {
      launchctl:
        "gui/501/so.marfa.connector-host = {\n\tactive count = 1\n\tpid = 4242\n\tstate = running\n}\n",
      systemctl: "4343\n",
    };
    const answering = (file: string): string => answers[file] ?? "";
    expect(serviceFor("darwin", {}, home, 501, answering)?.pid()).toBe(4242);
    expect(serviceFor("linux", {}, home, 1000, answering)?.pid()).toBe(4343);
    answers["systemctl"] = "0\n";
    expect(
      serviceFor("linux", {}, home, 1000, answering)?.pid(),
    ).toBeUndefined();
    const failing = (): string => {
      throw new Error("Could not find service");
    };
    expect(serviceFor("darwin", {}, home, 501, failing)?.pid()).toBeUndefined();
  });
});
