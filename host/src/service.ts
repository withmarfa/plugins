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

[Install]
WantedBy=default.target
`;
}

export type Exec = (file: string, args: string[]) => void;

const exec: Exec = (file, args) => {
  execFileSync(file, args, { stdio: "ignore" });
};

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
  /** Stops the service and removes its file. */
  remove(): void;
}

export function serviceFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  userHome: string,
  uid: number,
  run: Exec = exec,
): Service | undefined {
  if (platform === "darwin") {
    const file = join(
      userHome,
      "Library",
      "LaunchAgents",
      `${launchdLabel}.plist`,
    );
    const domain = `gui/${String(uid)}`;
    return {
      file,
      install(program) {
        writeWhole(file, launchAgent(program));
        tried(run, "launchctl", ["bootout", `${domain}/${launchdLabel}`]);
        run("launchctl", ["bootstrap", domain, file]);
        return [];
      },
      remove() {
        tried(run, "launchctl", ["bootout", `${domain}/${launchdLabel}`]);
        rmSync(file, { force: true });
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
      remove() {
        tried(run, "systemctl", ["--user", "disable", "--now", systemdUnit]);
        rmSync(file, { force: true });
        tried(run, "systemctl", ["--user", "daemon-reload"]);
      },
    };
  }
  return undefined;
}
