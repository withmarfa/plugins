import type { SettingsDeclaration } from "@withmarfa/connector";

/**
 * The defaults are the addresses and the size the code falls back to where a
 * setting is not set. Writes to Reader use the `readwise_reader_*` settings
 * only while `readwise_reader` is on. The Reader API address is also used to
 * refresh a row Reader managed before that setting was turned off.
 */
export const settings = [
  {
    name: "readwise_account",
    label: "Account name",
    kind: "text",
    required: true,
  },
  {
    name: "readwise_access_token",
    label: "Readwise access token",
    kind: "text",
    secret: true,
    required: true,
  },
  {
    name: "readwise_api_url",
    label: "Readwise API address",
    kind: "text",
    default: "https://readwise.io/api/v2/",
  },
  {
    name: "readwise_content_max_bytes",
    label: "Largest saved document in bytes",
    kind: "number",
    default: 268435456,
  },
  {
    name: "readwise_reader",
    label: "Include Readwise Reader",
    kind: "boolean",
    default: false,
  },
  {
    name: "readwise_reader_api_url",
    label: "Reader API address",
    kind: "text",
    default: "https://readwise.io/api/v3/",
  },
  {
    name: "readwise_reader_include_feed",
    label: "Include the Reader feed",
    kind: "boolean",
    default: false,
  },
  {
    name: "readwise_reader_pictures",
    label: "Reader pictures",
    kind: "choice",
    choices: ["addresses", "save", "save-in-library"],
    default: "addresses",
  },
  {
    name: "readwise_reader_inbound_only",
    label: "Never send edits to Reader",
    kind: "boolean",
    default: false,
  },
  {
    name: "readwise_reader_propagate_purge",
    label: "Delete from Reader what is purged in Marfa",
    kind: "boolean",
    default: false,
  },
] as const satisfies SettingsDeclaration;
