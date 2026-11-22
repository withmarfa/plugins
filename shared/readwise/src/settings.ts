import type { SettingsDeclaration } from "@withmarfa/connector";

/**
 * The settings both Readwise connectors declare, spread beside their own:
 * `settings: [...readwiseSettings, { name: "my_setting", ... }]`. The
 * defaults are the addresses and the size the code falls back to where a
 * setting is not set.
 */
export const readwiseSettings = [
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
    name: "readwise_reader_api_url",
    label: "Reader API address",
    kind: "text",
    default: "https://readwise.io/api/v3/",
  },
] as const satisfies SettingsDeclaration;
