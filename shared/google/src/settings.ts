import type { SettingsDeclaration, SignIn } from "@withmarfa/connector";

/**
 * What every Google connector declares in its `settings`, spread beside its
 * own: `settings: [...googleSettings, { name: "my_setting", ... }]`. The
 * client is the owner's own Web application client, a setting and never
 * code. The refresh token is not set by hand: `marfa plugins sign-in` gets it
 * through Marfa and keeps it, so it is not required to start.
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
  },
] as const satisfies SettingsDeclaration;

/**
 * A Google connector's `signIn`, asking for `scopes` and the account's
 * identity (`openid`), which the connector uses to keep one account's rows
 * apart from another's.
 */
export function googleSignIn(scopes: readonly string[]): SignIn {
  return {
    kind: "oauth2",
    provider: "google",
    scopes: ["openid", ...scopes],
    clientIdSetting: "google_client_id",
    clientSecretSetting: "google_client_secret",
    tokenSetting: "google_refresh_token",
  };
}
