import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands.js";
import { writeSecret } from "../src/files.js";
import { Home } from "../src/home.js";
import { heldVersion, takeLock } from "../src/lock.js";
import { updateExit } from "../src/service.js";
import {
  activateRelease,
  dailyUpdate,
  dayMs,
  hostArchiveName,
  installedVersion,
  updateLockName,
  UpdateRefused,
  updateRelease,
  type UpdateRequest,
} from "../src/update.js";
import { tarGz } from "../../scripts/release/tar.js";
import { marfaAnswer, scratch } from "./helpers.js";

const repo = "withmarfa/plugins";

afterEach(() => {
  vi.unstubAllEnvs();
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Route {
  /** 0 never answers. */
  status: number;
  body?: Buffer;
  location?: string;
}

function listen(): Promise<{
  origin: string;
  paths: string[];
  routes: Map<string, Route>;
  close: () => Promise<void>;
}> {
  const paths: string[] = [];
  const routes = new Map<string, Route>();
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      paths.push(path);
      const route = routes.get(path);
      if (route === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (route.status === 0) return;
      if (route.location !== undefined) {
        response.writeHead(route.status, { Location: route.location });
        response.end();
        return;
      }
      response.writeHead(route.status);
      response.end(route.body ?? Buffer.alloc(0));
    },
  );
  return new Promise((done, fail) => {
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("the update server has no port"));
        return;
      }
      done({
        origin: `http://127.0.0.1:${String(address.port)}`,
        paths,
        routes,
        close: () =>
          new Promise((closed, reject) => {
            server.close((error) => {
              if (error) reject(error);
              else closed();
            });
            server.closeAllConnections();
          }),
      });
    });
  });
}

function archiveFor(
  version: string,
  platform: string,
): {
  name: string;
  bytes: Buffer;
  checksums: Buffer;
} {
  const name = hostArchiveName(version, platform);
  const bytes = tarGz([
    {
      path: "marfa-connector-host/bin/marfa-connector-host",
      bytes: Buffer.from("#!/bin/sh\n"),
      mode: 0o755,
    },
    {
      path: "marfa-connector-host/lib/node",
      bytes: Buffer.from("node\n"),
      mode: 0o755,
    },
    {
      path: "marfa-connector-host/lib/host.mjs",
      bytes: Buffer.from("export {}\n"),
      mode: 0o644,
    },
  ]);
  return {
    name,
    bytes,
    checksums: Buffer.from(`${sha256(bytes)}  ${name}\n`),
  };
}

function plant(root: string, versions: string[], current: string): void {
  const dir = join(root, "versions");
  mkdirSync(dir, { recursive: true });
  for (const version of versions) {
    mkdirSync(join(dir, version));
    writeFileSync(join(dir, version, "marker"), version);
  }
  symlinkSync(join("versions", current), join(root, "current"));
}

function versionsOf(root: string): string[] {
  return readdirSync(join(root, "versions"))
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .sort();
}

function linked(): Home {
  const home = new Home(join(scratch(), "Connector Host"));
  writeSecret(home.hostKey, "marfa_k1_host_secret");
  writeFileSync(
    home.hostJson,
    `${JSON.stringify(
      {
        origin: "https://marfa.example.com",
        id: "host-1",
        name: "Studio Mac",
      },
      null,
      2,
    )}\n`,
  );
  return home;
}

/** Staging folders, set-aside copies and new links an update left behind. */
function leftovers(root: string): string[] {
  const dir = join(root, "versions");
  return [
    ...(existsSync(dir) ? readdirSync(dir) : []).filter((name) =>
      name.startsWith("."),
    ),
    ...readdirSync(root).filter((name) => name.startsWith(".current-")),
  ];
}

describe("updating the connector host", () => {
  it("switches current only after the checksum matches, and drops older copies", async () => {
    const platform = "darwin-arm64";
    const newest = "0.0.4";
    const packed = archiveFor(newest, platform);
    const server = await listen();
    try {
      const prefix = `/${repo}`;
      server.routes.set(`${prefix}/releases/latest`, {
        status: 302,
        location: `${prefix}/releases/tag/v${newest}`,
      });
      server.routes.set(`${prefix}/releases/tag/v${newest}`, {
        status: 200,
        body: Buffer.from("release"),
      });
      server.routes.set(
        `${prefix}/releases/download/v${newest}/${packed.name}`,
        {
          status: 200,
          body: packed.bytes,
        },
      );
      server.routes.set(
        `${prefix}/releases/download/v${newest}/checksums.txt`,
        {
          status: 200,
          body: packed.checksums,
        },
      );
      const root = scratch();
      plant(root, ["0.0.0", "0.0.1", "0.0.2"], "0.0.1");
      const outcome = await updateRelease({
        root,
        version: "0.0.1",
        platform,
        repository: repo,
        origin: server.origin,
      });
      expect(outcome).toEqual({ kind: "updated", version: newest });
      expect(readlinkSync(join(root, "current"))).toBe(`versions/${newest}`);
      expect(versionsOf(root)).toEqual(["0.0.1", "0.0.2", "0.0.4"]);
      expect(leftovers(root)).toEqual([]);
      expect(
        readFileSync(join(root, "versions", newest, "lib", "host.mjs"), "utf8"),
      ).toBe("export {}\n");
    } finally {
      await server.close();
    }
  });

  it("leaves current where it is when the checksum does not match", async () => {
    const platform = "linux-x64";
    const newest = "0.0.4";
    const packed = archiveFor(newest, platform);
    const server = await listen();
    try {
      const prefix = `/${repo}`;
      server.routes.set(`${prefix}/releases/latest`, {
        status: 302,
        location: `${prefix}/releases/tag/v${newest}`,
      });
      server.routes.set(`${prefix}/releases/tag/v${newest}`, {
        status: 200,
        body: Buffer.from("release"),
      });
      server.routes.set(
        `${prefix}/releases/download/v${newest}/${packed.name}`,
        {
          status: 200,
          body: packed.bytes,
        },
      );
      server.routes.set(
        `${prefix}/releases/download/v${newest}/checksums.txt`,
        {
          status: 200,
          body: Buffer.from(`${"ab".repeat(32)}  ${packed.name}\n`),
        },
      );
      const root = scratch();
      plant(root, ["0.0.1"], "0.0.1");
      const request: UpdateRequest = {
        root,
        version: "0.0.1",
        platform,
        repository: repo,
        origin: server.origin,
      };
      await expect(updateRelease(request)).rejects.toThrow(UpdateRefused);
      await expect(updateRelease(request)).rejects.toThrow(/does not match/);
      await expect(updateRelease(request)).rejects.toThrow(
        /Nothing was changed\.$/,
      );
      expect(readlinkSync(join(root, "current"))).toBe("versions/0.0.1");
      expect(existsSync(join(root, "versions", newest))).toBe(false);
      expect(leftovers(root)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("leaves current where it is when the archive cannot be downloaded", async () => {
    const platform = "linux-arm64";
    const newest = "0.0.4";
    const name = hostArchiveName(newest, platform);
    const server = await listen();
    try {
      const prefix = `/${repo}`;
      server.routes.set(`${prefix}/releases/latest`, {
        status: 302,
        location: `${prefix}/releases/tag/v${newest}`,
      });
      server.routes.set(`${prefix}/releases/tag/v${newest}`, {
        status: 200,
        body: Buffer.from("release"),
      });
      server.routes.set(`${prefix}/releases/download/v${newest}/${name}`, {
        status: 500,
        body: Buffer.from("no"),
      });
      const root = scratch();
      plant(root, ["0.0.1"], "0.0.1");
      await expect(
        updateRelease({
          root,
          version: "0.0.1",
          platform,
          repository: repo,
          origin: server.origin,
        }),
      ).rejects.toThrow(/Nothing was changed\.$/);
      expect(readlinkSync(join(root, "current"))).toBe("versions/0.0.1");
      expect(existsSync(join(root, "versions", newest))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("downloads nothing when this release is the newest", async () => {
    const server = await listen();
    try {
      const prefix = `/${repo}`;
      server.routes.set(`${prefix}/releases/latest`, {
        status: 302,
        location: `${prefix}/releases/tag/v0.0.1`,
      });
      server.routes.set(`${prefix}/releases/tag/v0.0.1`, {
        status: 200,
        body: Buffer.from("release"),
      });
      const root = scratch();
      plant(root, ["0.0.1"], "0.0.1");
      const outcome = await updateRelease({
        root,
        version: "0.0.1",
        platform: "darwin-x64",
        repository: repo,
        origin: server.origin,
      });
      expect(outcome).toEqual({ kind: "stay" });
      expect(
        server.paths.some((path) => path.includes("/releases/download/")),
      ).toBe(false);
      expect(readlinkSync(join(root, "current"))).toBe("versions/0.0.1");
    } finally {
      await server.close();
    }
  });

  it("skips the daily check when it is turned off, and update still runs", async () => {
    const platform = "darwin-arm64";
    const newest = "0.0.4";
    const packed = archiveFor(newest, platform);
    const server = await listen();
    try {
      const prefix = `/${repo}`;
      server.routes.set(`${prefix}/releases/latest`, {
        status: 302,
        location: `${prefix}/releases/tag/v${newest}`,
      });
      server.routes.set(`${prefix}/releases/tag/v${newest}`, {
        status: 200,
        body: Buffer.from("release"),
      });
      server.routes.set(
        `${prefix}/releases/download/v${newest}/${packed.name}`,
        {
          status: 200,
          body: packed.bytes,
        },
      );
      server.routes.set(
        `${prefix}/releases/download/v${newest}/checksums.txt`,
        {
          status: 200,
          body: packed.checksums,
        },
      );
      const root = scratch();
      plant(root, ["0.0.1"], "0.0.1");
      const request = {
        root,
        version: "0.0.1",
        platform,
        repository: repo,
        origin: server.origin,
        env: { MARFA_CONNECTOR_HOST_NO_UPDATE: "1" },
      };
      expect(await dailyUpdate(request)).toEqual({ kind: "stay" });
      expect(server.paths).toEqual([]);
      expect(existsSync(join(root, "update-checked"))).toBe(false);
      writeFileSync(join(root, "host.json"), '{"updates": false}\n');
      expect(await dailyUpdate({ ...request, env: {} })).toEqual({
        kind: "stay",
      });
      expect(server.paths).toEqual([]);
      vi.stubEnv("MARFA_CONNECTOR_HOST_NO_UPDATE", "1");
      const outcome = await updateRelease(request);
      expect(outcome).toEqual({ kind: "updated", version: newest });
      expect(readlinkSync(join(root, "current"))).toBe(`versions/${newest}`);
    } finally {
      await server.close();
    }
  });

  it("asks once a day, and again after a day", async () => {
    const server = await listen();
    try {
      const prefix = `/${repo}`;
      server.routes.set(`${prefix}/releases/latest`, {
        status: 302,
        location: `${prefix}/releases/tag/v0.0.1`,
      });
      server.routes.set(`${prefix}/releases/tag/v0.0.1`, {
        status: 200,
        body: Buffer.from("release"),
      });
      const root = scratch();
      mkdirSync(root, { recursive: true });
      const now = 1_700_000_000_000;
      const request = {
        root,
        version: "0.0.1",
        platform: "darwin-arm64",
        repository: repo,
        origin: server.origin,
        env: {},
        now,
      };
      expect(await dailyUpdate(request)).toEqual({ kind: "stay" });
      expect(readFileSync(join(root, "update-checked"), "utf8")).toBe(
        `${String(now)}\n`,
      );
      const asked = server.paths.length;
      expect(asked).toBeGreaterThan(0);
      expect(await dailyUpdate({ ...request, now: now + 1_000 })).toEqual({
        kind: "stay",
      });
      expect(server.paths.length).toBe(asked);
      expect(await dailyUpdate({ ...request, now: now + dayMs })).toEqual({
        kind: "stay",
      });
      expect(server.paths.length).toBeGreaterThan(asked);
    } finally {
      await server.close();
    }
  });
});

describe("run and a newer release", () => {
  it("exits so the service starts the release it installed", async () => {
    const home = linked();
    let asked = 0;
    const exit = await run({
      home,
      env: {},
      execPath: process.execPath,
      stopped: new Promise(() => undefined),
      version: "0.0.1",
      tickMs: 10,
      send: () => {
        asked += 1;
        return Promise.reject(new Error("asked Marfa"));
      },
      maintain: () => Promise.resolve({ kind: "updated", version: "0.0.2" }),
    });
    expect(exit).toBe(updateExit);
    // The check runs beside the loop, so one step may ask Marfa first.
    expect(asked).toBeLessThanOrEqual(1);
  });

  it("exits when current already names another release, without asking", async () => {
    const home = linked();
    mkdirSync(join(home.root, "versions", "0.0.2"), { recursive: true });
    symlinkSync(join("versions", "0.0.2"), join(home.root, "current"));
    let maintained = 0;
    const exit = await run({
      home,
      env: {},
      execPath: process.execPath,
      stopped: new Promise(() => undefined),
      version: "0.0.1",
      tickMs: 10,
      maintain: () => {
        maintained += 1;
        return Promise.resolve({ kind: "stay" });
      },
    });
    expect(exit).toBe(updateExit);
    expect(maintained).toBe(0);
    expect(updateExit).not.toBe(0);
  });

  it("stays up when the daily check fails", async () => {
    const home = linked();
    const exit = await run({
      home,
      env: {},
      execPath: process.execPath,
      stopped: new Promise(() => undefined),
      version: "0.0.1",
      tickMs: 10,
      maintain: () => Promise.reject(new Error("offline")),
      send: () => Promise.resolve(marfaAnswer(401, { code: "unauthorized" })),
    });
    expect(exit).toBe(0);
    expect(readFileSync(home.hostLog, "utf8")).toContain(
      "could not check for an update",
    );
  });
});

type Server = Awaited<ReturnType<typeof listen>>;

/** Serves `version` as the latest release, with its archive and checksums. */
function serveRelease(server: Server, version: string, platform: string): void {
  const packed = archiveFor(version, platform);
  const prefix = `/${repo}`;
  server.routes.set(`${prefix}/releases/latest`, {
    status: 302,
    location: `${prefix}/releases/tag/v${version}`,
  });
  server.routes.set(`${prefix}/releases/tag/v${version}`, {
    status: 200,
    body: Buffer.from("release"),
  });
  server.routes.set(`${prefix}/releases/download/v${version}/${packed.name}`, {
    status: 200,
    body: packed.bytes,
  });
  server.routes.set(`${prefix}/releases/download/v${version}/checksums.txt`, {
    status: 200,
    body: packed.checksums,
  });
}

/** A release's own files, as `install-host.sh` stages them. */
function stageRelease(root: string, name: string, marker: string): string {
  const stage = join(root, "versions", name);
  mkdirSync(join(stage, "bin"), { recursive: true });
  mkdirSync(join(stage, "lib"));
  writeFileSync(join(stage, "bin", "marfa-connector-host"), "#!/bin/sh\n");
  writeFileSync(join(stage, "lib", "node"), "node\n");
  writeFileSync(join(stage, "lib", "host.mjs"), marker);
  return stage;
}

describe("one update at a time", () => {
  it("gives up on a release server that does not answer, within its deadline", async () => {
    const server = await listen();
    try {
      server.routes.set(`/${repo}/releases/latest`, { status: 0 });
      const root = scratch();
      plant(root, ["0.0.1"], "0.0.1");
      await expect(
        updateRelease({
          root,
          version: "0.0.1",
          platform: "darwin-arm64",
          repository: repo,
          origin: server.origin,
          deadlines: { firstByteMs: 100 },
        }),
      ).rejects.toThrow(/did not answer.*Nothing was changed\.$/);
      expect(readlinkSync(join(root, "current"))).toBe("versions/0.0.1");
    } finally {
      await server.close();
    }
  });

  it("stops a download that runs past its whole deadline, and when asked to stop", async () => {
    const platform = "darwin-arm64";
    const server = await listen();
    try {
      serveRelease(server, "0.0.4", platform);
      server.routes.set(
        `/${repo}/releases/download/v0.0.4/${hostArchiveName("0.0.4", platform)}`,
        { status: 0 },
      );
      const root = scratch();
      plant(root, ["0.0.1"], "0.0.1");
      const request: UpdateRequest = {
        root,
        version: "0.0.1",
        platform,
        repository: repo,
        origin: server.origin,
        deadlines: { archiveTotalMs: 150 },
      };
      await expect(updateRelease(request)).rejects.toThrow(
        /took longer than.*Nothing was changed\.$/,
      );
      const stop = new AbortController();
      const asked = updateRelease({
        ...request,
        deadlines: {},
        signal: stop.signal,
      });
      setTimeout(() => {
        stop.abort();
      }, 100);
      await expect(asked).rejects.toThrow(/stopped.*Nothing was changed\.$/);
      expect(readlinkSync(join(root, "current"))).toBe("versions/0.0.1");
      expect(readdirSync(join(root, "versions"))).toEqual(["0.0.1"]);
    } finally {
      await server.close();
    }
  });

  it("leaves a folder another updater is staging into alone", async () => {
    const platform = "darwin-arm64";
    const server = await listen();
    try {
      serveRelease(server, "0.0.4", platform);
      const root = scratch();
      plant(root, ["0.0.1"], "0.0.1");
      for (const other of [
        "0.0.4.partial",
        `.stage-${String(process.pid)}-a`,
      ]) {
        mkdirSync(join(root, "versions", other));
        writeFileSync(join(root, "versions", other, "marker"), "another's");
      }
      await updateRelease({
        root,
        version: "0.0.1",
        platform,
        repository: repo,
        origin: server.origin,
      });
      expect(readlinkSync(join(root, "current"))).toBe("versions/0.0.4");
      expect(existsSync(join(root, "versions", "0.0.4", "marker"))).toBe(false);
      for (const other of ["0.0.4.partial", `.stage-${String(process.pid)}-a`])
        expect(
          readFileSync(join(root, "versions", other, "marker"), "utf8"),
        ).toBe("another's");
    } finally {
      await server.close();
    }
  });

  it("changes nothing while another process holds the update lock", async () => {
    const platform = "darwin-arm64";
    const server = await listen();
    try {
      serveRelease(server, "0.0.4", platform);
      const root = scratch();
      plant(root, ["0.0.1"], "0.0.1");
      const held = takeLock(join(root, updateLockName));
      if (!("lock" in held))
        throw new Error("the test could not take the lock");
      try {
        await expect(
          updateRelease({
            root,
            version: "0.0.1",
            platform,
            repository: repo,
            origin: server.origin,
            lockWaitMs: 100,
          }),
        ).rejects.toThrow(/Another update.*Nothing was changed\.$/);
      } finally {
        held.lock.release();
      }
      expect(readlinkSync(join(root, "current"))).toBe("versions/0.0.1");
      expect(readdirSync(join(root, "versions"))).toEqual(["0.0.1"]);
    } finally {
      await server.close();
    }
  });

  it("installs one copy when two updates run at once", async () => {
    const platform = "linux-x64";
    const server = await listen();
    try {
      serveRelease(server, "0.0.4", platform);
      const root = scratch();
      plant(root, ["0.0.1"], "0.0.1");
      const request = {
        root,
        version: "0.0.1",
        platform,
        repository: repo,
        origin: server.origin,
      };
      const outcomes = await Promise.all([
        updateRelease(request),
        updateRelease(request),
      ]);
      expect(outcomes).toEqual([
        { kind: "updated", version: "0.0.4" },
        { kind: "updated", version: "0.0.4" },
      ]);
      expect(readlinkSync(join(root, "current"))).toBe("versions/0.0.4");
      expect(readdirSync(join(root, "versions")).sort()).toEqual([
        "0.0.1",
        "0.0.4",
      ]);
    } finally {
      await server.close();
    }
  });

  it("replaces an installed copy of the same version, and puts it back when switching fails", async () => {
    const root = scratch();
    plant(root, ["0.0.1", "0.0.5"], "0.0.1");
    const first = stageRelease(root, ".stage-1-a", "new");
    await activateRelease(
      root,
      "0.0.5",
      pathToFileURL(join(first, "lib", "host.mjs")).href,
    );
    expect(readlinkSync(join(root, "current"))).toBe("versions/0.0.5");
    expect(
      readFileSync(join(root, "versions", "0.0.5", "lib", "host.mjs"), "utf8"),
    ).toBe("new");
    expect(readdirSync(join(root, "versions")).sort()).toEqual([
      "0.0.1",
      "0.0.5",
    ]);
    rmSync(join(root, "current"));
    mkdirSync(join(root, "current", "in-the-way"), { recursive: true });
    const second = stageRelease(root, ".stage-1-b", "newer");
    await expect(
      activateRelease(
        root,
        "0.0.5",
        pathToFileURL(join(second, "lib", "host.mjs")).href,
      ),
    ).rejects.toThrow(/Nothing was changed\.$/);
    expect(
      readFileSync(join(root, "versions", "0.0.5", "lib", "host.mjs"), "utf8"),
    ).toBe("new");
    expect(readdirSync(join(root, "versions")).sort()).toEqual([
      "0.0.1",
      "0.0.5",
    ]);
  });

  it("puts in place only a copy staged in this host's own versions folder", async () => {
    const root = scratch();
    plant(root, ["0.0.1"], "0.0.1");
    const elsewhere = stageRelease(scratch(), ".stage-1-a", "new");
    await expect(
      activateRelease(
        root,
        "0.0.5",
        pathToFileURL(join(elsewhere, "lib", "host.mjs")).href,
      ),
    ).rejects.toThrow(UpdateRefused);
    expect(readlinkSync(join(root, "current"))).toBe("versions/0.0.1");
  });
});

/** Puts the copy staged at `stage` in place as `version`. */
function activate(root: string, version: string, stage: string): Promise<void> {
  return activateRelease(
    root,
    version,
    pathToFileURL(join(stage, "lib", "host.mjs")).href,
  );
}

function hostFile(root: string, name: string): string {
  return readFileSync(join(root, "versions", name, "lib", "host.mjs"), "utf8");
}

describe("a placement that stopped part way", () => {
  it("keeps the installed copy when undoing a failed switch cannot delete the new one", async () => {
    const root = scratch();
    plant(root, ["0.0.1"], "0.0.1");
    await activate(root, "0.0.5", stageRelease(root, ".stage-1-a", "good"));
    rmSync(join(root, "current"));
    mkdirSync(join(root, "current", "in-the-way"), { recursive: true });
    const stage = stageRelease(root, ".stage-1-b", "newer");
    // A folder whose contents cannot be removed stops a delete part way, as
    // a crash would.
    const stuck = join(stage, "stuck");
    mkdirSync(stuck);
    writeFileSync(join(stuck, "file"), "x");
    chmodSync(stuck, 0o500);
    const unstick = (): void => {
      for (const name of readdirSync(join(root, "versions"))) {
        const folder = join(root, "versions", name, "stuck");
        if (existsSync(folder)) chmodSync(folder, 0o700);
      }
    };
    try {
      await expect(activate(root, "0.0.5", stage)).rejects.toThrow(
        /Could not switch to 0\.0\.5.*Nothing was changed\.$/,
      );
      expect(hostFile(root, "0.0.5")).toBe("good");
      rmSync(join(root, "current"), { recursive: true });
      symlinkSync(join("versions", "0.0.1"), join(root, "current"));
      // The next placement clears what the stopped one left.
      await activate(root, "0.0.6", stageRelease(root, ".stage-1-c", "next"));
      expect(hostFile(root, "0.0.5")).toBe("good");
    } finally {
      unstick();
    }
  });

  it("undoes a failed switch when an earlier copy to discard would not go", async () => {
    const root = scratch();
    plant(root, ["0.0.1"], "0.0.1");
    await activate(root, "0.0.5", stageRelease(root, ".stage-1-a", "good"));
    // What an older placement of 0.0.5 left and could not delete.
    const left = stageRelease(root, ".0.0.5.discard", "left");
    const stuck = join(left, "stuck");
    mkdirSync(stuck);
    writeFileSync(join(stuck, "file"), "x");
    chmodSync(stuck, 0o500);
    rmSync(join(root, "current"));
    mkdirSync(join(root, "current", "in-the-way"), { recursive: true });
    try {
      await expect(
        activate(root, "0.0.5", stageRelease(root, ".stage-1-b", "newer")),
      ).rejects.toThrow(/Could not switch to 0\.0\.5.*Nothing was changed\.$/);
      expect(hostFile(root, "0.0.5")).toBe("good");
    } finally {
      chmodSync(stuck, 0o700);
    }
  });

  it("never puts back a copy set aside that a delete stopped part way through", async () => {
    const root = scratch();
    plant(root, ["0.0.1"], "0.0.1");
    const first = stageRelease(root, ".stage-1-a", "first");
    const stuck = join(first, "stuck");
    mkdirSync(stuck);
    writeFileSync(join(stuck, "file"), "x");
    chmodSync(stuck, 0o500);
    try {
      await activate(root, "0.0.5", first);
      // Installing 0.0.5 again sets the first copy aside and deletes it,
      // which stops at the folder that will not go.
      await activate(root, "0.0.5", stageRelease(root, ".stage-1-b", "again"));
      expect(leftovers(root).filter((name) => name.endsWith(".aside"))).toEqual(
        [],
      );
      await activate(root, "0.0.6", stageRelease(root, ".stage-1-c", "6"));
      await activate(root, "0.0.7", stageRelease(root, ".stage-1-d", "7"));
      await activate(root, "0.0.8", stageRelease(root, ".stage-1-e", "8"));
      expect(versionsOf(root)).toEqual(["0.0.7", "0.0.8"]);
    } finally {
      for (const name of readdirSync(join(root, "versions")))
        if (existsSync(join(root, "versions", name, "stuck")))
          chmodSync(join(root, "versions", name, "stuck"), 0o700);
    }
  });

  it("puts a copy set aside back when no copy took its place", async () => {
    const root = scratch();
    plant(root, ["0.0.1"], "0.0.1");
    stageRelease(root, ".0.0.5.aside", "set aside");
    await activate(root, "0.0.6", stageRelease(root, ".stage-1-a", "next"));
    expect(hostFile(root, "0.0.5")).toBe("set aside");
    expect(leftovers(root)).toEqual([]);
  });

  it("deletes a copy set aside once a whole copy took its place", async () => {
    const root = scratch();
    plant(root, ["0.0.1"], "0.0.1");
    stageRelease(root, "0.0.5", "placed");
    stageRelease(root, ".0.0.5.aside", "set aside");
    await activate(root, "0.0.6", stageRelease(root, ".stage-1-a", "next"));
    expect(hostFile(root, "0.0.5")).toBe("placed");
    expect(leftovers(root)).toEqual([]);
  });

  it("deletes a copy left to discard, and puts back the copy it replaced", async () => {
    const root = scratch();
    plant(root, ["0.0.1"], "0.0.1");
    stageRelease(root, "0.0.7", "kept");
    stageRelease(root, ".discard-0a1b2c", "failed");
    stageRelease(root, ".discard-3d4e5f", "failed");
    stageRelease(root, ".0.0.5.aside", "set aside");
    await activate(root, "0.0.3", stageRelease(root, ".stage-1-a", "next"));
    expect(hostFile(root, "0.0.7")).toBe("kept");
    expect(hostFile(root, "0.0.5")).toBe("set aside");
    expect(leftovers(root)).toEqual([]);
  });
});

describe("what pruning deletes", () => {
  it("never leaves a partial copy at a release's name when a delete stops part way", async () => {
    const root = scratch();
    plant(root, ["0.0.1", "0.0.2"], "0.0.2");
    const stuck = join(root, "versions", "0.0.1", "stuck");
    mkdirSync(stuck);
    writeFileSync(join(stuck, "file"), "x");
    chmodSync(stuck, 0o500);
    try {
      await activate(root, "0.0.3", stageRelease(root, ".stage-1-a", "3"));
      await activate(root, "0.0.4", stageRelease(root, ".stage-1-b", "4"));
      expect(versionsOf(root)).toEqual(["0.0.3", "0.0.4"]);
    } finally {
      for (const name of readdirSync(join(root, "versions")))
        if (existsSync(join(root, "versions", name, "stuck")))
          chmodSync(join(root, "versions", name, "stuck"), 0o700);
    }
  });
});

describe("what pruning keeps", () => {
  it("keeps the release a live run uses, whatever current names", async () => {
    const root = scratch();
    plant(root, ["0.0.1", "0.0.2"], "0.0.2");
    const held = takeLock(new Home(root).lock, Date.now, "0.0.1");
    if (!("lock" in held)) throw new Error("the test could not take the lock");
    try {
      await activate(root, "0.0.3", stageRelease(root, ".stage-1-a", "3"));
      await activate(root, "0.0.4", stageRelease(root, ".stage-1-b", "4"));
      expect(versionsOf(root)).toEqual(["0.0.1", "0.0.3", "0.0.4"]);
    } finally {
      held.lock.release();
    }
    await activate(root, "0.0.5", stageRelease(root, ".stage-1-c", "5"));
    expect(versionsOf(root)).toEqual(["0.0.4", "0.0.5"]);
  });

  it("is told by run which release it runs", async () => {
    const home = linked();
    let recorded: string | undefined;
    const exit = await run({
      home,
      env: {},
      execPath: process.execPath,
      stopped: new Promise(() => undefined),
      version: "0.0.1",
      tickMs: 10,
      maintain: () => {
        recorded = heldVersion(home.lock);
        return Promise.resolve({ kind: "stay" });
      },
      send: () => Promise.resolve(marfaAnswer(401, { code: "unauthorized" })),
    });
    expect(exit).toBe(0);
    expect(recorded).toBe("0.0.1");
    expect(heldVersion(home.lock)).toBeUndefined();
  });
});

describe("the release this process is", () => {
  it("is the folder of this host's versions that holds the running file, whatever the path above it", () => {
    const outer = join(scratch(), "versions", "1.2.3");
    const root = join(outer, "Connector Host");
    const file = join(root, "versions", "0.0.3", "lib", "host.mjs");
    mkdirSync(join(root, "versions", "0.0.3", "lib"), { recursive: true });
    writeFileSync(file, "export {}\n");
    mkdirSync(join(outer, "dist"), { recursive: true });
    writeFileSync(join(outer, "dist", "main.js"), "export {}\n");
    expect(installedVersion(root, pathToFileURL(file).href)).toBe("0.0.3");
    expect(
      installedVersion(
        root,
        pathToFileURL(join(outer, "dist", "main.js")).href,
      ),
    ).toBeUndefined();
    expect(
      installedVersion(join(outer, "other"), pathToFileURL(file).href),
    ).toBeUndefined();
  });
});

describe("the daily check in run", () => {
  it("keeps supervising while the check waits, and stops the check when run ends", async () => {
    const home = linked();
    let signal: AbortSignal | undefined;
    const exit = await run({
      home,
      env: {},
      execPath: process.execPath,
      stopped: new Promise(() => undefined),
      version: "0.0.1",
      tickMs: 10,
      maintain: (_version, given) => {
        signal = given;
        return new Promise((_done, fail) => {
          given.addEventListener("abort", () => {
            fail(new Error("stopped"));
          });
        });
      },
      send: () => Promise.resolve(marfaAnswer(401, { code: "unauthorized" })),
    });
    expect(exit).toBe(0);
    expect(signal?.aborted).toBe(true);
  });

  it("starts one check at a time, and stops it when the host is asked to stop", async () => {
    const home = linked();
    let stop = (): void => undefined;
    let started = 0;
    let signal: AbortSignal | undefined;
    const running = run({
      home,
      env: {},
      execPath: process.execPath,
      stopped: new Promise((done) => {
        stop = done;
      }),
      version: "0.0.1",
      tickMs: 10,
      checkEveryMs: 0,
      maintain: (_version, given) => {
        started += 1;
        signal = given;
        return new Promise((_done, fail) => {
          given.addEventListener("abort", () => {
            fail(new Error("stopped"));
          });
        });
      },
      send: () =>
        Promise.resolve(
          marfaAnswer(200, {
            id: "host-1",
            name: "Studio Mac",
            connectors: [],
          }),
        ),
    });
    await new Promise((done) => setTimeout(done, 200));
    expect(started).toBe(1);
    stop();
    await expect(running).resolves.toBe(0);
    expect(signal?.aborted).toBe(true);
  });
});
