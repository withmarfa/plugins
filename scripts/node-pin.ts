/**
 * The Node release the connector host carries, pinned in `host/node.json` by
 * version and, for each platform, the SHA-256 of the official archive. This
 * module reads the pin, fetches an archive and refuses it unless its SHA-256
 * matches, keeps only `bin/node` and the license, and on macOS checks the
 * signature the Node.js Foundation gave `node`. It also writes a pin for a
 * newer release from that release's `SHASUMS256.txt`, after checking the
 * signature on it against the Node.js release keys.
 *
 *   node --experimental-strip-types scripts/node-pin.ts fetch <platform> --out <folder>
 *   node --experimental-strip-types scripts/node-pin.ts update <version>
 *   node --experimental-strip-types scripts/node-pin.ts verify
 *
 * `fetch` leaves `bin/node` and `LICENSE` in the folder. `update` rewrites
 * `host/node.json` for a release of the same major version, and `verify`
 * checks that the pin holds what the release's signed `SHASUMS256.txt` says.
 * Both need `gpg`.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { root } from "./release/plugins.ts";

const execFile = promisify(execFileCallback);

export const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
] as const;

export type Platform = (typeof platforms)[number];

export interface Pin {
  version: string;
  platforms: Record<Platform, { file: string; sha256: string }>;
}

export const pinPath = join(root, "host", "node.json");

export const distribution = "https://nodejs.org/dist";

/** The Developer ID team that signs the `node` the Node.js Foundation ships. */
export const macTeam = "HX7739G8FX";

/**
 * The Node.js releasers' keys, as the Release keys section of nodejs/node's
 * README lists them. A signature counts only from a key whose primary
 * fingerprint is here, whatever key a download claims to be.
 */
export const releaseKeys = [
  "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356",
  "DD792F5973C6DE52C432CBDAC77ABFA00DDBF2B7",
  "CC68F5A3106FF448322E48ED27F5E38D5B0A215F",
  "890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4",
  "C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C",
  "108F52B48DB57BB0CC439B2997B01419BD92F80A",
  "655F3B5C1FB3FA8D1A0CA6BDE4A7D232B936D2FD",
  "A363A499291CBBC940DD62E41F10027AF002F8B0",
] as const;

export const releaseKeyAddress = (fingerprint: string): string =>
  `https://raw.githubusercontent.com/nodejs/release-keys/main/keys/${fingerprint}.asc`;

const semver = /^\d+\.\d+\.\d+$/;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export function platformOf(name: string): Platform {
  const found = platforms.find((platform) => platform === name);
  if (found === undefined) {
    throw new Error(
      `${name} is not a platform the host carries Node for: ${platforms.join(", ")}`,
    );
  }
  return found;
}

/** The pin in `text`, refused unless it holds a version and, for every
 *  platform, the file that release names and a SHA-256. */
export function parsePin(text: string): Pin {
  const value = JSON.parse(text) as Partial<Pin> | null;
  const version = value?.version;
  if (typeof version !== "string" || !semver.test(version)) {
    throw new Error("the Node pin names no version such as 26.13.1");
  }
  const held = value?.platforms;
  if (
    held === undefined ||
    JSON.stringify(Object.keys(held).sort()) !==
      JSON.stringify([...platforms].sort())
  ) {
    throw new Error(`the Node pin must name exactly ${platforms.join(", ")}`);
  }
  for (const platform of platforms) {
    const entry = held[platform];
    if (
      entry.file !== `node-v${version}-${platform}.tar.gz` ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new Error(
        `the Node pin's ${platform} entry must name node-v${version}-${platform}.tar.gz and its SHA-256`,
      );
    }
  }
  return value as Pin;
}

export async function readPin(path = pinPath): Promise<Pin> {
  return parsePin(await readFile(path, "utf8"));
}

/** The pin's version as the target esbuild takes, such as `node26.13.1`. */
export function nodeTarget(pin: Pin): string {
  return `node${pin.version}`;
}

export function majorOf(version: string): number {
  return Number(version.split(".")[0]);
}

export function archiveAddress(
  pin: Pin,
  platform: Platform,
  base = distribution,
): string {
  return `${base}/v${pin.version}/${pin.platforms[platform].file}`;
}

/** Throws unless the archive's SHA-256 is the one the pin holds for it. */
export function checkArchive(
  bytes: Uint8Array,
  platform: Platform,
  pin: Pin,
): void {
  const wanted = pin.platforms[platform].sha256;
  const found = sha256(bytes);
  if (found !== wanted) {
    throw new Error(
      `${pin.platforms[platform].file} has SHA-256 ${found}, and host/node.json pins ${wanted}`,
    );
  }
}

type Run = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const run: Run = (file, args) => execFile(file, [...args]);

/**
 * Checks the signature on a macOS `node`: it must verify strictly, name the
 * Node.js Foundation's Developer ID team and carry the hardened runtime.
 */
export async function checkMacSignature(
  node: string,
  exec: Run = run,
): Promise<void> {
  await exec("codesign", ["--verify", "--strict", node]);
  const { stderr } = await exec("codesign", ["-dvv", node]);
  if (!new RegExp(`^TeamIdentifier=${macTeam}$`, "m").test(stderr)) {
    throw new Error(
      `${node} is not signed by the Developer ID team ${macTeam}`,
    );
  }
  if (
    !/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/m.test(stderr)
  ) {
    throw new Error(`${node} is not signed with the hardened runtime`);
  }
}

/** Unpacks `bin/node` and `LICENSE` of the archive into `out`, and nothing
 *  else of it. */
export async function extract(
  archive: Uint8Array,
  platform: Platform,
  pin: Pin,
  out: string,
  exec: Run = run,
): Promise<{ node: string; license: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "node-pin-"));
  try {
    const file = join(scratch, pin.platforms[platform].file);
    await writeFile(file, archive);
    const top = `node-v${pin.version}-${platform}`;
    await mkdir(out, { recursive: true });
    await exec("tar", [
      "-xzf",
      file,
      "-C",
      out,
      "--strip-components=1",
      `${top}/bin/node`,
      `${top}/LICENSE`,
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { node: join(out, "bin", "node"), license: join(out, "LICENSE") };
}

export interface Fetching {
  fetch?: typeof fetch;
  exec?: Run;
  /** Whether this machine can check a macOS signature. */
  mac?: boolean;
}

async function download(
  address: string,
  get: typeof fetch,
): Promise<Uint8Array> {
  const answer = await get(address);
  if (!answer.ok) {
    throw new Error(`${address} answered ${String(answer.status)}`);
  }
  return new Uint8Array(await answer.arrayBuffer());
}

/**
 * Fetches the pinned archive for `platform` and leaves `bin/node` and
 * `LICENSE` in `out`. Nothing is unpacked unless the archive's SHA-256 is the
 * pin's, and for a macOS platform, on macOS, `node` must carry the
 * Foundation's signature. Answers whether the signature was checked.
 */
export async function fetchNode(
  platform: string,
  out: string,
  pin: Pin,
  {
    fetch: get = fetch,
    exec = run,
    mac = process.platform === "darwin",
  }: Fetching = {},
): Promise<{ node: string; license: string; signed: boolean }> {
  const known = platformOf(platform);
  const archive = await download(archiveAddress(pin, known), get);
  checkArchive(archive, known, pin);
  const made = await extract(archive, known, pin, out, exec);
  const signed = known.startsWith("darwin-") && mac;
  if (signed) await checkMacSignature(made.node, exec);
  return { ...made, signed };
}

/**
 * The SHA-256 each file of a release has, from the text of its
 * `SHASUMS256.txt`.
 */
export function parseShasums(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      found.set(match[2], match[1]);
    }
  }
  return found;
}

/** The text a clear-signed message holds, as a reader of it gets it. */
export function clearSignedText(signed: string): string {
  const start = signed.indexOf("\n\n");
  const end = signed.indexOf("\n-----BEGIN PGP SIGNATURE-----");
  if (
    !signed.startsWith("-----BEGIN PGP SIGNED MESSAGE-----") ||
    start === -1 ||
    end < start
  ) {
    throw new Error("SHASUMS256.txt.asc is not a clear-signed message");
  }
  return signed
    .slice(start + 2, end)
    .split("\n")
    .map((line) => (line.startsWith("- ") ? line.slice(2) : line))
    .join("\n");
}

/**
 * The text of a clear-signed `SHASUMS256.txt.asc`, once a key in `trusted`
 * has signed it. `keys` holds each trusted key by its fingerprint; a key that
 * is not the one its fingerprint names is refused.
 */
export async function verifiedShasums(
  signed: string,
  keys: ReadonlyMap<string, string>,
  trusted: readonly string[] = releaseKeys,
  exec: Run = run,
): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "node-keys-"));
  try {
    const gpg = (args: readonly string[]) =>
      exec("gpg", ["--homedir", home, "--batch", "--no-tty", ...args]);
    for (const [fingerprint, key] of keys) {
      if (!trusted.includes(fingerprint)) {
        throw new Error(`${fingerprint} is not a Node.js release key`);
      }
      const file = join(home, `${fingerprint}.asc`);
      await writeFile(file, key);
      await gpg(["--import", file]);
    }
    const { stdout: listing } = await gpg(["--list-keys", "--with-colons"]);
    const held = new Set(
      listing
        .split("\n")
        .filter((line) => line.startsWith("fpr:"))
        .map((line) => line.split(":")[9]),
    );
    for (const fingerprint of keys.keys()) {
      if (!held.has(fingerprint)) {
        throw new Error(
          `the key fetched for ${fingerprint} is not the key with that fingerprint`,
        );
      }
    }
    const file = join(home, "SHASUMS256.txt.asc");
    await writeFile(file, signed);
    let status: string;
    try {
      ({ stdout: status } = await gpg(["--status-fd", "1", "--verify", file]));
    } catch (error) {
      throw new Error("SHASUMS256.txt carries no valid signature", {
        cause: error,
      });
    }
    const primary = status
      .split("\n")
      .filter((line) => line.startsWith("[GNUPG:] VALIDSIG "))
      .map((line) => line.split(" ").at(-1));
    if (!primary.some((fingerprint) => trusted.includes(fingerprint ?? ""))) {
      throw new Error("SHASUMS256.txt is not signed by a Node.js release key");
    }
    return clearSignedText(signed);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** The pin for `version`, from that release's signed `SHASUMS256.txt`. */
export async function pinFor(
  version: string,
  { fetch: get = fetch, exec = run }: Fetching = {},
  trusted: readonly string[] = releaseKeys,
  keyAddress: (fingerprint: string) => string = releaseKeyAddress,
): Promise<Pin> {
  if (!semver.test(version)) {
    throw new Error(`${version} is not a version such as 26.13.1`);
  }
  const signed = new TextDecoder().decode(
    await download(`${distribution}/v${version}/SHASUMS256.txt.asc`, get),
  );
  const keys = new Map<string, string>();
  for (const fingerprint of trusted) {
    keys.set(
      fingerprint,
      new TextDecoder().decode(await download(keyAddress(fingerprint), get)),
    );
  }
  const sums = parseShasums(await verifiedShasums(signed, keys, trusted, exec));
  const held = {} as Pin["platforms"];
  for (const platform of platforms) {
    const file = `node-v${version}-${platform}.tar.gz`;
    const digest = sums.get(file);
    if (digest === undefined) {
      throw new Error(`SHASUMS256.txt for v${version} lists no ${file}`);
    }
    held[platform] = { file, sha256: digest };
  }
  return { version, platforms: held };
}

export function formatPin(pin: Pin): string {
  return `${JSON.stringify(pin, null, 2)}\n`;
}

async function main(): Promise<void> {
  const [command, first, ...rest] = process.argv.slice(2);
  if (command === "fetch" && first !== undefined) {
    const at = rest.indexOf("--out");
    const out = rest[at + 1];
    if (at === -1 || out === undefined)
      throw new Error("fetch needs --out <folder>");
    const made = await fetchNode(first, resolve(out), await readPin());
    console.log(
      `${made.node}${made.signed ? " (signature checked)" : " (signature not checked on this machine)"}`,
    );
  } else if (command === "update" && first !== undefined) {
    const current = await readPin();
    if (majorOf(first) !== majorOf(current.version)) {
      throw new Error(
        `${first} is not a ${String(majorOf(current.version))}.x release, and a new major version is a choice made by hand`,
      );
    }
    await writeFile(pinPath, formatPin(await pinFor(first)));
  } else if (command === "verify") {
    const pin = await readPin();
    const again = await pinFor(pin.version);
    if (formatPin(again) !== formatPin(pin)) {
      throw new Error(
        `host/node.json differs from the signed SHASUMS256.txt of v${pin.version}`,
      );
    }
    console.log(
      `host/node.json matches the signed SHASUMS256.txt of v${pin.version}`,
    );
  } else {
    console.error(
      "usage: node-pin.ts fetch <platform> --out <folder> | update <version> | verify",
    );
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
