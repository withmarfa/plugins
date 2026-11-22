import type { SettingsDeclaration } from "@withmarfa/connector";

/**
 * What every Google connector declares in its `settings`, spread beside its
 * own: `settings: [...googleSettings, { name: "my_setting", ... }]`. The
 * client is the person's own Desktop app client, a setting and never code. A
 * Desktop client's secret is not confidential, but Google's token endpoint
 * asks for it, so it stays out of the logs like the refresh token.
 */
export const googleSettings = [
  {
    name: "google_client_id",
    label: "Google client ID",
    kind: "text",
    required: true,
  },
  {
    name: "google_client_secret",
    label: "Google client secret",
    kind: "text",
    secret: true,
    required: true,
  },
  {
    name: "google_refresh_token",
    label: "Google refresh token",
    kind: "text",
    secret: true,
    required: true,
  },
] as const satisfies SettingsDeclaration;
