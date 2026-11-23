# Google Calendar

Reads the calendars and events of one Google account into Marfa, and carries changes made to events in Marfa back to Google Calendar. It never invites anyone and never has Google email anyone. It signs in to Google through Marfa, with a Web application client you create in your own Google Cloud project.

## What it brings

| Kind       | Type                       | Carries changes back |
| ---------- | -------------------------- | -------------------- |
| `calendar` | `google.calendar.calendar` | No                   |
| `event`    | `google.calendar.event`    | Yes                  |

## Add it

1. Install the plugin: `marfa plugins install google-calendar`.
2. Assign it to a connector host: `marfa plugins assign google-calendar --host <host>`. The host mints the connector's key.
3. In your Google Cloud project, turn on the Google Calendar API, configure the OAuth consent screen, and create an OAuth client of the type **Web application**.
   - While the consent screen is in Testing, add your Google account as a test user. Google ends the sign-in after 7 days for an External app, so publish the app for a lasting one.
   - Add `<sign-in address>/connect/oauth/callback` as an authorized redirect URI. Google accepts only an HTTPS address on a domain name, not an IP address. `localhost` is the one exception.
4. Store the client: `marfa plugins settings google-calendar --set google_client_id=<client ID>`, then `marfa plugins secret google-calendar google_client_secret`.
5. Sign in, open the address it prints in a browser, and choose the account: `marfa plugins sign-in google-calendar --wait`.
6. Optionally map the kinds to your own types and tiers: `marfa plugins mapping show google-calendar`, then `marfa plugins mapping set google-calendar <file>`.

Until you sign in, the connector stops with the condition `google:sign-in`.

## Read more

- Marfa's docs: [Google Calendar](https://docs.marfa.so/catalog/connectors/google-calendar) and [Give a plugin's connector access to your Google account](https://docs.marfa.so/use/connector-google-access).
- Every setting, with its default: [`plugin/plugin.json`](./plugin/plugin.json).
