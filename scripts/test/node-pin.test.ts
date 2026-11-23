/**
 * `scripts/node-pin.ts` fetches the Node archive the connector host carries
 * and refuses it unless it is the one `host/node.json` pins.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  archiveAddress,
  checkMacSignature,
  checkArchive,
  clearSignedText,
  fetchNode,
  majorOf,
  nodeTarget,
  parsePin,
  parseShasums,
  platformOf,
  platforms,
  readPin,
  verifiedShasums,
  type Pin,
} from "../node-pin.js";

const fixtures = join(import.meta.dirname, "fixtures", "node-pin");
const fixtureKey = "42DB1760FA6B38592F38A2D528A00036256BA311";
const made: string[] = [];

afterAll(async () => {
  for (const folder of made) await rm(folder, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "node-pin-test-"));
  made.push(folder);
  return folder;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** An archive laid out as Node's are, with more in it than the host keeps. */
async function archiveOf(platform: string, version: string): Promise<Buffer> {
  const folder = await scratch();
  const top = join(folder, `node-v${version}-${platform}`);
  await mkdir(join(top, "bin"), { recursive: true });
  await mkdir(join(top, "include"), { recursive: true });
  await writeFile(join(top, "bin", "node"), "#!/bin/sh\necho node\n");
  await writeFile(join(top, "bin", "npm"), "npm");
  await writeFile(join(top, "LICENSE"), "licence");
  await writeFile(join(top, "README.md"), "readme");
  await writeFile(join(top, "include", "node.h"), "header");
  const file = join(folder, "archive.tar.gz");
  execFileSync("tar", [
    "-czf",
    file,
    "-C",
    folder,
    `node-v${version}-${platform}`,
  ]);
  return readFileSync(file);
}

function pinFor(version: string, archive: Buffer, platform: string): Pin {
  const held = Object.fromEntries(
    platforms.map((name) => [
      name,
      {
        file: `node-v${version}-${name}.tar.gz`,
        sha256: name === platform ? sha256(archive) : "f".repeat(64),
      },
    ]),
  ) as Pin["platforms"];
  return { version, platforms: held };
}

const serving =
  (body: Uint8Array, status = 200): typeof fetch =>
  () =>
    Promise.resolve(new Response(body, { status }));

describe("host/node.json", () => {
  it("is a Node 26 release with the file and SHA-256 of every platform", async () => {
    const pin = await readPin();
    expect(majorOf(pin.version)).toBe(26);
    expect(Object.keys(pin.platforms).sort()).toEqual([...platforms]);
    expect(nodeTarget(pin)).toBe(`node${pin.version}`);
  });

  it("is refused when a platform is missing or names another release's file", () => {
    const text = readFileSync(
      resolve(fixtures, "../../../../host/node.json"),
      "utf8",
    );
    const pin = JSON.parse(text) as Pin;
    const rest: Record<string, unknown> = { ...pin.platforms };
    delete rest["linux-x64"];
    expect(() => parsePin(JSON.stringify({ ...pin, platforms: rest }))).toThrow(
      /exactly/,
    );
    const wrongFile = {
      ...pin,
      platforms: {
        ...pin.platforms,
        "linux-x64": {
          file: "node-v26.0.0-linux-x64.tar.gz",
          sha256: "a".repeat(64),
        },
      },
    };
    expect(() => parsePin(JSON.stringify(wrongFile))).toThrow(/linux-x64/);
    const shortHash = {
      ...pin,
      platforms: {
        ...pin.platforms,
        "linux-x64": { file: pin.platforms["linux-x64"].file, sha256: "abc" },
      },
    };
    expect(() => parsePin(JSON.stringify(shortHash))).toThrow(/SHA-256/);
  });
});

describe("fetching an archive", () => {
  it("keeps bin/node and the license of an archive that matches the pin, and nothing else", async () => {
    const archive = await archiveOf("linux-x64", "26.13.1");
    const pin = pinFor("26.13.1", archive, "linux-x64");
    const out = join(await scratch(), "node");
    const made = await fetchNode("linux-x64", out, pin, {
      fetch: serving(archive),
    });
    expect(made.signed).toBe(false);
    expect(made.node).toBe(join(out, "bin", "node"));
    expect(readFileSync(made.license, "utf8")).toBe("licence");
    expect((await readdir(out)).sort()).toEqual(["LICENSE", "bin"]);
    expect(await readdir(join(out, "bin"))).toEqual(["node"]);
  });

  it("refuses an archive whose SHA-256 is not the pin's, and unpacks nothing", async () => {
    const archive = await archiveOf("linux-x64", "26.13.1");
    const pin = pinFor("26.13.1", archive, "linux-x64");
    const tampered = Buffer.concat([archive, Buffer.from("x")]);
    const out = join(await scratch(), "node");
    await expect(
      fetchNode("linux-x64", out, pin, { fetch: serving(tampered) }),
    ).rejects.toThrow(/pins/);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a platform the host carries no Node for", async () => {
    const archive = await archiveOf("linux-x64", "26.13.1");
    const pin = pinFor("26.13.1", archive, "linux-x64");
    await expect(
      fetchNode("win-x64", join(await scratch(), "node"), pin, {
        fetch: serving(archive),
      }),
    ).rejects.toThrow(/not a platform/);
    expect(() => platformOf("linux-riscv64")).toThrow(/not a platform/);
  });

  it("fails on an answer that is not a success", async () => {
    const archive = await archiveOf("linux-x64", "26.13.1");
    const pin = pinFor("26.13.1", archive, "linux-x64");
    await expect(
      fetchNode("linux-x64", join(await scratch(), "node"), pin, {
        fetch: serving(new Uint8Array(), 404),
      }),
    ).rejects.toThrow(/404/);
  });

  it("asks nodejs.org for the file the pin names", () => {
    const pin = pinFor("26.13.1", Buffer.from("a"), "linux-x64");
    expect(archiveAddress(pin, "linux-arm64")).toBe(
      "https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-arm64.tar.gz",
    );
    expect(() => {
      checkArchive(Buffer.from("a"), "linux-x64", pin);
    }).not.toThrow();
  });

  it("checks the signature of a macOS archive's node when the machine can", async () => {
    const archive = await archiveOf("darwin-arm64", "26.13.1");
    const pin = pinFor("26.13.1", archive, "darwin-arm64");
    const calls: string[][] = [];
    const exec = (file: string, args: readonly string[]) => {
      if (file === "codesign") {
        calls.push([...args]);
        return Promise.resolve({
          stdout: "",
          stderr:
            "CodeDirectory v=20500 size=1142576 flags=0x10000(runtime) hashes=35695+7 location=embedded\nTeamIdentifier=HX7739G8FX\n",
        });
      }
      return Promise.resolve({
        stdout: execFileSync(file, [...args]).toString(),
        stderr: "",
      });
    };
    const made = await fetchNode(
      "darwin-arm64",
      join(await scratch(), "node"),
      pin,
      {
        fetch: serving(archive),
        exec,
        mac: true,
      },
    );
    expect(made.signed).toBe(true);
    expect(calls[0]).toEqual(["--verify", "--strict", made.node]);
    expect(calls[1]).toEqual(["-dvv", made.node]);
  });
});

describe("the macOS signature", () => {
  const exec =
    (stderr: string, fail = false) =>
    (_file: string, args: readonly string[]) =>
      fail && args[0] === "--verify"
        ? Promise.reject(new Error("invalid signature"))
        : Promise.resolve({ stdout: "", stderr });
  const good =
    "CodeDirectory v=20500 flags=0x10000(runtime) hashes=1+7\nTeamIdentifier=HX7739G8FX\n";

  it("passes a strict signature from the Foundation's team with the hardened runtime", async () => {
    await expect(
      checkMacSignature("node", exec(good)),
    ).resolves.toBeUndefined();
  });

  it("refuses another team, a missing hardened runtime and a signature that does not verify", async () => {
    await expect(
      checkMacSignature("node", exec(good.replace("HX7739G8FX", "ABCDE12345"))),
    ).rejects.toThrow(/HX7739G8FX/);
    await expect(
      checkMacSignature("node", exec(good.replace("(runtime)", "(none)"))),
    ).rejects.toThrow(/hardened runtime/);
    await expect(checkMacSignature("node", exec(good, true))).rejects.toThrow(
      /invalid signature/,
    );
  });
});

describe("the signed SHASUMS256.txt", () => {
  const signed = readFileSync(join(fixtures, "SHASUMS256.txt.asc"), "utf8");
  const key = readFileSync(join(fixtures, "key.asc"), "utf8");

  it("is read once a trusted key has signed it", async () => {
    const text = await verifiedShasums(signed, new Map([[fixtureKey, key]]), [
      fixtureKey,
    ]);
    const sums = parseShasums(text);
    expect(sums.get("node-v26.99.0-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(sums.size).toBe(2);
  });

  it("is refused when its text was changed after signing", async () => {
    const changed = signed.replace("a".repeat(64), "c".repeat(64));
    await expect(
      verifiedShasums(changed, new Map([[fixtureKey, key]]), [fixtureKey]),
    ).rejects.toThrow(/no valid signature/);
  });

  it("is refused when the key that signed it is not a trusted one", async () => {
    await expect(
      verifiedShasums(signed, new Map([[fixtureKey, key]]), [
        "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356",
      ]),
    ).rejects.toThrow(/not a Node.js release key/);
    await expect(
      verifiedShasums(signed, new Map(), [fixtureKey]),
    ).rejects.toThrow(/not signed by a Node.js release key|no valid signature/);
  });

  it("is refused when the key fetched for a fingerprint is another key", async () => {
    await expect(
      verifiedShasums(
        signed,
        new Map([["5BE8A3F6C8A5C01D106C0AD820B1A390B168D356", key]]),
        ["5BE8A3F6C8A5C01D106C0AD820B1A390B168D356"],
      ),
    ).rejects.toThrow(/is not the key with that fingerprint/);
  });

  it("reads the text of a clear-signed message, undoing its dash escaping", () => {
    const message =
      "-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\none\n- -two\n-----BEGIN PGP SIGNATURE-----\n\nx\n-----END PGP SIGNATURE-----\n";
    expect(clearSignedText(message)).toBe("one\n-two");
    expect(() => clearSignedText("plain text")).toThrow(/clear-signed/);
  });
});
