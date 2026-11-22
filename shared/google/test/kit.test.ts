import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineConnector, exitCode } from "@withmarfa/connector";
import { start } from "../../../kit/test/installed.js";
import {
  Harness,
  linkedType,
  testFields,
  testType,
} from "../../../kit/test/harness.js";
import { connectGoogle, googleSettings } from "../src/index.js";
import { clientSettings, freshToken, GoogleStub } from "./stub.js";

const A = "https://www.googleapis.com/auth/a";
const B = "https://www.googleapis.com/auth/b";

let harness: Harness;
let stub: GoogleStub;
beforeEach(async () => {
  harness = await Harness.create();
  stub = await new GoogleStub().start();
});
afterEach(async () => {
  await harness.close();
  await stub.stop();
});

const types = [testType.id];
const source = "test";

function connector(scopes: string[], reads?: () => void) {
  return defineConnector({
    name: "test",
    source,
    types: [{ type: testType, fields: testFields }],
    settings: googleSettings,
    async run(context) {
      const google = connectGoogle(
        context,
        { plugin: "test", source, scopes, types },
        { endpoints: stub.endpoints },
      );
      await google.ready();
      reads?.();
    },
  });
}

/** A two-way connector that writes one row for the account, then fails
 *  where asked, and sends each row made in Marfa to Google. */
function writer(fails = false) {
  return defineConnector({
    name: "test",
    source,
    types: [{ type: linkedType, fields: testFields }],
    settings: googleSettings,
    async run(context) {
      const google = connectGoogle(
        context,
        { plugin: "test", source, scopes: [A], types },
        { endpoints: stub.endpoints },
      );
      const { account } = await google.ready();
      await context.upsert(testType.id, [
        {
          source_id: `${account}:event-1`,
          properties: { title: "Event", vendor_id: `${account}:event-1` },
        },
      ]);
      if (fails) throw new Error("Google stopped answering halfway");
    },
    async onChange(change, context) {
      const google = connectGoogle(
        context,
        { plugin: "test", source, scopes: [A], types },
        { endpoints: stub.endpoints },
      );
      await google.json(`${stub.url}/calendars/primary/events`, {
        method: "POST",
        body: JSON.stringify({ summary: change.item.properties["title"] }),
      });
      await context.setLink(change.item, `made-${change.item.id}`);
      return undefined;
    },
  });
}

const other = "sub-2222222222";

function signedIn(token = freshToken()) {
  harness.server.settings = {
    ...clientSettings,
    google_refresh_token: token,
  };
  return harness.runtime(["--once"]);
}

const posts = (): number =>
  stub.api.filter((call) => call.method === "POST").length;

/** Everything the run said and reported, where a secret must not be. */
function reported(): string {
  return [
    ...harness.lines,
    ...Object.values(harness.problems()),
    ...harness.server.runs.flatMap((run) => [
      run.error ?? "",
      run.summary ?? "",
    ]),
  ].join("\n");
}

describe("through the kit", () => {
  it("fails the run with one condition to reconnect where Google ends the grant, and leaks nothing", async () => {
    const token = freshToken();
    stub.onToken = () => ({
      status: 400,
      json: {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      },
    });
    let read = false;
    const exit = await start(
      connector([A], () => {
        read = true;
      }),
      signedIn(token),
    );
    expect(exit).toBe(exitCode.settings);
    expect(read).toBe(false);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(Object.keys(harness.problems())).toEqual(["google:reconnect"]);
    const said = reported();
    for (const value of [clientSettings.google_client_secret, token]) {
      expect(said).not.toContain(value);
    }
    // The witness: the kit does keep what a run raises where it reports.
    expect(said).toContain("`marfa plugins sign-in test`");
  });

  it("stops with exit 4 and a condition to sign in again where Google does not know the client", async () => {
    stub.onToken = () => ({
      status: 401,
      json: { error: "invalid_client", error_description: "Unknown client." },
    });
    expect(await start(connector([A]), signedIn())).toBe(exitCode.settings);
    expect(Object.keys(harness.problems())).toEqual(["google:client"]);
    expect(harness.problems()["google:client"]).toContain(
      "`marfa plugins sign-in test`",
    );
  });

  it("stops with exit 4 and a condition to sign in where no token was ever kept, without calling Google", async () => {
    harness.server.settings = { ...clientSettings };
    let read = false;
    const exit = await start(
      connector([A], () => {
        read = true;
      }),
      harness.runtime(["--once"]),
    );
    expect(exit).toBe(exitCode.settings);
    expect(read).toBe(false);
    expect(Object.keys(harness.problems())).toEqual(["google:sign-in"]);
    expect(harness.problems()["google:sign-in"]).toContain(
      "`marfa plugins sign-in test`",
    );
    expect(harness.lastRun().outcome).toBe("failed");
    expect(harness.lastRun().error).toContain("`marfa plugins sign-in test`");
    expect(stub.token).toHaveLength(0);
    expect(stub.api).toHaveLength(0);

    // The witness: the same connector with a token kept reads.
    expect(await start(connector([A]), signedIn())).toBe(0);
    expect(stub.token).toHaveLength(1);
  });

  it("stops the watch phase the same way where no token was kept, before it sends anything", async () => {
    harness.server.settings = { ...clientSettings };
    harness.server.insert(undefined, { title: "Mine" }, testType.id, "person");
    expect(await start(writer(), harness.runtime(["--once"]))).toBe(
      exitCode.settings,
    );
    expect(posts()).toBe(0);
    expect(Object.keys(harness.problems())).toContain("google:sign-in");
  });

  it("runs, and raises a condition naming a scope the person left unticked", async () => {
    stub.scope = `openid ${A}`;
    const token = freshToken();
    let read = false;
    const exit = await start(
      connector([A, B], () => {
        read = true;
      }),
      signedIn(token),
    );
    expect(exit).toBe(0);
    expect(read).toBe(true);
    expect(Object.keys(harness.problems())).toEqual([`google:scope:${B}`]);
    expect(harness.problems()[`google:scope:${B}`]).toContain(
      "`marfa plugins sign-in test`",
    );
    const said = reported();
    expect(said).not.toContain(token);
    expect(said).not.toContain("ya29.");
  });

  it("keeps the account before writing a row, so a run that fails after writing still holds it against another account", async () => {
    expect(await start(writer(true), signedIn())).toBe(1);
    expect(harness.server.row(`${stub.sub}:event-1`)).toBeDefined();
    expect(harness.kept()["state"]).toEqual({ google_account: stub.sub });

    stub.sub = other;
    expect(await start(writer(), signedIn())).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(Object.keys(harness.problems())).toContain("google:account");
    expect(
      harness.server.rows.filter((row) =>
        row.source_id?.startsWith(`${other}:`),
      ),
    ).toEqual([]);
    expect(harness.kept()["state"]).toEqual({
      google_account: "sub-1111111111",
    });
  });

  it("refuses another account after the connector's state was cleared, by the rows it holds", async () => {
    expect(await start(writer(), signedIn())).toBe(0);
    const cleared = (): void => {
      harness.server.states.delete(harness.server.keySource);
      harness.server.agreements.clear();
      harness.server.problems.delete(harness.server.keySource);
    };
    cleared();
    stub.sub = other;
    expect(await start(writer(), signedIn())).toBe(1);
    expect(Object.keys(harness.problems())).toContain("google:account");
    expect(
      harness.server.rows.filter((row) =>
        row.source_id?.startsWith(`${other}:`),
      ),
    ).toEqual([]);

    // The witness: the account the rows came from is kept again.
    cleared();
    stub.sub = "sub-1111111111";
    expect(await start(writer(), signedIn())).toBe(0);
    expect(harness.kept()["state"]).toEqual({
      google_account: "sub-1111111111",
    });
  });

  it("keeps the account on the first run beside another source's linked row whose source_id has a colon, and still refuses its own rows of another account", async () => {
    harness.server.insert(
      "ios:ABC-123",
      { title: "From the phone", vendor_id: "ABC-123" },
      testType.id,
      "person",
    );
    expect(await start(writer(), signedIn())).toBe(0);
    expect(Object.keys(harness.problems())).not.toContain("google:account");
    expect(harness.kept()["state"]).toEqual({ google_account: stub.sub });

    // The witness: a row of the connector's own source for another account
    // is refused once the kept account is cleared.
    harness.server.states.delete(harness.server.keySource);
    harness.server.agreements.clear();
    harness.server.problems.delete(harness.server.keySource);
    harness.server.insert(
      `${other}:event-9`,
      { title: "Another account's", vendor_id: `${other}:event-9` },
      testType.id,
    );
    expect(await start(writer(), signedIn())).toBe(1);
    expect(Object.keys(harness.problems())).toContain("google:account");
    expect(harness.kept()["state"]).toEqual({});
  });

  it("sends nothing from the watch phase once the account changed, and raises the account condition", async () => {
    expect(await start(writer(), signedIn())).toBe(0);
    harness.server.insert(undefined, { title: "Mine" }, testType.id, "person");
    stub.sub = other;
    expect(await start(writer(), signedIn())).toBe(1);
    expect(posts()).toBe(0);
    expect(Object.keys(harness.problems())).toContain("google:account");

    // The witness: the account the rows came from sends the queued create.
    stub.sub = "sub-1111111111";
    expect(await start(writer(), signedIn())).toBe(0);
    expect(posts()).toBe(1);
  });
});
