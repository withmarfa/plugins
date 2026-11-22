import type { Condition } from "./errors.js";

/** At most 500 characters each, the longest the kit keeps. */

/** What signs the owner in, as every message names it. */
function signIn(plugin: string): string {
  return `\`marfa plugins sign-in ${plugin}\``;
}

export function signInCondition(plugin: string): Condition {
  return {
    key: "google:sign-in",
    message: `This connector has not signed in to Google yet, so it makes no Google calls. Sign in with ${signIn(plugin)} and open the address it prints.`,
  };
}

export function reconnectCondition(plugin: string): Condition {
  return {
    key: "google:reconnect",
    message: `Google no longer accepts this connector's sign-in (invalid_grant): access was revoked, went unused for six months, was granted for a limited time that ended, the project is still in Testing, or an administrator blocked it. Sign in again with ${signIn(plugin)}. Until the token changes, this connector makes no Google calls.`,
  };
}

export function clientCondition(plugin: string, code: string): Condition {
  return {
    key: "google:client",
    message: `Google does not accept this connector's OAuth client (${code}). Check that google_client_id and google_client_secret are those of a Web application client in your Google Cloud project, then sign in again with ${signIn(plugin)}. Until the settings change, this connector makes no Google calls.`,
  };
}

export function scopeCondition(plugin: string, scope: string): Condition {
  return {
    key: `google:scope:${scope}`,
    message: `Google did not grant ${scope}, which this connector needs, so nothing that needs it runs. Sign in again with ${signIn(plugin)} and leave every permission ticked on Google's consent screen.`,
  };
}

export function accountCondition(plugin: string): Condition {
  return {
    key: "google:account",
    message: `The rows of this connector came from a different Google account than the one google_refresh_token now signs in to, so nothing was read or written. Sign in with the original account, using ${signIn(plugin)}, or give the other account its own Marfa instance.`,
  };
}

export function newTokenCondition(plugin: string): Condition {
  return {
    key: "google:refresh-token-changed",
    message: `Google issued this connector a new refresh token, which it keeps in memory only. Before it restarts, sign in again with ${signIn(plugin)}; the token it started with may stop working.`,
  };
}

/** A time as the person reads it in a message: `2026-10-30 at 09:00 UTC`. */
export function when(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}

export function endsCondition(plugin: string, endsAt: Date): Condition {
  return {
    key: "google:refresh-token-expires",
    message: `The Google account granted time-based access, which ends on ${when(endsAt)}, after which this connector can no longer read Google. Before then, sign in again with ${signIn(plugin)} and choose ongoing access on Google's consent screen.`,
  };
}
