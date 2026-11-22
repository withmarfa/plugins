import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createClient } from "@withmarfa/client";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { check } from "./check.js";
import { installPlugin, olderVersion } from "./install.js";
import { ConnectorUnderProof, item, rowsOf } from "./connector.js";
import type { ProofServer } from "./server.js";

export async function proveConnectionEvolution(
  url: string,
  mintKey: ProofServer["mintKey"],
): Promise<void> {
  await check(
    "a plugin update widens the stored connection endpoints, the connector starts only once it has, and no existing item or edge changes",
    async () => {
      const source = "proof-connection-evolution",
        type = "proof.evolution.entry",
        extra = "proof.evolution.extra",
        connection = "proof.evolution.in-repository";
      const key = await mintKey({
        label: "Connection evolution proof",
        source,
        type_permissions: { [type]: "write", [extra]: "write" },
        edge_permissions: { [connection]: "write" },
        default_tier: "feed",
      });
      const client = createClient({ baseUrl: url, credential: key.key });
      const runner = new ConnectorUnderProof(
        source,
        url,
        key.key,
        {},
        resolve(import.meta.dirname, "connection-evolution-connector.js"),
        false,
      );
      const entry = resolve(
        import.meta.dirname,
        "connection-evolution-connector.js",
      );
      // The plugin as it was, and as the update makes it, which admits the
      // second source.
      await installPlugin(url, source, entry, { version: olderVersion });
      const run = async (mode: "original" | "widened") =>
        runner.run(["--once"], { PROOF_EVOLUTION: mode });
      const initial = await run("original");
      assert.equal(initial.code, 0, initial.output);
      const rows = await rowsOf(client, type, source);
      const listedOriginal = rows.get("original"),
        listedTarget = rows.get("target");
      assert.ok(listedOriginal);
      assert.ok(listedTarget);
      const original = await item(client, listedOriginal.id),
        target = await item(client, listedTarget.id);
      const edges = async (id: string) => {
        const result = await client.GET("/items/{id}/edges", {
          params: {
            path: { id },
            query: { edge_type: connection },
          },
        });
        assert.ok(result.data, JSON.stringify(result.error));
        return result.data.data;
      };
      const held = await edges(original.id);
      assert.equal(held.length, 1);
      assert.equal(held[0]?.to_id, target.id);
      const definition = async () => {
        const result = await client.GET("/edge-types");
        assert.ok(result.data, JSON.stringify(result.error));
        const found = result.data.data.find((one) => one.id === connection);
        assert.ok(found);
        return found;
      };
      const before = await definition();
      const refused = await run("widened");
      assert.equal(refused.code, 1, refused.output);
      assert.match(refused.output, /marfa plugins install/);
      assert.match(refused.output, /from_type_constraints/);
      assert.deepEqual(await definition(), before);
      assert.deepEqual(await item(client, original.id), original);
      assert.deepEqual(await edges(original.id), held);
      assert.equal((await rowsOf(client, extra, source)).size, 0);

      await installPlugin(url, source, entry, {
        edit: async (folder) => {
          const path = join(folder, "edge-types", `${connection}.json`);
          const stored = JSON.parse(await readFile(path, "utf8")) as Record<
            string,
            unknown
          >;
          await writeFile(
            path,
            JSON.stringify({
              ...stored,
              from_type_constraints: [type, extra],
            }),
          );
        },
      });
      const upgraded = await run("widened");
      assert.equal(upgraded.code, 0, upgraded.output);
      const listedAdded = (await rowsOf(client, extra, source)).get("new");
      assert.ok(listedAdded);
      const added = await item(client, listedAdded.id);
      const addedEdges = await edges(added.id);
      assert.equal(addedEdges.length, 1);
      assert.equal(addedEdges[0]?.to_id, target.id);
      assert.deepEqual(await definition(), {
        ...before,
        from_type_constraints: [type, extra],
      });
      assert.deepEqual(await item(client, original.id), original);
      assert.deepEqual(await item(client, target.id), target);
      assert.deepEqual(await edges(original.id), held);
      const repeated = await run("widened");
      assert.equal(repeated.code, 0, repeated.output);
      assert.deepEqual(await item(client, original.id), original);
      assert.deepEqual(await item(client, target.id), target);
      assert.deepEqual(await item(client, added.id), added);
      assert.deepEqual(await edges(original.id), held);
      assert.deepEqual(await edges(added.id), addedEdges);
      return "the build that admits the new source stops until the plugin is updated, naming it; once it is, the added source imports, existing identifiers and versions remain exact, and a restart is a no-op";
    },
  );
}
