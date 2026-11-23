#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  install,
  logs,
  Refused,
  run,
  status,
  uninstall,
  uninstallPlan,
  type Io,
} from "./commands.js";
import { Home, homeFolder, safePluginName } from "./home.js";
import { LinkRefused } from "./link.js";
import { RedeemRefused } from "./marfa.js";
import { serviceFor } from "./service.js";

const usage = `marfa-connector-host: runs the connectors your Marfa assigns to this machine.

Usage:
  marfa-connector-host install '<link>' [--no-service]
                                   Link this machine with the one-time link from
                                   \`marfa hosts add <name>\`, and start the service.
  marfa-connector-host status      The host, and each connector it runs.
  marfa-connector-host logs [<plugin>]
                                   The host's log, or one connector's.
  marfa-connector-host uninstall [--yes]
                                   Stop the service and delete the host's files.
  marfa-connector-host run         Run the connectors; what the service runs.

Files: ${homeFolder(process.env, process.platform, homedir())}
(MARFA_CONNECTOR_HOST_HOME names another folder.)`;

const io: Io = {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

function serviceHere() {
  return serviceFor(
    process.platform,
    process.env,
    homedir(),
    process.getuid?.() ?? 0,
  );
}

async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function main(args: string[]): Promise<number> {
  const home = new Home(homeFolder(process.env, process.platform, homedir()));
  const [command, ...rest] = args;
  const flags = rest.filter((arg) => arg.startsWith("--"));
  const operands = rest.filter((arg) => !arg.startsWith("--"));
  const known = (allowed: string[], most: number): boolean => {
    const unknown = flags.filter((flag) => !allowed.includes(flag));
    if (unknown.length > 0 || operands.length > most) {
      io.err(usage);
      return false;
    }
    return true;
  };
  switch (command) {
    case "install": {
      if (!known(["--no-service"], 1)) return 2;
      const link = operands[0];
      if (link === undefined) {
        io.err(usage);
        return 2;
      }
      const service = flags.includes("--no-service")
        ? undefined
        : serviceHere();
      if (!flags.includes("--no-service") && service === undefined) {
        io.err(
          `This system (${process.platform}) has no service the host can install. Install with --no-service and run \`marfa-connector-host run\` under your own supervisor.`,
        );
        return 1;
      }
      const script = realpathSync(fileURLToPath(import.meta.url));
      const chosen = process.env["MARFA_CONNECTOR_HOST_HOME"];
      await install(
        home,
        link,
        io,
        service === undefined
          ? undefined
          : {
              service,
              program: {
                args: [process.execPath, "--disable-sigusr1", script],
                home:
                  chosen === undefined || chosen === "" ? undefined : home.root,
              },
            },
      );
      return 0;
    }
    case "run": {
      if (!known([], 0)) return 2;
      // Any process of this user, a connector included, can open a Node
      // process's inspector with SIGUSR1; a listener of its own stops that.
      process.on("SIGUSR1", () => undefined);
      const stopped = new Promise<void>((done) => {
        process.once("SIGTERM", () => {
          done();
        });
        process.once("SIGINT", () => {
          done();
        });
      });
      const code = await run({
        home,
        env: process.env,
        execPath: process.execPath,
        echo: (line) => {
          io.out(line);
        },
        stopped,
      });
      // Once stopped, nothing left pending, such as a socket a fetch left
      // open, keeps the process alive.
      process.stdout.write("", () => process.exit(code));
      return code;
    }
    case "status":
      if (!known([], 0)) return 2;
      status(home, io, serviceHere());
      return 0;
    case "logs": {
      if (!known([], 1)) return 2;
      const plugin = operands[0];
      if (plugin !== undefined && !safePluginName(plugin)) {
        io.err(`${plugin} is not a plugin's name.`);
        return 2;
      }
      logs(home, plugin, io);
      return 0;
    }
    case "uninstall": {
      if (!known(["--yes"], 0)) return 2;
      const service = serviceHere();
      const plan = uninstallPlan(home, service);
      if (plan.length === 0) {
        io.out("Nothing to remove: the host is not installed here.");
        return 0;
      }
      io.out("This removes:");
      for (const line of plan) io.out(`  ${line}`);
      if (!flags.includes("--yes")) {
        if (!process.stdin.isTTY) {
          io.err("Run `marfa-connector-host uninstall --yes` to go ahead.");
          return 1;
        }
        if (!(await confirm("Remove them?"))) {
          io.out("Nothing was removed.");
          return 1;
        }
      }
      uninstall(home, service);
      io.out(
        "Removed. The host is still listed in your Marfa: remove it with `marfa hosts remove <host>` so its connectors can run elsewhere.",
      );
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
      io.out(usage);
      return 0;
    default:
      io.err(usage);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (
    error instanceof Refused ||
    error instanceof LinkRefused ||
    error instanceof RedeemRefused
  ) {
    io.err(error.message);
  } else {
    io.err(
      `marfa-connector-host failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
  process.exitCode = 1;
}
