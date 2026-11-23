import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import type { Code } from "./marfa.js";
import { safeDigest, type Home } from "./home.js";

/** One answer to a GET, before its body is read. */
export interface Fetched {
  status: number;
  /** The `Location` header, for a redirect. */
  location: string | null;
  body: AsyncIterable<Uint8Array> | null;
  /** Drops the rest of the body. */
  discard(): Promise<void>;
}

/** Sends one GET and follows no redirect. */
export type Transport = (url: URL, signal: AbortSignal) => Promise<Fetched>;

export const httpsTransport: Transport = async (url, signal) => {
  const response = await fetch(url, { redirect: "manual", signal });
  const body = response.body;
  return {
    status: response.status,
    location: response.headers.get("location"),
    body,
    discard: async () => {
      await body?.cancel().catch(() => undefined);
    },
  };
};

/** Why a connector's code could not be had, in plain words. */
export class CodeRefused extends Error {
  override name = "CodeRefused";
}

const maxRedirects = 5;

function https(text: string, base?: URL): URL {
  let url: URL;
  try {
    url = base === undefined ? new URL(text) : new URL(text, base);
  } catch {
    throw new CodeRefused(`${text} is not an address`);
  }
  if (url.protocol !== "https:")
    throw new CodeRefused(
      `${url.origin} is not https, and a connector's code is fetched over https only`,
    );
  return url;
}

async function digestOf(path: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return hash.digest("hex");
}

/**
 * The code files of each connector, `connectors/<plugin>/code/<sha256>.mjs`.
 * A file is kept only once its bytes hash to the digest it is named by.
 */
export class CodeStore {
  constructor(
    private readonly home: Home,
    private readonly transport: Transport = httpsTransport,
    private readonly timeoutMs = 10 * 60_000,
  ) {}

  /** The path of `plugin`'s code, fetched and checked first unless a file
   *  with that digest is already here. */
  async ensure(plugin: string, code: Code): Promise<string> {
    if (!safeDigest(code.sha256))
      throw new CodeRefused(`${code.sha256} is not a SHA-256`);
    const path = this.home.codeFile(plugin, code.sha256);
    const held = await digestOf(path);
    if (held === code.sha256) return path;
    if (held !== undefined) await rm(path, { force: true });
    await this.fetchTo(plugin, code, path);
    return path;
  }

  private async fetchTo(plugin: string, code: Code, path: string) {
    const folder = this.home.code(plugin);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = join(
      folder,
      `.${randomBytes(6).toString("hex")}.download`,
    );
    const signal = AbortSignal.timeout(this.timeoutMs);
    let file: FileHandle | undefined;
    try {
      let url = https(code.url);
      let answer = await this.transport(url, signal);
      for (let hops = 0; answer.status >= 300 && answer.status < 400; hops++) {
        await answer.discard();
        if (hops === maxRedirects)
          throw new CodeRefused(`${code.url} redirected too many times`);
        if (answer.location === null)
          throw new CodeRefused(
            `${url.origin} answered ${String(answer.status)} with no address`,
          );
        url = https(answer.location, url);
        answer = await this.transport(url, signal);
      }
      if (answer.status !== 200 || answer.body === null) {
        await answer.discard();
        throw new CodeRefused(
          `${url.origin} answered ${String(answer.status)} for the code`,
        );
      }
      file = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of answer.body) {
        size += chunk.byteLength;
        if (size > code.size) {
          await answer.discard();
          throw new CodeRefused(
            `the code at ${code.url} is larger than the ${String(code.size)} bytes the plugin names, so it was not kept`,
          );
        }
        hash.update(chunk);
        await file.write(chunk);
      }
      await file.sync();
      await file.close();
      file = undefined;
      const sha256 = hash.digest("hex");
      if (sha256 !== code.sha256)
        throw new CodeRefused(
          `the code at ${code.url} has SHA-256 ${sha256} where the plugin names ${code.sha256}, so it was not kept`,
        );
      await rename(temporary, path);
    } catch (error) {
      await file?.close().catch(() => undefined);
      await rm(temporary, { force: true });
      if (error instanceof CodeRefused) throw error;
      throw new CodeRefused(
        `could not fetch ${code.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Deletes every code file of `plugin` but the one named `keep`. */
  async prune(plugin: string, keep: string | undefined): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.home.code(plugin));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      if (keep !== undefined && name === `${keep}.mjs`) continue;
      await rm(join(this.home.code(plugin), name), { force: true });
    }
  }
}
