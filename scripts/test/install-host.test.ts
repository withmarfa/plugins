import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readlinkSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostArchiveName,
  renderInstallHost,
  wrapperScript,
} from "../release/host-archive.js";
import { tarGz } from "../release/tar.js";
import { emptyTree, remove } from "./plugin-fixtures.js";

const version = "0.0.13";
const made: string[] = [];

afterEach(async () => {
  for (const folder of made.splice(0)) await remove(folder);
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hold(): Promise<string> {
  const folder = await emptyTree();
  made.push(folder);
  return folder;
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Ran> {
  return new Promise((done, fail) => {
    execFile(
      "sh",
      [script, ...args],
      { env, encoding: "utf8", timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error === null) done({ code: 0, stdout, stderr });
        else if (typeof error.code === "number") {
          done({ code: error.code, stdout, stderr });
        } else fail(new Error(error.message));
      },
    );
  });
}

function platformOf(sys: string, mach: string): string | undefined {
  if (sys === "Darwin" && mach === "arm64") return "darwin-arm64";
  if (sys === "Darwin" && mach === "x86_64") return "darwin-x64";
  if (sys === "Linux" && mach === "x86_64") return "linux-x64";
  if (sys === "Linux" && (mach === "aarch64" || mach === "arm64")) {
    return "linux-arm64";
  }
  return undefined;
}

function rootFor(home: string, sys: string): string {
  if (sys === "Darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Marfa",
      "Connector Host",
    );
  }
  return join(home, ".local", "share", "marfa", "connector-host");
}

async function uname(flag: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile("uname", [flag], { encoding: "utf8" }, (error, stdout) => {
      if (error === null) done(stdout.trim());
      else fail(new Error(error.message));
    });
  });
}

describe("install-host.sh", () => {
  it("installs a stand-in release and runs the command it linked", async () => {
    const sys = await uname("-s");
    const mach = await uname("-m");
    const platform = platformOf(sys, mach);
    expect(platform).toBeDefined();
    const base = await hold();
    const home = await hold();
    const log = join(base, "stub.log");
    const name = hostArchiveName(version, platform ?? "");
    const archive = tarGz([
      {
        path: "marfa-connector-host/bin/marfa-connector-host",
        bytes: Buffer.from(wrapperScript),
        mode: 0o755,
      },
      {
        path: "marfa-connector-host/lib/node",
        bytes: Buffer.from('#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$STUB_LOG"\n'),
        mode: 0o755,
      },
      {
        path: "marfa-connector-host/lib/host.mjs",
        bytes: Buffer.from("export {}\n"),
        mode: 0o644,
      },
    ]);
    await writeFile(join(base, name), archive);
    await writeFile(
      join(base, "checksums.txt"),
      `${sha256(archive)}  ${name}\n`,
    );
    const script = join(base, "install-host.sh");
    await writeFile(
      script,
      await renderInstallHost(version, "withmarfa/plugins"),
    );
    const link = "https://marfa.example.com/connect#code";
    const ran = await run(script, [link], {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
      MARFA_CONNECTOR_HOST_RELEASE_BASE: `file://${base}`,
      STUB_LOG: log,
    });
    expect(ran.stderr).toBe("");
    expect(ran.code).toBe(0);
    const root = rootFor(home, sys);
    expect(readlinkSync(join(root, "current"))).toBe(`versions/${version}`);
    expect(existsSync(join(root, "versions", version, "lib", "node"))).toBe(
      true,
    );
    expect(
      readlinkSync(join(home, ".local", "bin", "marfa-connector-host")),
    ).toBe(join(root, "current", "bin", "marfa-connector-host"));
    const recorded = await readFile(log, "utf8");
    expect(recorded).toContain("install");
    expect(recorded).toContain(link);
  });

  it("refuses an unknown platform before it downloads", async () => {
    const base = await hold();
    const home = await hold();
    const fake = join(base, "bin");
    await mkdir(fake);
    await writeFile(
      join(fake, "uname"),
      "#!/bin/sh\nif [ \"$1\" = -s ]; then printf '%s\\n' SunOS; else printf '%s\\n' sparc; fi\n",
    );
    await chmod(join(fake, "uname"), 0o755);
    const script = join(base, "install-host.sh");
    await writeFile(
      script,
      await renderInstallHost(version, "withmarfa/plugins"),
    );
    const ran = await run(script, ["https://marfa.example.com/connect#code"], {
      PATH: `${fake}:${process.env["PATH"] ?? ""}`,
      HOME: home,
      TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
    });
    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toMatch(/SunOS sparc/);
    expect(ran.stderr).toMatch(/no connector host build/);
    expect(existsSync(rootFor(home, "Darwin"))).toBe(false);
    expect(existsSync(rootFor(home, "Linux"))).toBe(false);
  });

  it("refuses to run without curl", async () => {
    const base = await hold();
    const empty = join(base, "bin");
    await mkdir(empty);
    const script = join(base, "install-host.sh");
    await writeFile(
      script,
      await renderInstallHost(version, "withmarfa/plugins"),
    );
    const ran = await run(script, ["https://marfa.example.com/connect#code"], {
      PATH: "/bin",
      HOME: await hold(),
      TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
    });
    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toMatch(/curl is not installed/);
  });

  it("refuses a missing link", async () => {
    const base = await hold();
    const script = join(base, "install-host.sh");
    await writeFile(
      script,
      await renderInstallHost(version, "withmarfa/plugins"),
    );
    const ran = await run(script, [], {
      PATH: process.env["PATH"] ?? "",
      HOME: await hold(),
    });
    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toMatch(/Give the one-time link/);
  });

  it("installs nothing when the checksum does not match", async () => {
    const sys = await uname("-s");
    const mach = await uname("-m");
    const platform = platformOf(sys, mach);
    expect(platform).toBeDefined();
    const base = await hold();
    const home = await hold();
    const name = hostArchiveName(version, platform ?? "");
    const archive = tarGz([
      {
        path: "marfa-connector-host/bin/marfa-connector-host",
        bytes: Buffer.from("#!/bin/sh\n"),
        mode: 0o755,
      },
    ]);
    await writeFile(join(base, name), archive);
    await writeFile(
      join(base, "checksums.txt"),
      `${"0".repeat(64)}  ${name}\n`,
    );
    const script = join(base, "install-host.sh");
    await writeFile(
      script,
      await renderInstallHost(version, "withmarfa/plugins"),
    );
    const ran = await run(script, ["https://marfa.example.com/connect#code"], {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
      MARFA_CONNECTOR_HOST_RELEASE_BASE: `file://${base}`,
    });
    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toMatch(/does not match/);
    expect(ran.stderr).toMatch(/Nothing was installed/);
    expect(existsSync(join(rootFor(home, sys), "versions"))).toBe(false);
  });
});
