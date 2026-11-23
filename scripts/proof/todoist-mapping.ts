import { createClient, type MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  hostMintedKey,
  lastRun,
  moved,
  rowsOf,
  type Item,
} from "./connector.js";
import { installerKeyAt, installTypes } from "./install.js";
import { TodoistStub } from "./todoist-stub.js";

const target = "common.ticket.task";

/**
 * Todoist's one kind under the owner's mapping: turned off, it writes
 * nothing, and turned on again it takes up what it missed; mapped onto the
 * Tickets plugin's `common.ticket.task`, the rows it wrote before keep
 * a rewrite moves the rows it wrote before onto the target, where they keep
 * syncing, and a new task lands with a templated title and an overridden
 * status word.
 */
export async function proveTodoistMapping(
  marfa: MarfaClient,
  url: string,
  manager: MarfaClient,
): Promise<void> {
  const todoist = await new TodoistStub("todoist-proof-token").start();
  const account = todoist.account;
  try {
    const key = await hostMintedKey(url, "todoist");
    const runner = new ConnectorUnderProof("todoist", url, key.key, {
      todoist_api_token: "todoist-proof-token",
      todoist_api_url: todoist.url,
    });
    const runOnce = async (): Promise<void> => {
      const { code, output } = await runner.once();
      if (code !== 0)
        throw new Error(`the run exited ${String(code)}: ${output}`);
    };
    const own = (): Promise<Map<string, Item>> =>
      rowsOf(marfa, "todoist.task", "todoist");
    const mapped = (): Promise<Map<string, Item>> =>
      rowsOf(marfa, target, "todoist");
    // The owner saves the mapping, with write on the target type, which a
    // mapping hands to the connector for its own items alone.
    const owner = createClient({
      baseUrl: url,
      credential: installerKeyAt(url),
    });
    let version = 0;
    // The fields the two types share, named: the server takes a save that
    // leaves them out as the defaults of the kind's own type.
    const onTarget = {
      enabled: true,
      target_type: target,
      tier: "library",
      fields: Object.fromEntries(
        [
          "title",
          "description",
          "status",
          "priority",
          "due_at",
          "precision",
          "completed_at",
        ].map((field) => [field, { from: field }]),
      ),
    };
    const save = async (kind: Record<string, unknown>): Promise<void> => {
      const { data, error } = await owner.PUT(
        "/plugins/{name}/connector/mapping",
        {
          params: { path: { name: "todoist" } },
          body: { version, kinds: { task: kind } },
        },
      );
      if (data === undefined)
        throw new Error(`the mapping was refused: ${JSON.stringify(error)}`);
      version = data.version;
    };
    const rewrites = async (): Promise<number[]> => {
      const { data, error } = await manager.GET(
        "/plugins/{name}/connector/mapping",
        { params: { path: { name: "todoist" } } },
      );
      if (data === undefined)
        throw new Error(`the mapping was refused: ${JSON.stringify(error)}`);
      return data.rewrites.map((one) => one.number);
    };

    todoist.put(todoist.task("z", { content: "Water the plants" }));
    await check(
      "todoist-mapping: before the owner maps it, the task kind lands on todoist.task at the feed",
      async () => {
        await runOnce();
        const written = await own();
        const tiers = [...new Set([...written.values()].map((r) => r.tier))];
        if (written.size !== 1 || tiers.join() !== "feed")
          throw new Error(`${String(written.size)} rows at ${tiers.join()}`);
        return `${String(written.size)} todoist.task row at the feed`;
      },
    );

    let offBefore = new Map<string, Item>();
    await check(
      "todoist-mapping: a kind the owner turns off writes nothing and leaves its items alone",
      async () => {
        await save({ enabled: false });
        offBefore = await own();
        todoist.edit("z", { content: "Water the plants twice" });
        todoist.put(todoist.task("a", { content: "Buy milk" }));
        await runOnce();
        const after = await own();
        const changed = moved(offBefore, after);
        if (changed.length !== 0 || after.size !== offBefore.size)
          throw new Error(
            `moved ${changed.join(", ")}; ${String(after.size)} on todoist.task`,
          );
        return `nothing moved; ${String(after.size)} item stays as it was`;
      },
    );

    await check(
      "todoist-mapping: turned on again, it takes up what changed upstream while it was off",
      async () => {
        await save({ enabled: true });
        await runOnce();
        const after = await own();
        if (
          after.get(`${account}:z`)?.properties["title"] !==
            "Water the plants twice" ||
          !after.has(`${account}:a`)
        )
          throw new Error(
            `z reads ${String(after.get(`${account}:z`)?.properties["title"])}; a held ${String(after.has(`${account}:a`))}`,
          );
        return `z reads "Water the plants twice"; a is written; moved ${moved(offBefore, after).join(", ")}`;
      },
    );

    await installTypes(url, "tickets");
    await check(
      `todoist-mapping: mapped onto ${target}, a rewrite moves the rows it wrote before onto ${target}, keeping each item, and they keep syncing there`,
      async () => {
        const before = await own();
        await save(onTarget);
        const { data, error } = await owner.POST(
          "/plugins/{name}/connector/mapping/rewrite",
          { params: { path: { name: "todoist" } }, body: { kinds: ["task"] } },
        );
        if (data?.number === undefined)
          throw new Error(`the rewrite was refused: ${JSON.stringify(error)}`);
        todoist.edit("z", { content: "Water the plants at noon" });
        await runOnce();
        const waiting = await rewrites();
        const summary = String((await lastRun(manager, key.id)).summary);
        const left = await own();
        const onIt = await mapped();
        const z = onIt.get(`${account}:z`);
        if (
          waiting.includes(data.number) ||
          left.size !== 0 ||
          onIt.size !== before.size ||
          z?.id !== before.get(`${account}:z`)?.id ||
          z?.properties["title"] !== "Water the plants at noon"
        )
          throw new Error(
            `rewrites waiting ${waiting.join() || "none"}; ${String(left.size)} left on todoist.task, ${String(onIt.size)} on ${target}; z holds ${JSON.stringify(z?.properties)}; ${summary}`,
          );
        return `rewrite ${String(data.number)} finished; ${String(onIt.size)} items moved onto ${target}; z, the same item, reads "${z.properties["title"]}"; ${summary}`;
      },
    );

    await check(
      `todoist-mapping: with a templated title and a status override, a new task lands on ${target} with the rendered title and the overridden word, and the run keeps its agreement`,
      async () => {
        await save({
          ...onTarget,
          status_overrides: { not_started: "backlog" },
          fields: {
            ...onTarget.fields,
            title: { template: "{{ title }} (from Todoist)" },
          },
        });
        todoist.put(todoist.task("b", { content: "Call the plumber" }));
        const { code, output } = await runner.once();
        const landed = (await mapped()).get(`${account}:b`);
        if (
          landed?.properties["title"] !== "Call the plumber (from Todoist)" ||
          landed.properties["status"] !== "backlog" ||
          code !== 0
        )
          throw new Error(
            `the run exited ${String(code)}; b holds ${JSON.stringify(landed?.properties)}: ${output}`,
          );
        return `b on ${target} reads "${landed.properties["title"]}" at ${landed.properties["status"]}; the run exited 0`;
      },
    );
  } finally {
    await todoist.close();
  }
}
