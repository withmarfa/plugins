import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient, type MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import { hostMintedKey, registration, rowsOf } from "./connector.js";
import { installerKeyAt } from "./install.js";
import { runMarfa } from "../release/plugins.ts";

const plugin = "proof-control";
const type = "proof.control.note";
const entry = resolve(import.meta.dirname, "control-connector.js");

/** The connector as its host runs it: a long-lived process on a key the host
 *  minted, which the host wakes with `SIGUSR2`. */
class Running {
  private output = "";
  private readonly exited: Promise<number | null>;
  private readonly child: ChildProcess;

  constructor(url: string, key: string, file: string) {
    this.child = spawn("node", [entry, "--every", "1h"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_API_URL: url,
        MARFA_API_KEY: key,
        PROOF_ENTRIES_FILE: file,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.output += chunk.toString();
    });
    this.exited = new Promise((done) => {
      this.child.once("close", (code) => {
        done(code);
      });
    });
  }

  /** How many times the log has said `text`. */
  count(text: string): number {
    return this.output.split(text).length - 1;
  }

  get log(): string {
    return this.output;
  }

  /** Waits until the log has said `text` `times` times. */
  async said(text: string, times = 1): Promise<void> {
    await until(
      () => this.count(text) >= times,
      `the log never said "${text}" ${String(times)} times:\n${this.output}`,
    );
  }

  /** The exit code, once the process has ended by itself. */
  async ended(): Promise<number | null> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, fail) => {
      timer = setTimeout(() => {
        fail(new Error(`the connector never exited:\n${this.output}`));
      }, 60_000);
    });
    try {
      return await Promise.race([this.exited, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** What the host sends a sleeping connector for run now. */
  wake(): void {
    this.child.kill("SIGUSR2");
  }

  async stop(): Promise<number | null> {
    this.child.kill("SIGTERM");
    return this.exited;
  }
}

async function until(
  done: () => boolean | Promise<boolean>,
  said: string | (() => string),
): Promise<void> {
  for (let tries = 0; tries < 600; tries += 1) {
    if (await done()) return;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
  }
  throw new Error(typeof said === "string" ? said : said());
}

/**
 * What the owner asks of a plugin's connector through the command line: pause
 * and resume it, ask it to run now, and ask how a kind would land. A connector
 * on a key its host minted, woken by the host's `SIGUSR2`, skips a paused run,
 * reports nothing and exits 0, runs on a request and clears it by naming it, and
 * answers a mapping preview at a run's start, writing nothing and never saving
 * the draft. Needs a server built with test hooks only for the group's own
 * instance.
 */
export async function proveControl(url: string): Promise<void> {
  const asOwner = { MARFA_API_URL: url, MARFA_API_KEY: installerKeyAt(url) };
  const owner = createClient({ baseUrl: url, credential: installerKeyAt(url) });
  const marfa = (args: string[]) => runMarfa(args, { env: asOwner });
  const directory = await mkdtemp(join(tmpdir(), "proof-control-"));
  const file = join(directory, "entries.json");
  const notes = async (held: [string, string, string][]): Promise<void> => {
    await writeFile(file, JSON.stringify(held));
  };
  await notes([["n1", "First", "one"]]);
  const key = await hostMintedKey(url, plugin, { entry, types: [type] });
  const rows = (client: MarfaClient) => rowsOf(client, type, plugin);
  const reader = createClient({ baseUrl: url, credential: key.key });
  const status = async () => {
    const { data, error } = await owner.GET("/plugins/{name}/connector", {
      params: { path: { name: plugin } },
    });
    if (data === undefined)
      throw new Error(`the control door refused: ${JSON.stringify(error)}`);
    return data;
  };
  let running = new Running(url, key.key, file);
  try {
    await running.said("run succeeded");
    await check(
      "control: a paused connector skips its run, reports nothing, leaves its rows and exits 0, and the owner cannot ask a paused connector to run",
      async () => {
        const before = (await registration(owner, key.id)).last_run;
        await notes([
          ["n1", "First", "one"],
          ["n2", "Second", "two"],
        ]);
        const paused = await marfa(["plugins", "pause", plugin]);
        if (paused.code !== 0 || !(await status()).paused)
          throw new Error(`pause: exit ${String(paused.code)}`);
        running.wake();
        await running.said("owner paused this connector");
        const exit = await running.ended();
        const after = (await registration(owner, key.id)).last_run;
        const held = await rows(reader);
        const asked = await marfa(["plugins", "run", plugin]);
        if (
          held.size !== 1 ||
          after?.finished_at !== before?.finished_at ||
          after?.outcome !== "succeeded" ||
          asked.code === 0 ||
          exit !== 0
        )
          throw new Error(
            `${String(held.size)} rows, last run ${JSON.stringify(after)} after ${JSON.stringify(before)}, run asked exit ${String(asked.code)}, connector exit ${String(exit)}\n${running.log}`,
          );
        return `paused: SIGUSR2 skipped the run and the connector exited 0, ${String(held.size)} row, the last run unchanged, and run now was refused (exit ${String(asked.code)})`;
      },
    );
    await check(
      "control: resumed, the connector the host starts again runs at once on the run asked for, and its report names the request, which clears it",
      async () => {
        const before = (await registration(owner, key.id)).last_run;
        const resumed = await marfa(["plugins", "resume", plugin]);
        const asked = await marfa(["plugins", "run", plugin]);
        const waiting = (await status()).run_requested_at;
        if (resumed.code !== 0 || asked.code !== 0 || waiting === null)
          throw new Error(
            `resume ${String(resumed.code)}, run ${String(asked.code)}, request ${String(waiting)}`,
          );
        // What the host does on the look that shows it resumed.
        running = new Running(url, key.key, file);
        await until(
          async () => (await status()).run_requested_at === null,
          () => `the request was never cleared:\n${running.log}`,
        );
        const after = (await registration(owner, key.id)).last_run;
        const held = await rows(reader);
        if (
          held.size !== 2 ||
          after?.finished_at === before?.finished_at ||
          after?.outcome !== "succeeded"
        )
          throw new Error(
            `${String(held.size)} rows, last run ${JSON.stringify(after)} after ${JSON.stringify(before)}\n${running.log}`,
          );
        return `the request ${waiting} was cleared by the run's report, which wrote the second row`;
      },
    );
    await check(
      "control: a preview with a draft mapping is answered at a run's start as the mapping would write it, saves no draft and writes no row",
      async () => {
        const mapping = (
          await owner.GET("/plugins/{name}/connector/mapping", {
            params: { path: { name: plugin } },
          })
        ).data;
        const draft = join(directory, "draft.json");
        await writeFile(
          draft,
          JSON.stringify({
            target_type: type,
            fields: {
              title: { template: "Note: {{ title }}" },
              body: { from: "body" },
            },
          }),
        );
        const held = await rows(reader);
        const second = held.get("n2");
        if (second === undefined) throw new Error("the second row is missing");
        const waiting = runMarfa(
          [
            "plugins",
            "mapping",
            "preview",
            plugin,
            "--kind",
            "note",
            "--item",
            second.id,
            "--file",
            draft,
            "--wait",
          ],
          { env: asOwner },
        );
        let early = "the command was still waiting";
        void waiting.then((ran) => {
          early = `exit ${String(ran.code)}: ${ran.stdout}${ran.stderr}`;
        });
        await until(
          async () => (await status()).previews === 1,
          () => `no preview waited on the connector, and ${early}`,
        );
        running.wake();
        const answered = await waiting;
        const after = await rows(reader);
        const kept = (
          await owner.GET("/plugins/{name}/connector/mapping", {
            params: { path: { name: plugin } },
          })
        ).data;
        if (
          answered.code !== 0 ||
          !answered.stdout.includes("Note: Second") ||
          after.size !== held.size ||
          after.get("n2")?.properties["title"] !== "Second" ||
          JSON.stringify(kept) !== JSON.stringify(mapping)
        )
          throw new Error(
            `exit ${String(answered.code)}, printed ${answered.stdout}${answered.stderr}, ${String(after.size)} rows, mapping ${JSON.stringify(kept)}`,
          );
        return `answered "Note: Second" for the stored row; the row still reads "Second" and the mapping stays at version ${String(kept?.version)}`;
      },
    );
  } finally {
    await running.stop();
    await rm(directory, { recursive: true, force: true });
  }
}
