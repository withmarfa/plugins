import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  latestRelease,
  nextVersion,
  readBundle,
  readPublished,
  releaseAddress,
  type IndexEntry,
} from "../release/only-adds.js";

const servers: Server[] = [];

/** A release address that answers each path as `files` says: a body, or a status. */
async function release(
  files: Record<string, string | number>,
): Promise<string> {
  const server = createServer((request, response) => {
    const answer = files[(request.url ?? "").replace(/^\/+/, "")];
    if (answer === undefined) response.writeHead(404).end();
    else if (typeof answer === "number") response.writeHead(answer).end();
    else response.writeHead(200).end(answer);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => {
            done();
          });
          server.closeAllConnections();
        }),
    ),
  );
});

const quick = { attempts: 2, retryDelayMs: 0 };

const index = (plugins: IndexEntry[] = []): string =>
  JSON.stringify({ format: 1, plugins });

describe("reading the latest release", () => {
  it("reads the index a release lists", async () => {
    const address = await release({ "plugins.json": index() });
    expect(await readPublished(address, quick)).toEqual({
      format: 1,
      plugins: [],
    });
  });

  it("takes a 404 for no release, which is also what a release without plugins.json answers", async () => {
    const address = await release({});
    expect(await readPublished(address, quick)).toBeUndefined();
  });

  it("fails on a 5xx, naming the address, and never takes it for nothing published", async () => {
    const address = await release({ "plugins.json": 503 });
    await expect(readPublished(address, quick)).rejects.toThrow(
      `${address}/plugins.json could not be read: answered 503`,
    );
  });

  it("fails on a 403, which is no release either", async () => {
    const address = await release({ "plugins.json": 403 });
    await expect(readPublished(address, quick)).rejects.toThrow(
      `${address}/plugins.json could not be read: answered 403`,
    );
  });

  it("fails when nothing answers, naming the address", async () => {
    const address = await release({});
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      ),
    );
    await expect(readPublished(address, quick)).rejects.toThrow(
      `${address}/plugins.json could not be read`,
    );
  });

  it("tries again after a hiccup, and counts only the last", async () => {
    let calls = 0;
    const flaky: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response(null, { status: 502 })
          : new Response(index()),
      );
    };
    expect(
      await readPublished("https://release.example", {
        ...quick,
        fetch: flaky,
      }),
    ).toEqual({ format: 1, plugins: [] });
    expect(calls).toBe(2);
  });

  it("fails on an index that is not JSON or not of format 1", async () => {
    const text = await release({ "plugins.json": "not json" });
    await expect(readPublished(text, quick)).rejects.toThrow("is not JSON");
    const other = await release({
      "plugins.json": JSON.stringify({ format: 2, plugins: [] }),
    });
    await expect(readPublished(other, quick)).rejects.toThrow(
      "is not an index of format 1",
    );
  });
});

describe("reading a published bundle", () => {
  const body = '{"format":1}';
  const entry = (sha256: string): IndexEntry => ({
    name: "tickets",
    version: "0.0.1",
    has_connector: false,
    bundle: "tickets.plugin.json",
    sha256,
  });

  it("takes the bundle whose SHA-256 the index lists", async () => {
    const address = await release({ "tickets.plugin.json": body });
    const sha = createHash("sha256").update(body).digest("hex");
    expect(
      new TextDecoder().decode(await readBundle(address, entry(sha), quick)),
    ).toBe(body);
  });

  it("refuses a bundle with another SHA-256", async () => {
    const address = await release({ "tickets.plugin.json": body });
    await expect(
      readBundle(address, entry("0".repeat(64)), quick),
    ).rejects.toThrow("plugins.json lists");
  });

  it("fails on a bundle the index lists and the release lacks, never taking it for nothing published", async () => {
    const address = await release({});
    await expect(
      readBundle(address, entry("0".repeat(64)), quick),
    ).rejects.toThrow("is listed by plugins.json and is not there");
  });
});

describe("the next version", () => {
  it("adds one to the last part", () => {
    expect(nextVersion("0.0.12")).toBe("0.0.13");
    expect(nextVersion("1.4.9")).toBe("1.4.10");
  });

  it("refuses what is not a version", () => {
    for (const text of ["", "1.2", "v1.2.3", "1.2.3-rc1", "1.2.x"]) {
      expect(() => nextVersion(text), text).toThrow("is not a version");
    }
  });
});

describe("the release address", () => {
  it("is the latest release, unless MARFA_PLUGINS_URL names another, with no trailing slash", () => {
    const held = process.env["MARFA_PLUGINS_URL"];
    try {
      delete process.env["MARFA_PLUGINS_URL"];
      expect(releaseAddress()).toBe(latestRelease);
      expect(latestRelease).toBe(
        "https://github.com/withmarfa/plugins/releases/latest/download",
      );
      process.env["MARFA_PLUGINS_URL"] = "http://127.0.0.1:1234/";
      expect(releaseAddress()).toBe("http://127.0.0.1:1234");
      process.env["MARFA_PLUGINS_URL"] = "";
      expect(releaseAddress()).toBe(latestRelease);
    } finally {
      if (held === undefined) delete process.env["MARFA_PLUGINS_URL"];
      else process.env["MARFA_PLUGINS_URL"] = held;
    }
  });
});
