import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { writeWhole } from "./files.js";

export const launchdLabel = "so.marfa.connector-host";
export const systemdUnit = "marfa-connector-host.service";

/** How the service starts the host: the program and its arguments. */
export interface Program {
  args: string[];
  /** Set for the service only where the person set it. */
  home: string | undefined;
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Exit code `run` returns after `current` names a newer release. `KeepAlive`
 * restarts only a non-zero exit, and systemd's `Restart=on-failure` does the
 * same, so the service starts the new build. A clean stop stays 0, and a
 * removed host is not restarted.
 */
export const updateExit = 75;

/**
 * The program the service runs: the `current` link, never one version's
 * path, so an update does not rewrite the service file. The link's target
 * is a shell script. It starts the Node beside it, and `run` listens for
 * `SIGUSR1` itself.
 */
export function installedProgram(
  root: string,
  env: NodeJS.ProcessEnv,
): Program {
  const chosen = env["MARFA_CONNECTOR_HOST_HOME"];
  return {
    args: [join(root, "current", "bin", "marfa-connector-host")],
    home: chosen === undefined || chosen === "" ? undefined : root,
  };
}

/** The LaunchAgent that keeps `run` going on macOS. */
export function launchAgent(program: Program): string {
  const strings = (values: string[]): string =>
    values.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const environment =
    program.home === undefined
      ? ""
      : `  <key>EnvironmentVariables</key>
  <dict>
    <key>MARFA_CONNECTOR_HOST_HOME</key>
    <string>${xml(program.home)}</string>
  </dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${launchdLabel}</string>
  <key>ProgramArguments</key>
  <array>
${strings([...program.args, "run"])}
  </array>
${environment}  <key>RunAtLoad</key>
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
`;
}

/** One argument as systemd reads `ExecStart`, quoted. */
function quoted(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$$$")}"`;
}

/** The systemd user unit that keeps `run` going on Linux. */
export function systemdService(program: Program): string {
  const environment =
    program.home === undefined
      ? ""
      : `Environment=${quoted(`MARFA_CONNECTOR_HOST_HOME=${program.home}`)}\n`;
  return `[Unit]
Description=Marfa connector host
After=network-online.target

[Service]
ExecStart=${[...program.args, "run"].map(quoted).join(" ")}
${environment}Restart=on-failure
KillMode=mixed
TimeoutStopSec=70

[Install]
WantedBy=default.target
`;
}

/** Runs `file` and answers what it printed; throws when it fails. */
export type Exec = (file: string, args: string[]) => string;

const exec: Exec = (file, args) =>
  execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

/** A failure the person mends with the command it names. */
export class ServiceRefused extends Error {
  override name = "ServiceRefused";
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One argument for a POSIX shell, quoted. */
function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Times `launchctl bootstrap` is tried: launchd can refuse it for a moment
 *  just after `bootout`, with "Bootstrap failed: 5: Input/output error". */
const bootstrapTries = 5;
const bootstrapWaitMs = 1_000;

/** Runs `file`, answering whether it succeeded. */
function tried(run: Exec, file: string, args: string[]): boolean {
  try {
    run(file, args);
    return true;
  } catch {
    return false;
  }
}

/** Where the service file is, and how it is loaded and unloaded. */
export interface Service {
  file: string;
  /** Writes the file and (re)starts the service. */
  install(program: Program): string[];
  /** Stops the service, keeping its file. */
  stop(): void;
  /** Stops the service and removes its file. */
  remove(): void;
  /** The process the service runs now, if it runs one. */
  pid(): number | undefined;
}

function positive(text: string | undefined): number | undefined {
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function serviceFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  userHome: string,
  uid: number,
  run: Exec = exec,
  wait: (ms: number) => void = pause,
): Service | undefined {
  if (platform === "darwin") {
    const file = join(
      userHome,
      "Library",
      "LaunchAgents",
      `${launchdLabel}.plist`,
    );
    const domain = `gui/${String(uid)}`;
    const target = `${domain}/${launchdLabel}`;
    return {
      file,
      install(program) {
        writeWhole(file, launchAgent(program));
        tried(run, "launchctl", ["bootout", target]);
        for (let attempt = 1; ; attempt++) {
          if (tried(run, "launchctl", ["bootstrap", domain, file])) return [];
          if (attempt === bootstrapTries)
            throw new ServiceRefused(
              `The service is written but launchd did not load it. Run: launchctl bootstrap ${domain} ${shellQuoted(file)}`,
            );
          wait(bootstrapWaitMs);
        }
      },
      stop() {
        tried(run, "launchctl", ["bootout", target]);
      },
      remove() {
        tried(run, "launchctl", ["bootout", target]);
        rmSync(file, { force: true });
      },
      pid() {
        try {
          return positive(
            /^\s*pid = (\d+)$/m.exec(run("launchctl", ["print", target]))?.[1],
          );
        } catch {
          return undefined;
        }
      },
    };
  }
  if (platform === "linux") {
    const config = env["XDG_CONFIG_HOME"];
    const base = config?.startsWith("/") ? config : join(userHome, ".config");
    const file = join(base, "systemd", "user", systemdUnit);
    return {
      file,
      install(program) {
        writeWhole(file, systemdService(program));
        run("systemctl", ["--user", "daemon-reload"]);
        run("systemctl", ["--user", "enable", systemdUnit]);
        run("systemctl", ["--user", "restart", systemdUnit]);
        return [
          "To keep the host running while you are logged out, run:",
          '  loginctl enable-linger "$USER"',
        ];
      },
      stop() {
        tried(run, "systemctl", ["--user", "stop", systemdUnit]);
      },
      remove() {
        tried(run, "systemctl", ["--user", "disable", "--now", systemdUnit]);
        rmSync(file, { force: true });
        tried(run, "systemctl", ["--user", "daemon-reload"]);
      },
      pid() {
        try {
          return positive(
            run("systemctl", [
              "--user",
              "show",
              "--property=MainPID",
              "--value",
              systemdUnit,
            ]).trim(),
          );
        } catch {
          return undefined;
        }
      },
    };
  }
  return undefined;
}
