import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION } from "@withmarfa/client";
import { afterEach } from "vitest";
import { spawnConnector } from "../src/child.js";
import { CodeStore, type Fetched, type Transport } from "../src/code.js";
import { Home } from "../src/home.js";
import { CappedLog } from "../src/log.js";
import type {
  Assigned,
  HostApi,
  Minted,
  SelfAnswer,
  StartFailure,
} from "../src/marfa.js";
import { pollMs, Supervisor } from "../src/supervisor.js";

const folders: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

export function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), "connector-host-"));
  folders.push(folder);
  return folder;
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A connector's code for the tests: it says how it started on standard
 * output, then serves until `SIGTERM`, or exits with `exit` after writing
 * `error` to standard error.
 */
export function connectorCode(
  behavior: { exit: number; error?: string } | "serve" = "serve",
): string {
  const start = `import { createHash } from "node:crypto";
process.on("SIGUSR2", () => console.log("WOKEN"));
process.on("SIGTERM", () => { console.log("TERM"); process.exit(0); });
const env = process.env;
console.log("START " + JSON.stringify({
  // macOS adds this one to every process it starts.
  names: Object.keys(env).filter((name) => name !== "__CF_USER_TEXT_ENCODING").sort(),
  env: Object.fromEntries(Object.entries(env).filter(([name]) => name !== "MARFA_API_KEY")),
  key: createHash("sha256").update(env.MARFA_API_KEY ?? "").digest("hex"),
  args: process.argv.slice(2),
  execArgv: process.execArgv,
}));
`;
  if (behavior === "serve")
    return `${start}setInterval(() => {}, 60_000);
`;
  return `${start}console.error(${JSON.stringify(behavior.error ?? "it failed")});
process.exit(${String(behavior.exit)});
`;
}

/** Serves code files by address, as a transport the code store uses. */
export class CodeServer {
  readonly files = new Map<string, Buffer>();
  readonly redirects = new Map<string, string>();
  readonly asked: string[] = [];
  /** Chunks the last answer handed out, so a test can see a fetch was cut. */
  handedOut = 0;

  /** Serves `text` at an address, answering the `code` a plugin names. */
  serve(name: string, text: string): { url: string; sha256: string; size: number } {
    const url = `https://code.example.com/${name}`;
    const bytes = Buffer.from(text);
    this.files.set(url, bytes);
    return { url, sha256: sha256(bytes), size: bytes.byteLength };
  }

  readonly transport: Transport = (url) => {
    const address = url.toString();
    this.asked.push(address);
    const redirect = this.redirects.get(address);
    const bytes = this.files.get(address);
    let cancelled = false;
    this.handedOut = 0;
    const answer = (status: number, location: string | null): Fetched => ({
      status,
      location,
      body:
        bytes === undefined || status !== 200
          ? null
          : (async function* (self: CodeServer) {
              for (let at = 0; at < bytes.byteLength; at += 16) {
                if (cancelled) return;
                self.handedOut += 1;
                yield bytes.subarray(at, at + 16);
              }
            })(this),
      discard: () => {
        cancelled = true;
        return Promise.resolve();
      },
    });
    if (redirect !== undefined) return Promise.resolve(answer(302, redirect));
    return Promise.resolve(
      bytes === undefined ? answer(404, null) : answer(200, null),
    );
  };
}

/** One connector as `GET /connector-hosts/self` answers it. */
export function assigned(
  plugin: string,
  version: string,
  code: { url: string; sha256: string; size: number } | undefined,
  over: Partial<Assigned> = {},
): Assigned {
  return {
    plugin,
    version,
    fingerprint: sha256(`${plugin}@${version}`),
    connector: {
      source: plugin,
      source_name: plugin,
      kinds: [{ name: "entry", type: `${plugin}.entry`, direction: "in" }],
      runs: { on: "host" },
      ...(code !== undefined && { code }),
    },
    registration_id: null,
    key_minted: false,
    paused: false,
    run_requested_at: null,
    ...over,
  };
}

/** The host's doors, played by the test. */
export class ScriptedApi implements HostApi {
  connectors: Assigned[] = [];
  /** Answered to `self` instead of the connectors, while set. */
  answer: SelfAnswer | undefined;
  mintAnswer: Minted | undefined;
  readonly keys: string[] = [];
  readonly reports: StartFailure[] = [];
  polls = 0;

  self(): Promise<SelfAnswer> {
    this.polls += 1;
    return Promise.resolve(
      this.answer ?? {
        kind: "ok",
        self: { id: "host-1", name: "Test host", connectors: this.connectors },
      },
    );
  }

  mint(plugin: string): Promise<Minted> {
    if (this.mintAnswer !== undefined) return Promise.resolve(this.mintAnswer);
    const key = `marfa_k1_${plugin}_${String(this.keys.length + 1)}_${sha256(String(Math.random())).slice(0, 24)}`;
    this.keys.push(key);
    return Promise.resolve({ kind: "ok", key });
  }

  reportStartFailure(failure: StartFailure): Promise<void> {
    this.reports.push(failure);
    return Promise.resolve();
  }
}

export class FakeClock {
  at = Date.parse("2026-11-23T09:00:00Z");
  now = (): number => this.at;
  advance(ms: number): void {
    this.at += ms;
  }
}

/** A supervisor over a fresh folder, running real processes. */
export function supervised(env: NodeJS.ProcessEnv = { PATH: process.env["PATH"] }) {
  const home = new Home(scratch());
  const api = new ScriptedApi();
  const server = new CodeServer();
  const clock = new FakeClock();
  const lines: string[] = [];
  const supervisor = new Supervisor({
    api,
    code: new CodeStore(home, server.transport),
    home,
    spawn: spawnConnector(process.execPath, (plugin) => new CappedLog(home.pluginLog(plugin))),
    log: (line) => lines.push(line),
    origin: "https://marfa.example.com",
    env,
    now: clock.now,
    stopGraceMs: 5000,
  });
  cleanups.push(() => supervisor.stop());
  /** One step, then every connector's work done. */
  const step = async (): Promise<"running" | "unlinked"> => {
    const result = await supervisor.step();
    await supervisor.settled();
    return result;
  };
  /** The clock moved to the next poll, then one step. */
  const poll = async (): Promise<"running" | "unlinked"> => {
    clock.advance(pollMs);
    return step();
  };
  /** What each start of `plugin` printed, in order. */
  const starts = (plugin: string): StartLine[] =>
    logOf(home, plugin)
      .split("\n")
      .filter((line) => line.startsWith("START "))
      .map((line) => JSON.parse(line.slice(6)) as StartLine);
  return { home, api, server, clock, lines, supervisor, step, poll, starts };
}

export interface StartLine {
  names: string[];
  env: Record<string, string>;
  key: string;
  args: string[];
  execArgv: string[];
}

export function logOf(home: Home, plugin: string): string {
  try {
    return readFileSync(home.pluginLog(plugin), "utf8");
  } catch {
    return "";
  }
}

/** Every byte of every file under `folder`. */
export function everyFile(folder: string): string {
  let text = "";
  for (const entry of readdirSync(folder, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (entry.isFile())
      text += readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return text;
}

/** Waits until `done` holds, or fails after the test's own timeout. */
export async function until(
  done: () => boolean | Promise<boolean>,
  said = "the condition never held",
): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(said);
}

/** A fetch that answers as Marfa does, with the contract header. */
export function marfaAnswer(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Marfa-Contract": String(CONTRACT_VERSION),
    },
  });
}
