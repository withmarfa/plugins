import { defineConnector, main, type Entry } from "@withmarfa/connector";
import { isProgram } from "./program.js";
export interface RetryConfig {
  mode?: "refetch" | "replay";
  context: string;
  maxLength: number;
  page: number;
  entries: Entry[];
  retrySaved: boolean;
  rootState?: boolean;
  conditions?: number;
  notModified?: boolean;
}
const source = process.env["PROOF_SOURCE"] ?? "proof-retry";
const url = process.env["PROOF_CONTROL_URL"];
const program = isProgram(import.meta.url);
if (program && url === undefined) throw new Error("no owned retry source");
// Imported to read its definition, the connector holds only what the type
// needs: the control address, and the longest title, are the proof's to say.
const config: RetryConfig =
  program && url !== undefined
    ? ((await (await fetch(url)).json()) as RetryConfig)
    : {
        context: "",
        maxLength: Number(process.env["PROOF_MAX_LENGTH"] ?? 10),
        page: 1,
        entries: [],
        retrySaved: false,
      };
const type = `proof.${source}.item`,
  related = `proof.${source}.related`;
export const connector = defineConnector({
  name: source,
  source,
  description: "Durable inbound retry proof",
  types: [
    {
      type: {
        id: type,
        label: "Retry item",
        link_field: "vendor_id",
        fields: {
          title: {
            type: "string",
            required: true,
            max_length: config.maxLength,
          },
          vendor_id: { type: "string" },
          note: { type: "string" },
        },
      },
      fields: ["title", "vendor_id", "note"],
    },
  ],
  connections: [
    {
      id: related,
      cardinality: "many-to-many",
      from_type_constraints: [type],
      to_type_constraints: [type],
    },
  ],
  settings: [
    {
      name: "proof_control_url",
      label: "Proof control url",
      kind: "text",
      required: true,
    },
  ],
  async run(context) {
    for (let index = 0; index < (config.conditions ?? 0); index++)
      context.log.condition(
        `generic-${String(index)}`,
        `Generic ${String(index)}`,
      );
    if (config.rootState === true) {
      context.state.set("page", config.page);
      return;
    }
    const scope = context.forScope(
      "page",
      config.mode === undefined
        ? undefined
        : { retry: { mode: config.mode, context: config.context } },
    );
    const listing = await fetch(`${context.env.proof_control_url}/entries`, {
      headers: { "If-None-Match": '"owned"' },
    });
    if (!listing.ok && listing.status !== 304)
      throw new Error(`Listing failed: ${String(listing.status)}`);
    const entries =
      listing.status === 304 ? [] : ((await listing.json()) as Entry[]);
    const current = new Set(entries.map((entry) => entry.source_id));
    const attempts = [...entries];
    if (config.retrySaved)
      for (const { record, due } of scope.refusals.pending()) {
        if (!due || current.has(record.identity.sourceId)) continue;
        if (record.mode === "replay") attempts.push(record.intent.entry);
        else {
          const response = await fetch(
            `${context.env.proof_control_url}/refetch/${encodeURIComponent(record.identity.sourceId)}`,
          );
          if (response.ok) attempts.push((await response.json()) as Entry);
        }
      }
    await scope.upsert(type, attempts);
    const result = await scope.state.checkpoint("page", config.page);
    await fetch(context.env.proof_control_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, pending: scope.refusals.pending() }),
    });
    if (!result.committed)
      throw new Error(`Checkpoint blocked: ${result.reason}`);
  },
});

if (program) await main(connector);
