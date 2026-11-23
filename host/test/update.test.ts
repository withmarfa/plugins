import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands.js";
import { writeSecret } from "../src/files.js";
import { Home } from "../src/home.js";
import { updateExit } from "../src/service.js";
import {
  dailyUpdate,
  dayMs,
  hostArchiveName,
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
      expect(existsSync(join(root, "current.next"))).toBe(false);
      expect(existsSync(join(root, "versions", `${newest}.partial`))).toBe(
        false,
      );
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
      expect(existsSync(join(root, "versions", `${newest}.partial`))).toBe(
        false,
      );
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
    expect(asked).toBe(0);
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
