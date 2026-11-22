import { resolve } from "node:path";
import { createClient, type MarfaClient } from "@withmarfa/client";
import type { ProofServer } from "./server.js";
import { check } from "./check.js";
import { ConnectorUnderProof, hostMintedKey } from "./connector.js";
import { connectorKey } from "./host.js";
import { serveThings } from "./inbound.js";

const entry = resolve(import.meta.dirname, "inbound-connector.js");
const types = ["proof.thing"];

export async function proveKeys(
  marfa: MarfaClient,
  url: string,
  manager: MarfaClient,
  mintKey: ProofServer["mintKey"],
  updateKey: ProofServer["updateKey"],
): Promise<void> {
  const vendor = await serveThings();
  try {
    const runner = (key: string): ConnectorUnderProof =>
      new ConnectorUnderProof(
        "proof-inbound",
        url,
        key,
        {
          proof_vendor_url: vendor.url,
          proof_webhook_secret: "proof-webhook-secret-value",
        },
        entry,
      );

    const minted = await hostMintedKey(url, "proof-inbound", { entry, types });

    await check(
      "keys: the key its connector host mints starts the connector, which reads its settings from Marfa",
      async () => {
        const { code, output } = await runner(minted.key).once();
        if (code !== 0) throw new Error(`exited ${String(code)}: ${output}`);
        return "exited 0";
      },
    );

    await check(
      "keys: the host's key widened with a metadata entry, a claim or another type is refused at start with exit 3, naming each, and starts once put back",
      async () => {
        const current = await marfa.GET("/keys/current");
        if (current.data === undefined)
          throw new Error("the boot key is not readable");
        const elsewhere = current.data.source;
        // Widening a key takes the local authority, as the server's own
        // console does.
        await updateKey(minted.id, {
          metadata_permissions: { types: "read" },
          sources: [elsewhere],
          type_permissions: { "proof.thing": "write", "core.note": "write" },
        });
        const refused = await runner(minted.key).once();
        await updateKey(minted.id, {
          metadata_permissions: {},
          sources: [],
          type_permissions: { "proof.thing": "write" },
        });
        const { code, output } = await runner(minted.key).once();
        if (
          refused.code !== 3 ||
          !refused.output.includes("metadata types=read") ||
          !refused.output.includes("type core.note=write") ||
          !refused.output.includes(`refused: ${elsewhere}.`) ||
          code !== 0
        ) {
          throw new Error(
            `refused with ${String(refused.code)}: ${refused.output}; then exited ${String(code)}: ${output}`,
          );
        }
        return `exited 3 naming metadata types=read, type core.note=write and the claim of ${elsewhere}; put back, exited 0`;
      },
    );

    await check(
      "keys: the API mints no key under the source of an installed plugin's connector",
      async () => {
        const { error, response } = await marfa.POST("/keys", {
          body: {
            label: "proof-inbound-by-hand",
            source: "proof-inbound",
            type_permissions: { "proof.thing": "write" },
            default_tier: "feed",
          },
        });
        if (response.ok)
          throw new Error("the API minted a key under proof-inbound");
        return `${String(response.status)} ${String(error?.error.code)}`;
      },
    );

    await check(
      "keys: a key the API mints, not the connector's host, is refused at start with exit 3, since it writes under a source of its own",
      async () => {
        const other = await mintKey({
          label: "proof-inbound-other",
          source: "proof-inbound-other",
          type_permissions: { "proof.thing": "write" },
          default_tier: "feed",
          permissions: [],
          edge_permissions: {},
          extension_permissions: {},
          metadata_permissions: {},
          profile_permissions: {},
        });
        const { code, output } = await runner(other.key).once();
        if (
          code !== 3 ||
          !output.includes(
            "own source proof-inbound-other, not the connector's",
          )
        ) {
          throw new Error(`exited ${String(code)}: ${output}`);
        }
        const line = output
          .split("\n")
          .find((one) => one.includes("own source proof-inbound-other"));
        return `exited 3: ${String(line).slice(0, 300)}`;
      },
    );

    await check(
      "keys: minting the connector's key again revokes the one before, which then exits 3, and the new key starts",
      async () => {
        const next = await connectorKey(url, "proof-inbound", entry);
        const revoked = await runner(minted.key).once();
        const { code, output } = await runner(next.key).once();
        if (
          revoked.code !== 3 ||
          !revoked.output.includes("401") ||
          code !== 0
        ) {
          throw new Error(
            `the revoked key exited ${String(revoked.code)}: ${revoked.output}; the new one ${String(code)}: ${output}`,
          );
        }
        return "the revoked key exited 3 on a 401; the new key exited 0";
      },
    );

    await check(
      "keys: a key that may mint keys and holds no metadata entry mints a key that holds none either",
      async () => {
        const { data: narrow, error } = await marfa.POST("/keys", {
          body: {
            label: "proof-mint-narrow",
            source: "proof-mint-narrow",
            type_permissions: { "proof.thing": "write" },
            default_tier: "feed",
            permissions: ["keys.mint"],
          },
        });
        if (narrow === undefined)
          throw new Error(`the minter was refused: ${JSON.stringify(error)}`);
        const narrowMinter = createClient({
          baseUrl: url,
          credential: narrow.key,
        });
        const child = await narrowMinter.POST("/keys", {
          body: {
            label: "proof-mint-narrow-child",
            source: "proof-mint-narrow-child",
            type_permissions: { "proof.thing": "write" },
            default_tier: "feed",
          },
        });
        await manager.DELETE("/keys/{id}", {
          params: { path: { id: narrow.id } },
        });
        const held = JSON.stringify(child.data?.metadata_permissions);
        if (child.response.status !== 201 || held !== "{}") {
          throw new Error(
            `answered ${String(child.response.status)}, metadata ${held}: ${JSON.stringify(child.error)}`,
          );
        }
        return `201, metadata ${held}`;
      },
    );
  } finally {
    await vendor.close();
  }
}
