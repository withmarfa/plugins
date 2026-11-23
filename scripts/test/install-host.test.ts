import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { takeLock } from "../../host/src/lock.js";
import { updateLockName } from "../../host/src/update.js";
import {
  bundleHost,
  hostArchiveName,
  renderInstallHost,
  wrapperScript,
} from "../release/host-archive.js";
import { defaultRepository } from "../release/repository.js";
import { tarGz } from "../release/tar.js";
import { emptyTree, remove } from "./plugin-fixtures.js";

const version = "0.0.13";
const made: string[] = [];
let host: Buffer;

beforeAll(async () => {
  const folder = await emptyTree();
  await bundleHost(join(folder, "host.mjs"), defaultRepository);
  host = await readFile(join(folder, "host.mjs"));
  await remove(folder);
});

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

/**
 * Writes a stand-in release into `base`: the host itself, and a `node` that
 * logs its arguments and runs only `activate` on this Node, so `install`
 * links nothing.
 */
async function standIn(
  base: string,
  platform: string,
  mark: string,
): Promise<void> {
  const name = hostArchiveName(version, platform);
  const archive = tarGz([
    {
      path: "marfa-connector-host/bin/marfa-connector-host",
      bytes: Buffer.from(wrapperScript),
      mode: 0o755,
    },
    {
      path: "marfa-connector-host/lib/node",
      bytes: Buffer.from(
        [
          "#!/bin/sh",
          `# ${mark}`,
          'printf \'%s\\n\' "$@" >> "$STUB_LOG"',
          'if [ "$2" = activate ]; then exec "$REAL_NODE" "$@"; fi',
          "",
        ].join("\n"),
      ),
      mode: 0o755,
    },
    {
      path: "marfa-connector-host/lib/host.mjs",
      bytes: host,
      mode: 0o644,
    },
  ]);
  await writeFile(join(base, name), archive);
  await writeFile(join(base, "checksums.txt"), `${sha256(archive)}  ${name}\n`);
  await writeFile(
    join(base, "install-host.sh"),
    await renderInstallHost(version, "withmarfa/plugins"),
  );
}

async function here(): Promise<{ sys: string; platform: string }> {
  const sys = await uname("-s");
  const platform = platformOf(sys, await uname("-m"));
  if (platform === undefined) throw new Error("no host build for this system");
  return { sys, platform };
}

describe("install-host.sh", () => {
  it("installs a stand-in release and runs the command it linked", async () => {
    const { sys, platform } = await here();
    const base = await hold();
    const home = await hold();
    const log = join(base, "stub.log");
    await standIn(base, platform, "first");
    const link = "https://marfa.example.com/connect#code";
    const env = {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
      MARFA_CONNECTOR_HOST_RELEASE_BASE: `file://${base}`,
      STUB_LOG: log,
      REAL_NODE: process.execPath,
    };
    const ran = await run(join(base, "install-host.sh"), [link], env);
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
    expect(readdirSync(join(root, "versions"))).toEqual([version]);
    expect(existsSync(join(root, updateLockName))).toBe(false);
  });

  it("replaces the copy of the same version once it holds the update lock, leaving no staging folder", async () => {
    const { sys, platform } = await here();
    const base = await hold();
    const home = await hold();
    const env = {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
      MARFA_CONNECTOR_HOST_RELEASE_BASE: `file://${base}`,
      STUB_LOG: join(base, "stub.log"),
      REAL_NODE: process.execPath,
    };
    await standIn(base, platform, "first");
    expect((await run(join(base, "install-host.sh"), ["link"], env)).code).toBe(
      0,
    );
    const root = rootFor(home, sys);
    const node = join(root, "versions", version, "lib", "node");
    expect(await readFile(node, "utf8")).toContain("# first");
    await standIn(base, platform, "second");
    const held = takeLock(join(root, updateLockName));
    if (!("lock" in held)) throw new Error("the test could not take the lock");
    const again = run(join(base, "install-host.sh"), ["link"], env);
    await new Promise((done) => setTimeout(done, 1_500));
    expect(await readFile(node, "utf8")).toContain("# first");
    held.lock.release();
    const ran = await again;
    expect(ran.stderr).toBe("");
    expect(ran.code).toBe(0);
    expect(await readFile(node, "utf8")).toContain("# second");
    expect(readlinkSync(join(root, "current"))).toBe(`versions/${version}`);
    expect(readdirSync(join(root, "versions"))).toEqual([version]);
    expect(existsSync(join(root, updateLockName))).toBe(false);
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
