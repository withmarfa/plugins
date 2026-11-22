import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createClient } from "@withmarfa/client";
import { check } from "./check.js";
import { ConnectorUnderProof, registration } from "./connector.js";
import { connectorKey, managerKeyAt, setSettings } from "./host.js";
import { installPlugin } from "./install.js";
import type { ProofServer } from "./server.js";
import { runMarfa } from "../release/plugins.ts";

const plugin = "google-calendar";
const entry = resolve(import.meta.dirname, "google-calendar-connector.js");
const clientId = "proof-client.apps.googleusercontent.com";
const clientSecret = "GOCSPX-proof-client-secret";
const calendarScopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

/**
 * Stands in for Google: the provider a sign-in exchanges its code with, which
 * the `sign-in-provider` fault points Marfa at, and the token, userinfo and
 * calendar list the connector reaches, which `PROOF_GOOGLE_URL` points it at.
 */
class Google {
  readonly tokens: URLSearchParams[] = [];
  /** The refresh token the sign-in was given. */
  issued: string | undefined;
  /** Whether Google has ended the grant. */
  ended = false;
  url = "";
  private server: Server | undefined;

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      void this.answer(request).then(([status, body]) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
    });
    const listening = this.server;
    await new Promise<void>((done) => listening.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${String((listening.address() as AddressInfo).port)}`;
    return this;
  }

  async stop(): Promise<void> {
    const closing = this.server;
    if (closing === undefined) return;
    await new Promise<void>((done) => {
      closing.close(() => {
        done();
      });
      closing.closeAllConnections();
    });
  }

  private async answer(request: IncomingMessage): Promise<[number, unknown]> {
    const path = new URL(request.url ?? "/", "http://stand-in").pathname;
    if (path === "/token") return this.token(await form(request));
    if (path === "/userinfo") return [200, { sub: "proof-account" }];
    if (path.endsWith("/calendarList")) return [200, { items: [] }];
    return [404, {}];
  }

  private token(sent: URLSearchParams): [number, unknown] {
    this.tokens.push(sent);
    if (sent.get("grant_type") === "authorization_code") {
      this.issued = `1//proof-refresh-token-${String(this.tokens.length)}`;
      return [
        200,
        { access_token: "ya29.sign-in", refresh_token: this.issued },
      ];
    }
    if (this.ended || sent.get("refresh_token") !== this.issued) {
      return [400, { error: "invalid_grant" }];
    }
    const payload = Buffer.from(
      JSON.stringify({ sub: "proof-account" }),
    ).toString("base64url");
    return [
      200,
      {
        access_token: `ya29.proof-${String(this.tokens.length)}`,
        expires_in: 3599,
        scope: ["openid", ...calendarScopes].join(" "),
        id_token: `e30.${payload}.signature`,
      },
    ];
  }
}

async function form(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Google Calendar signs in through Marfa: the instance installs the manifest's
 * `sign_in`, `marfa plugins sign-in` through a stand-in provider keeps the
 * token as the connector's secret, and the connector, which stops with exit 4
 * before that, runs on the token and stops with exit 4 again once Google ends
 * it. Needs a server built with test hooks, whose `sign-in-provider` fault
 * points the sign-in at the stand-in.
 */
export async function proveGoogleSignIn(
  url: string,
  armFault: ProofServer["armFault"],
): Promise<void> {
  const google = await new Google().start();
  const owner = createClient({ baseUrl: url, credential: managerKeyAt(url) });
  const asOwner = { MARFA_API_URL: url, MARFA_API_KEY: managerKeyAt(url) };
  try {
    await armFault("sign-in-provider", google.url);
    await check(
      "google-calendar: the instance installs the sign_in its manifest declares, and answers it as declared",
      async () => {
        await installPlugin(url, plugin, undefined);
        await setSettings(url, plugin, {
          google_client_id: clientId,
          google_client_secret: clientSecret,
        });
        const { data, error } = await owner.GET("/plugins/{name}", {
          params: { path: { name: plugin } },
        });
        if (data === undefined)
          throw new Error(`the plugin was refused: ${JSON.stringify(error)}`);
        const declared = JSON.stringify(data.connector?.sign_in);
        const wanted = JSON.stringify({
          kind: "oauth2",
          provider: "google",
          scopes: ["openid", ...calendarScopes],
          client_id_setting: "google_client_id",
          client_secret_setting: "google_client_secret",
          token_setting: "google_refresh_token",
        });
        if (declared !== wanted) {
          throw new Error(`the plugin answers ${declared}, not ${wanted}`);
        }
        return `sign_in ${declared}`;
      },
    );
    const key = await connectorKey(url, plugin);
    const connector = new ConnectorUnderProof(
      plugin,
      url,
      key.key,
      { PROOF_GOOGLE_URL: google.url },
      entry,
      false,
    );
    await check(
      "google-calendar: before the owner signs in, the connector stops with exit 4 and a condition naming `marfa plugins sign-in google-calendar`, and calls Google for nothing",
      async () => {
        const ran = await connector.once();
        const problems = (await registration(owner, key.id)).problems;
        const said = problems["google:sign-in"] ?? "";
        if (
          ran.code !== 4 ||
          !said.includes("`marfa plugins sign-in google-calendar`") ||
          google.tokens.length > 0
        ) {
          throw new Error(
            `exit ${String(ran.code)}, conditions ${JSON.stringify(problems)}, ${String(google.tokens.length)} calls to Google\n${ran.output}`,
          );
        }
        return `exit 4, condition google:sign-in, no call to Google`;
      },
    );
    await check(
      "google-calendar: `marfa plugins sign-in` through the stand-in provider keeps the refresh token the provider issued as the connector's secret",
      async () => {
        const printed = await runMarfa(["plugins", "sign-in", plugin], {
          env: asOwner,
        });
        const address = /https?:\/\/\S+/.exec(printed.stdout)?.[0] ?? "";
        const state = new URL(address || "http://none").searchParams.get(
          "state",
        );
        if (printed.code !== 0 || !address.startsWith(`${google.url}/`)) {
          throw new Error(
            `exit ${String(printed.code)}, printed ${printed.stdout}${printed.stderr}`,
          );
        }
        const back = await fetch(
          `${url}/connect/oauth/callback?${new URLSearchParams({ state: state ?? "", code: "proof-code" }).toString()}`,
          { redirect: "manual", headers: { accept: "text/html" } },
        );
        const status = await owner.GET("/plugins/{name}/connector/sign-in", {
          params: { path: { name: plugin } },
        });
        const exchange = google.tokens.find(
          (sent) => sent.get("grant_type") === "authorization_code",
        );
        if (
          back.status !== 200 ||
          status.data?.status !== "signed_in" ||
          google.issued === undefined ||
          exchange?.get("client_id") !== clientId ||
          exchange.get("client_secret") !== clientSecret
        ) {
          throw new Error(
            `callback ${String(back.status)}, status ${JSON.stringify(status.data ?? status.error)}, issued ${String(google.issued !== undefined)}`,
          );
        }
        return `the callback answered ${String(back.status)}, the sign-in is signed_in, and the provider was sent the client's ID and secret`;
      },
    );
    await check(
      "google-calendar: the connector then exchanges the kept token at Google and runs, never putting the token in its log",
      async () => {
        const before = google.tokens.length;
        const ran = await connector.once();
        const exchanged = google.tokens
          .slice(before)
          .filter((sent) => sent.get("grant_type") === "refresh_token");
        const used = exchanged.at(0)?.get("refresh_token");
        const run = (await registration(owner, key.id)).last_run;
        if (
          ran.code !== 0 ||
          used !== google.issued ||
          run?.outcome !== "succeeded" ||
          ran.output.includes(google.issued ?? "no token")
        ) {
          throw new Error(
            `exit ${String(ran.code)}, exchanged ${String(used)}, run ${String(run?.outcome)}\n${ran.output}`,
          );
        }
        return `exit 0, the run succeeded on the token the sign-in kept`;
      },
    );
    await check(
      "google-calendar: once Google ends the grant, the connector stops with exit 4 and a condition to sign in again, which a new sign-in mends",
      async () => {
        google.ended = true;
        const ran = await connector.once();
        const said =
          (await registration(owner, key.id)).problems["google:reconnect"] ??
          "";
        if (
          ran.code !== 4 ||
          !said.includes("`marfa plugins sign-in google-calendar`")
        ) {
          throw new Error(
            `exit ${String(ran.code)}, condition ${said}\n${ran.output}`,
          );
        }
        google.ended = false;
        const again = await runMarfa(["plugins", "sign-in", plugin], {
          env: asOwner,
        });
        const address = /https?:\/\/\S+/.exec(again.stdout)?.[0] ?? "";
        const state = new URL(address || "http://none").searchParams.get(
          "state",
        );
        await fetch(
          `${url}/connect/oauth/callback?${new URLSearchParams({ state: state ?? "", code: "proof-code-2" }).toString()}`,
          { redirect: "manual", headers: { accept: "text/html" } },
        );
        const mended = await connector.once();
        if (mended.code !== 0) {
          throw new Error(
            `exit ${String(mended.code)} after the new sign-in\n${mended.output}`,
          );
        }
        return "exit 4 with google:reconnect, then exit 0 after signing in again";
      },
    );
  } finally {
    await google.stop();
  }
}
