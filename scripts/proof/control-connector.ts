import { readFileSync } from "node:fs";
import {
  defineConnector,
  main,
  type Entry,
  type SettingsDeclaration,
} from "@withmarfa/connector";
import { isProgram } from "./program.js";

const source = "proof-control";
const type = "proof.control.note";

/** The notes the vendor holds, read again at the start of every run from the
 *  file the proof writes, as `[id, title, body]` triples. */
function entries(): Entry[] {
  const file = process.env["PROOF_ENTRIES_FILE"];
  if (file === undefined) return [];
  const held = JSON.parse(readFileSync(file, "utf8")) as [
    string,
    string,
    string,
  ][];
  return held.map(([id, title, body]) => ({
    source_id: id,
    properties: { title, body },
  }));
}

const settings = [
  {
    name: "note_limit",
    label: "Most notes a run brings",
    kind: "number",
    default: 10,
  },
] as const satisfies SettingsDeclaration;

export const connector = defineConnector({
  name: source,
  description: "The proof's notes, which the owner can pause and run now.",
  source,
  types: [
    {
      name: "note",
      type: {
        id: type,
        label: "Note",
        description: "A note from the proof's vendor.",
        fields: {
          title: { type: "string", required: true },
          body: { type: "string" },
        },
      },
      fields: ["title", "body"],
    },
  ],
  settings,
  async run(context) {
    await context.upsert(type, entries().slice(0, context.env.note_limit));
  },
});

if (isProgram(import.meta.url)) await main(connector);
