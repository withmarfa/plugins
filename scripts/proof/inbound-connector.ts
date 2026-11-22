import { writeFile } from "node:fs/promises";
import { defineConnector, main, verifyHmac } from "@withmarfa/connector";
import { isProgram } from "./program.js";

interface Thing {
  id: string;
  title: string;
}

export const connector = defineConnector({
  name: "proof-inbound",
  description: "Things from the proof's stub vendor, and its webhooks.",
  source: "proof-inbound",
  types: [
    {
      type: {
        id: "proof.thing",
        label: "Thing",
        description: "A thing from the proof's stub vendor.",
        fields: { title: { type: "string", required: true } },
      },
      fields: ["title"],
    },
  ],
  settings: [
    {
      name: "proof_vendor_url",
      label: "Proof vendor url",
      kind: "text",
      required: true,
    },
    {
      name: "proof_webhook_secret",
      label: "Proof webhook secret",
      kind: "text",
      secret: true,
      required: true,
    },
    {
      name: "proof_setup_path_file",
      label: "Proof setup path file",
      kind: "text",
    },
    { name: "proof_setup_fails", label: "Proof setup fails", kind: "text" },
  ],
  // Hands the proof the address it made, which the kit keeps out of the
  // log, so the proof can post to it.
  async setup({ env, endpoint }) {
    const made = await endpoint({
      label: "stub vendor",
      duplicateHeader: "X-GitHub-Delivery",
    });
    if (env.proof_setup_path_file !== undefined) {
      await writeFile(env.proof_setup_path_file, made.path);
    }
    if (env.proof_setup_fails === "true") {
      throw new Error("the stub vendor refused the setup");
    }
    return { proof_webhook_secret: "proof-setup-webhook-secret" };
  },
  async run({ env, signal, hints, upsert }) {
    const fetched = async (path: string): Promise<unknown> => {
      const response = await fetch(new URL(path, env.proof_vendor_url), {
        signal,
      });
      if (!response.ok) {
        throw new Error(`the stub vendor answered ${String(response.status)}`);
      }
      return response.json();
    };
    const things =
      hints === undefined
        ? ((await fetched("things")) as Thing[])
        : await Promise.all(
            [...(hints.get("proof.thing") ?? [])].map(
              async (id) =>
                (await fetched(`things/${encodeURIComponent(id)}`)) as Thing,
            ),
          );
    await upsert(
      "proof.thing",
      things.map((thing) => ({
        source_id: thing.id,
        properties: { title: thing.title },
      })),
    );
  },
  inbound: {
    verify: (delivery, env) =>
      verifyHmac({
        secret: env.proof_webhook_secret,
        body: delivery.body,
        signature: delivery.header("X-Hub-Signature-256"),
        prefix: "sha256=",
      }),
    hints: (delivery) => {
      const said = JSON.parse(new TextDecoder().decode(delivery.body)) as {
        id: string;
      };
      return [{ type: "proof.thing", id: said.id }];
    },
  },
});

if (isProgram(import.meta.url)) await main(connector);
