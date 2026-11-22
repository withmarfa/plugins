# @withmarfa/google

The Google sign-in that every Google connector shares. A connector built on it signs in to Google once, with one OAuth client and one refresh token, and the person never signs in again for each connector. This package is private to the workspace and is never published.

This page is reference. It describes what the package does, the conditions a person can meet and what to do about each. The setup steps for a person belong in the Marfa docs.

## The settings

Every Google connector declares the same three settings, exported as `googleSettings`. Marfa holds them, and the kit reads them at the start of every run.

| Setting                | Holds                                                                      |
| ---------------------- | -------------------------------------------------------------------------- |
| `google_client_id`     | The ID of a Desktop app OAuth client in the person's Google Cloud project. |
| `google_client_secret` | That client's secret. A secret, and required.                              |
| `google_refresh_token` | The one grant. A secret.                                                   |

The owner sets each with `marfa plugins settings <connector> --set google_client_id=<id>` and `marfa plugins secret <connector> <setting>`. A Google connector reads all three and writes none of them.

## Signing in

The package no longer signs the account in itself. Signing in through Marfa, which seals the refresh token into `google_refresh_token`, comes with the `sign_in` section of a Google connector's plugin in a later version. Until then, a Google connector starts only with a refresh token the owner already holds for the client, set with `marfa plugins secret <connector> google_refresh_token`; without one, it stops naming the setting.

## Use in a connector

```ts
import { connectGoogle, googleSettings } from "@withmarfa/google";

const scopes = ["https://www.googleapis.com/auth/calendar.readonly"];
const source = "google-calendar";
const needs = { source, scopes, types: ["google.calendar.event"] };

export default defineConnector({
  // ...
  source,
  settings: googleSettings,
  async run(context) {
    const google = connectGoogle(context, needs);
    const access = await google.ready();
    const body = await google.json(
      "https://www.googleapis.com/calendar/v3/...",
    );
  },
  async onChange(change, context) {
    const google = connectGoogle(context, needs);
    // google.fetch and google.json check the account before they send.
  },
});
```

- `connectGoogle(context, { source, scopes, types }, options?)` returns a `Google` for one run, `onChange`, `remake` or `preflight`. It takes the context the kit hands each of them, never a context from the run's `forScope`, which cannot keep the account: passing one throws. `source` is the connector's own `source`. `scopes` lists every scope the connector needs. `types` lists the connector's own types, whose rows hold the account in their `source_id`; see [One account per instance](#one-account-per-instance). An empty `source`, `scopes` or `types` throws.
- `options` can replace the Google endpoints, the clock and the request timeout. Tests use it to point a connector at a local stub.

### `google.ready()`

Call it once in a run, and await it before any other work with Marfa or Google, including reads. Where no account is kept, `ready` keeps it with a checkpoint that goes through the kit's serial scope operations, and the kit fails that checkpoint if any other row operation of the run, such as an `upsert` or a `held` read, is in progress at the same time. It:

1. Gets an access token, refreshing it when the process holds none or it is near its end. A grant Google already refused stops the run here.
2. Learns the signed-in account. It reads `sub` from the ID token and asks Google's userinfo endpoint where there is no ID token.
3. Checks the account as [One account per instance](#one-account-per-instance) describes. Where the connector keeps no account yet, it keeps this one, with a checkpoint of the connector's state, before the run writes a row.
4. Raises the notices and conditions below, and returns `Access`.

`Access` holds `account` (the account's `sub`), `granted` (the scopes the grant holds, or `undefined` where Google did not say), `missing` (the connector's scopes the grant lacks) and `has(scope)`.

Put `account` in each `source_id`, as `<account>:<id>`, so that two accounts never share a row.

### `google.fetch` and `google.json`

`fetch` checks the account first, once for each `Google`, as `ready` does, so a call from `onChange`, `remake` or `preflight` is never sent for another account than the one the connector keeps. It then sends the request with a bearer token. It accepts only `https` addresses on `googleapis.com` or a subdomain of it, so a link inside a response cannot send the token elsewhere. It does not follow redirects, and it times out. On a `401` it refreshes the access token once and sends the request once more.

`json` calls `fetch` and returns the parsed body, or `undefined` for an empty one. For an error answer it throws a `GoogleError`.

## One account per instance

A Marfa instance supports one Google account for its Google connectors. To use another Google account, use another Marfa instance.

Each connector keeps the account's `sub` in its state, under `google_account`, and checks every grant against it before the connector sends Google a request or writes to Marfa:

- **The first run.** Where the connector keeps no account, `ready` reads the rows of the connector's `types`, in every state, and judges only those written under the connector's `source`. If one of those holds a `source_id` that begins with another account, as `<sub>:`, the run fails with the account condition. A row from another source, such as one a person made, is never read for the account, whatever its `source_id` holds. Otherwise `ready` keeps the account at once, with a checkpoint of the connector's state, so it holds even if the run fails after writing rows.
- **After the state was cleared.** Clearing a connector's state also clears the kept account, but not its rows. The next run reads the rows as the first run does, so a grant for another account is refused while the first account's rows remain.
- **A later run.** A grant for another account fails the run with the account condition, and nothing is read or written.
- **`onChange`, `remake` and `preflight`.** Each makes its own `Google`, and some run before the run's own `ready`, so `fetch` and `json` check the grant against the kept account first. A grant for another account raises the account condition and throws a `GoogleError` of kind `account`, which fails the run, and nothing is sent. Where the connector keeps no account yet, they throw `Unreachable` with the scope `google:account`, so nothing is sent until a run has kept the account.
- **A run started between scheduled runs.** A run that a delivery or a change waiting in Marfa starts cannot take a checkpoint, so where no account is kept, it fails, and the next scheduled run keeps the account.

## Scopes are matched exactly

A scope counts as granted only when Google lists that exact scope. A broader scope the grant holds, such as `calendar`, is not counted as a narrower one, such as `calendar.readonly`. A connector declares the scopes it needs, and a person widens a grant by signing in again, not by Google implying a scope.

If Google's answer has no `scope` field at all, the connector proceeds, `missing` is empty and `granted` is `undefined`. A warning says so. A scope that is really missing then shows as a `403` from the API.

## Conditions

A condition appears on the connector in Marfa until a run no longer raises it. Each has a key, and each message names what to do.

| Key                            | Raised when                                                                                                                | What the person does                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `google:reconnect`             | Google answers `invalid_grant`: access was revoked, went unused for six months, ended, or the project is still in Testing. | Sign in again, set the new `google_refresh_token` for every Google connector, restart.                |
| `google:client`                | Google answers `invalid_client`.                                                                                           | Check `google_client_id` and `google_client_secret` are those of the Desktop app client, restart.     |
| `google:scope:<scope>`         | The grant lacks a scope the connector needs. One condition per scope.                                                      | Sign in again, leave every permission ticked, set the new token for every Google connector.           |
| `google:account`               | The grant belongs to another account than the one the connector keeps, or than the connector's rows came from.             | Sign in again with the original account, or use another instance.                                     |
| `google:refresh-token-changed` | Google issued a new refresh token during a run. The connector keeps it in memory only.                                     | Sign in again before the connector restarts, then set the new token for every Google connector.       |
| `google:refresh-token-expires` | Google granted time-based access, which ends on a stated date.                                                             | Before that date, sign in again, choose ongoing access, set the new token for every Google connector. |

After `google:reconnect` or `google:client`, the connector makes no further Google calls in that process. It does not retry a grant Google has already refused.

## How errors are classified

`google.json` and `google.fetch` callers see `GoogleError`, with a `kind`:

| Kind        | Google answered                                                                                                      | Meaning                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `reconnect` | `invalid_grant`                                                                                                      | The grant is over. Raises `google:reconnect`.                  |
| `client`    | `invalid_client`                                                                                                     | The client is wrong. Raises `google:client`.                   |
| `account`   | (not an answer)                                                                                                      | The grant belongs to another account. Raises `google:account`. |
| `passing`   | `429`, any `5xx`, a `403` with `rateLimitExceeded` or `userRateLimitExceeded`, no answer, or a body that is not JSON | It can pass. Try again later.                                  |
| `quota`     | A `403` with `quotaExceeded` or `dailyLimitExceeded`                                                                 | The usage limit holds until Google resets it.                  |
| `refused`   | Anything else                                                                                                        | Google will not take the request as it stands.                 |

A `Retry-After` header, as seconds or an HTTP date, sets `retryAt`. A past or invalid value is ignored, and no wait is believed beyond 24 hours.

`toChangeError(error)` turns a `GoogleError` into the kit's error for an `onChange` that fails: `passing` and `quota` become `Unreachable`, with `retryAt` where Google gave one, and `refused` becomes `Refused`. It returns `undefined` for any other error, which the caller rethrows.

## Sharing within one process

Every run and `onChange` in one process that uses the same client and refresh token shares one access token and one refresh. Once Google ends a grant, each later call in the process fails at once with the same error, and none calls Google again.
