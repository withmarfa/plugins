import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostPlatforms,
  hostArchiveName as hostNamesIt,
} from "../../host/src/update.js";
import { bundleName } from "../bundle-files.js";
import {
  bundleHost,
  hostArchiveName,
  nodeFor,
  writeHostRelease,
} from "../release/host-archive.js";
import { platforms, type Platform } from "../node-pin.js";
import { downloadUrl, defaultRepository } from "../release/repository.js";
import { build, checksumsFile } from "../release/release.js";
import { emptyTree, remove, writePlugin } from "./plugin-fixtures.js";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const made: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const folder of made.splice(0)) await remove(folder);
});

async function standInNode(
  platform: Platform,
): Promise<{ node: string; license: string }> {
  const dir = await emptyTree();
  made.push(dir);
  await mkdir(join(dir, "bin"), { recursive: true });
  const node = join(dir, "bin", "node");
  await writeFile(node, `node ${platform}\n`);
  const license = join(dir, "LICENSE");
  await writeFile(license, `license ${platform}\n`);
  return { node, license };
}

const parts = {
  node: standInNode,
  async bundleHost(file: string): Promise<void> {
    await writeFile(file, "console.log('host')\n");
  },
};

function thisPlatform(): Platform {
  const name = `${process.platform}-${process.arch}`;
  const found = platforms.find((platform) => platform === name);
  if (found === undefined) {
    throw new Error(`${name} is not a platform the host carries`);
  }
  return found;
}

describe("a connector's code in the release", () => {
  it("names the code file's SHA-256, size and tag, and leaves the source untouched", async () => {
    const base = await emptyTree();
    const out = join(await emptyTree(), "release");
    made.push(base, out);
    const plugin = await writePlugin(base, "connectors/beta/plugin", {
      manifest: {
        connector: {
          source: "beta",
          source_name: "Beta",
          kinds: [{ name: "item", type: "common.beta", direction: "in" }],
          runs: { on: "host" },
        },
      },
    });
    await mkdir(join(base, "connectors", "beta", "dist"), { recursive: true });
    await writeFile(
      join(base, "connectors", "beta", "dist", "main.js"),
      "console.log('beta')\n",
    );
    const manifest = join(plugin, "plugin.json");
    const before = await readFile(manifest);
    const version = "0.0.13";
    const files = await build(version, out, base, parts);
    const code = bundleName("beta", version);
    expect(files).toContain(code);
    expect(await readFile(manifest)).toEqual(before);
    const bytes = await readFile(join(out, code));
    const bundled = JSON.parse(
      await readFile(join(out, "beta.plugin.json"), "utf8"),
    ) as { connector: { code: { url: string; sha256: string; size: number } } };
    expect(bundled.connector.code).toEqual({
      url: downloadUrl(defaultRepository, version, code),
      sha256: sha256(bytes),
      size: bytes.byteLength,
    });
    const index = JSON.parse(
      await readFile(join(out, "plugins.json"), "utf8"),
    ) as { plugins: { bundle: string; sha256: string }[] };
    for (const entry of index.plugins) {
      expect(entry.sha256).toBe(
        sha256(await readFile(join(out, entry.bundle))),
      );
    }
    const listed = (await readFile(join(out, checksumsFile), "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.split("  ")[1]);
    expect(listed).toContain(code);
    expect(listed).not.toContain(checksumsFile);
  });

  it("names the repository GH_REPO sets", async () => {
    vi.stubEnv("GH_REPO", "example/plugins");
    const base = await emptyTree();
    const out = join(await emptyTree(), "release");
    made.push(base, out);
    await writePlugin(base, "connectors/beta/plugin", {
      manifest: {
        connector: {
          source: "beta",
          source_name: "Beta",
          kinds: [{ name: "item", type: "common.beta", direction: "in" }],
          runs: { on: "host" },
        },
      },
    });
    await mkdir(join(base, "connectors", "beta", "dist"), { recursive: true });
    await writeFile(
      join(base, "connectors", "beta", "dist", "main.js"),
      "console.log('beta')\n",
    );
    const version = "0.0.13";
    await build(version, out, base, parts);
    const code = bundleName("beta", version);
    const bundled = JSON.parse(
      await readFile(join(out, "beta.plugin.json"), "utf8"),
    ) as { connector: { code: { url: string } } };
    expect(bundled.connector.code.url).toBe(
      downloadUrl("example/plugins", version, code),
    );
  });
});

describe("the host archives", () => {
  it("uses the same archive names the host updates from", () => {
    expect([...hostPlatforms]).toEqual([...platforms]);
    expect(hostNamesIt("1.2.3", "linux-x64")).toBe(
      hostArchiveName("1.2.3", "linux-x64"),
    );
  });

  it("writes the same bytes for the same files", async () => {
    const version = "0.0.13";
    const first = join(await emptyTree(), "a");
    const second = join(await emptyTree(), "b");
    made.push(first, second);
    await mkdir(first);
    await mkdir(second);
    await writeHostRelease(version, first, defaultRepository, parts);
    await writeHostRelease(version, second, defaultRepository, parts);
    const names = (await readdir(first)).sort();
    expect(names).toEqual((await readdir(second)).sort());
    for (const name of names) {
      expect(await readFile(join(first, name))).toEqual(
        await readFile(join(second, name)),
      );
    }
  });

  it("packs this platform's pinned node, and the host prints its usage", async () => {
    const platform = thisPlatform();
    const real = await nodeFor(platform);
    const out = join(await emptyTree(), "release");
    made.push(out);
    await mkdir(out);
    await writeHostRelease("0.0.0", out, defaultRepository, {
      node: (asked) =>
        asked === platform ? Promise.resolve(real) : standInNode(asked),
    });
    const archive = hostArchiveName("0.0.0", platform);
    const unpacked = join(out, "unpacked");
    mkdirSync(unpacked);
    execFileSync("tar", [
      "-xzf",
      join(out, archive),
      "-C",
      unpacked,
      "--strip-components=1",
    ]);
    const packed = await readFile(join(unpacked, "lib", "node"));
    const original = await readFile(real.node);
    expect(packed.length).toBe(original.length);
    expect(packed.equals(original)).toBe(true);
    const host = await readFile(join(unpacked, "lib", "host.mjs"), "utf8");
    expect(host).not.toMatch(/\/Users\/[A-Za-z0-9._-]+/);
    expect(host).not.toMatch(/\/home\/[A-Za-z0-9._-]+/);
    const home = join(out, "home");
    const help = execFileSync(
      join(unpacked, "lib", "node"),
      [join(unpacked, "lib", "host.mjs"), "--help"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: home,
          MARFA_CONNECTOR_HOST_HOME: home,
          MARFA_NO_KEYCHAIN: "1",
        },
      },
    );
    expect(help).toContain("Usage:");
    expect(help).toContain("marfa-connector-host update");
  }, 180_000);
});

describe("bundling the host", () => {
  it("writes one module", async () => {
    const file = join(await emptyTree(), "host.mjs");
    made.push(join(file, ".."));
    await bundleHost(file, defaultRepository);
    const text = await readFile(file, "utf8");
    expect(text.length).toBeGreaterThan(100);
    expect(text).not.toMatch(/\/Users\/[A-Za-z0-9._-]+/);
  });

  it("updates from the repository the release names, so a fork's build updates from the fork", async () => {
    const file = join(await emptyTree(), "host.mjs");
    made.push(join(file, ".."));
    await bundleHost(file, "example/plugins");
    const text = await readFile(file, "utf8");
    expect(text).toContain('"example/plugins"');
    expect(text).not.toContain(defaultRepository);
  });
});
