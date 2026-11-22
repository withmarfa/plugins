import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineConnector, type SettingsDeclaration } from "../src/define.js";
import { exitCode } from "../src/exit.js";
import { start } from "./installed.js";
import {
  Harness,
  closedUrl,
  secretToken,
  testConnector,
  testFields,
  testType,
  vendor,
} from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const minute = 60_000;
const entry = { source_id: "a:1", properties: { title: "One" } };

const typedSettings = [
  {
    name: "test_token",
    label: "Test token",
    kind: "text",
    secret: true,
    required: true,
  },
  { name: "test_on", label: "Turned on", kind: "boolean", default: true },
  { name: "test_limit", label: "Limit", kind: "number", default: 10 },
  {
    name: "test_mode",
    label: "Mode",
    kind: "choice",
    choices: ["fast", "slow"],
    default: "fast",
  },
  { name: "test_note", label: "Note", kind: "text" },
] as const satisfies SettingsDeclaration;

type Seen = Record<string, unknown>;

/** A connector that writes one row and keeps what each run read. */
function typed(seen: Seen[], more: { secretOut?: boolean } = {}) {
  return defineConnector({
    name: "test",
    source: "test",
    types: [{ type: testType, fields: testFields }],
    settings: typedSettings,
    checkEnv(env) {
      if (env.test_limit < 0) throw new Error("Limit must not be negative");
    },
    async run(context) {
      const { env } = context;
      seen.push({ ...env });
      if (more.secretOut === true) {
        context.log.info(`the token is ${env.test_token}`);
        context.log.condition("token", `the token ${env.test_token} expired`);
        await context.upsert(testType.id, [entry]);
        throw new Error(`the vendor refused ${env.test_token}`);
      }
      await context.upsert(testType.id, [entry]);
    },
  });
}

function everything(): string {
  return [
    ...harness.lines,
    JSON.stringify(harness.server.runs),
    JSON.stringify(harness.server.problems.get(harness.server.keySource) ?? {}),
  ].join("\n");
}

describe("settings read from Marfa", () => {
  it("reads only MARFA_API_URL and MARFA_API_KEY from the environment", async () => {
    const seen: Seen[] = [];
    harness.server.settings = {
      test_token: secretToken,
      test_note: "from Marfa",
    };
    const code = await start(
      typed(seen),
      harness.runtime(["--once"], {
        TEST_NOTE: "from the environment",
        TEST_TOKEN: "an-environment-token",
      }),
    );
    expect(code).toBe(exitCode.stopped);
    expect(seen[0]?.["test_note"]).toBe("from Marfa");
    expect(seen[0]?.["test_token"]).toBe(secretToken);
  });

  it("hands each value to the connector typed by its kind, with the declared default for one not set", async () => {
    const seen: Seen[] = [];
    harness.server.settings = {
      test_token: secretToken,
      test_on: false,
      test_limit: 3,
      test_mode: "slow",
    };
    expect(await start(typed(seen), harness.runtime(["--once"]))).toBe(
      exitCode.stopped,
    );
    expect(seen).toEqual([
      {
        test_token: secretToken,
        test_on: false,
        test_limit: 3,
        test_mode: "slow",
        test_note: undefined,
      },
    ]);

    seen.length = 0;
    harness.server.settings = { test_token: secretToken };
    expect(await start(typed(seen), harness.runtime(["--once"]))).toBe(
      exitCode.stopped,
    );
    expect(seen).toEqual([
      {
        test_token: secretToken,
        test_on: true,
        test_limit: 10,
        test_mode: "fast",
        test_note: undefined,
      },
    ]);
  });

  it("reads the settings at the start of every run, so a value changed between runs is the next run's", async () => {
    const seen: Seen[] = [];
    harness.server.settings = { test_token: secretToken, test_limit: 1 };
    const exit = start(typed(seen), harness.runtime(["--every", "15m"]));
    await harness.clock.sleeping(15 * minute);
    expect(seen.map((one) => one["test_limit"])).toEqual([1]);
    harness.server.settings = { test_token: secretToken, test_limit: 2 };
    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    harness.stop();
    expect(await exit).toBe(exitCode.stopped);
    expect(seen.map((one) => one["test_limit"])).toEqual([1, 2]);
    expect(harness.server.settingsReads).toBe(2);
  });

  it("builds a connector whose shape depends on its settings again for each run", async () => {
    const shapes: boolean[] = [];
    const build = (env: { test_on?: boolean }) => {
      shapes.push(env.test_on !== false);
      return typed([]);
    };
    harness.server.settings = { test_token: secretToken, test_on: false };
    expect(await start(build as never, harness.runtime(["--once"]), {})).toBe(
      exitCode.stopped,
    );
    // For the installed plugin, for the start's checks, then for the run.
    expect(shapes).toEqual([true, true, false]);
  });

  it("stops the run when a required setting is not set, naming each by label and name, and exits 4 having written nothing", async () => {
    harness.server.settings = {};
    const code = await start(typed([]), harness.runtime(["--once"]));
    expect(code).toBe(exitCode.settings);
    expect(harness.server.rows).toEqual([]);
    const run = harness.lastRun();
    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("Test token (test_token)");
    expect(run.error).toContain("marfa plugins secret test test_token");
    expect(harness.lines.join("\n")).toContain("Test token (test_token)");
  });

  it("names a setting the door lists as missing, though the build does not require it", async () => {
    harness.server.settings = { test_token: secretToken };
    harness.server.missing = ["test_note"];
    expect(await start(typed([]), harness.runtime(["--once"]))).toBe(
      exitCode.settings,
    );
    expect(harness.lastRun().error).toContain("Note (test_note)");
  });

  it("stops the run on a secret Marfa cannot open, naming it and never a value", async () => {
    harness.server.settings = {};
    harness.server.unreadable.add("test_token");
    harness.server.missing = ["test_token"];
    expect(await start(typed([]), harness.runtime(["--once"]))).toBe(
      exitCode.settings,
    );
    const error = harness.lastRun().error ?? "";
    expect(error).toContain("cannot open for Test token (test_token)");
    expect(error).not.toContain("not set");
    expect(harness.server.rows).toEqual([]);
  });

  it("stops the run on a value of the wrong kind, or one the connector refuses, written to between runs, and exits 4", async () => {
    const seen: Seen[] = [];
    harness.server.settings = { test_token: secretToken };
    const exit = start(typed(seen), harness.runtime(["--every", "15m"]));
    await harness.clock.sleeping(15 * minute);
    const rows = harness.server.rows.length;
    harness.server.settings = { test_token: secretToken, test_on: "false" };
    await harness.clock.wake(15 * minute);
    expect(await exit).toBe(exitCode.settings);
    expect(seen).toHaveLength(1);
    expect(harness.server.rows).toHaveLength(rows);
    expect(harness.lastRun().error).toContain(
      "Turned on (test_on) is not true or false",
    );

    harness.server.settings = { test_token: secretToken, test_limit: -1 };
    expect(await start(typed(seen), harness.runtime(["--once"]))).toBe(
      exitCode.settings,
    );
    expect(seen).toHaveLength(1);
    expect(harness.lastRun().error).toContain("Limit must not be negative");
  });

  it("refuses a secret too short to keep out of the logs, without showing it", async () => {
    harness.server.settings = { test_token: "short" };
    expect(await start(typed([]), harness.runtime(["--once"]))).toBe(
      exitCode.settings,
    );
    expect(harness.lastRun().error).toContain(
      "Test token (test_token) is shorter than 8 characters",
    );
  });

  it("keeps a secret's value out of every log line, condition, run report and error, whatever characters it holds", async () => {
    const secret = 'tok "quoted" \\ back\nslash/+&=%';
    harness.server.settings = { test_token: secret };
    const code = await start(
      typed([], { secretOut: true }),
      harness.runtime(["--once"]),
    );
    expect(code).toBe(exitCode.failed);
    const said = everything();
    expect(said).toContain("[redacted]");
    for (const spelling of [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      "back\nslash",
      '"quoted"',
    ]) {
      expect(said).not.toContain(spelling);
    }
  });

  it("witness: the same connector with the secret in a setting that is not secret says it", async () => {
    const value = "not-a-secret-value-123";
    const open = defineConnector({
      name: "test",
      source: "test",
      types: [{ type: testType, fields: testFields }],
      settings: [
        { name: "test_note", label: "Note", kind: "text", required: true },
      ] as const,
      async run(context) {
        context.log.info(`the note is ${context.env.test_note}`);
        await context.upsert(testType.id, [entry]);
      },
    });
    harness.server.settings = { test_note: value };
    expect(await start(open, harness.runtime(["--once"]))).toBe(0);
    expect(everything()).toContain(value);
  });

  it("says, and exits 3, when the settings door refuses the key as not the one a connector host minted", async () => {
    harness.server.hosted = false;
    const code = await start(typed([]), harness.runtime(["--once"]));
    expect(code).toBe(exitCode.key);
    expect(harness.lines.join("\n")).toContain(
      "is not the key a connector host minted for the test plugin's connector",
    );
    expect(harness.server.rows).toEqual([]);
  });

  it("starts a connector that declares no setting without reading the settings door", async () => {
    harness.server.hosted = false;
    const bare = defineConnector({
      name: "test",
      source: "test",
      types: [{ type: testType, fields: testFields }],
      async run(context) {
        await context.upsert(testType.id, [entry]);
      },
    });
    expect(await start(bare, harness.runtime(["--once"]))).toBe(
      exitCode.stopped,
    );
    expect(harness.server.settingsReads).toBe(0);
  });

  it("registers again with the types its settings carry back once it has read them", async () => {
    const twoWay = defineConnector({
      ...typed([]),
      types: [
        {
          type: { ...testType, link_field: "title" },
          fields: testFields,
        },
      ],
      carries: (env) => (env.test_on ? [testType.id] : []),
      onChange: () => Promise.resolve(undefined),
    });
    harness.server.settings = { test_token: secretToken, test_on: true };
    expect(await start(twoWay, harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.readOnlyTypes).toEqual([]);
    expect(harness.server.registrations).toBe(2);

    harness.server.settings = { test_token: secretToken, test_on: false };
    expect(await start(twoWay, harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.readOnlyTypes).toEqual([testType.id]);
    expect(harness.server.registrations).toBe(3);
  });
});

describe("what Marfa holds", () => {
  function twoWay(seen: Seen[] = []) {
    return defineConnector({
      ...typed(seen),
      types: [
        {
          type: { ...testType, link_field: "title" },
          fields: testFields,
        },
      ],
      carries: () => [testType.id],
      onChange: () => Promise.resolve(undefined),
    });
  }

  it("registers again where the registration holds other read-only types than its settings make, as after a setup or a second start beside it", async () => {
    harness.server.settings = { test_token: secretToken, test_on: true };
    const exit = start(
      twoWay(),
      harness.runtime(["--every", "15m", "--look-every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    expect(harness.server.readOnlyTypes).toEqual([]);
    harness.server.readOnlyTypes = [testType.id];
    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    expect(harness.server.readOnlyTypes).toEqual([]);
    harness.stop();
    expect(await exit).toBe(exitCode.stopped);
  });

  it("redacts a setting Marfa holds as secret, though the build does not declare it so", async () => {
    const value = "a-value-marfa-holds-secret";
    const open = defineConnector({
      name: "test",
      source: "test",
      types: [{ type: testType, fields: testFields }],
      settings: [
        { name: "test_note", label: "Note", kind: "text", required: true },
      ] as const,
      async run(context) {
        context.log.info(`the note is ${context.env.test_note}`);
        await context.upsert(testType.id, [entry]);
      },
    });
    harness.server.settings = { test_note: value };
    harness.server.secrets.add("test_note");
    expect(await start(open, harness.runtime(["--once"]))).toBe(0);
    expect(everything()).toContain("[redacted]");
    expect(everything()).not.toContain(value);

    harness.server.settings = { test_note: "short" };
    expect(await start(open, harness.runtime(["--once"]))).toBe(
      exitCode.settings,
    );
    expect(harness.lastRun().error).toContain(
      "Note (test_note) is shorter than 8 characters",
    );
  });

  it("registers again where the settings door loses a registration it answered for, before the heartbeat runs", async () => {
    const seen: Seen[] = [];
    harness.server.settings = { test_token: secretToken };
    const exit = start(typed(seen), harness.runtime(["--every", "15m"]));
    await harness.clock.sleeping(15 * minute);
    harness.server.lost = true;
    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    expect(harness.server.registrations).toBe(2);
    expect(seen).toHaveLength(2);
    harness.stop();
    expect(await exit).toBe(exitCode.stopped);
  });

  it("stops with exit 3, before the run, where the key was widened while it ran", async () => {
    const held = vendor([entry]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    harness.server.grants = { permissions: ["items.read"] };
    await harness.clock.wake(15 * minute);
    const ended = await Promise.race([
      exit,
      harness.clock.sleeping(15 * minute).then(() => "ran again"),
    ]);
    expect(ended).toBe(exitCode.key);
    expect(held.runs).toBe(1);
    expect(harness.lastRun().error).toContain("items.read");
  });
});

describe("the key", () => {
  it("accepts the key a connector host mints: its own source, write on its kinds' types, nothing else", async () => {
    expect(
      await start(testConnector(vendor([entry])), harness.runtime(["--once"])),
    ).toBe(exitCode.stopped);
  });

  it.each([
    ["a claimed source", { sources: ["other"] }, "claims sources"],
    ["a permission", { permissions: ["items.read"] }, "items.read"],
    [
      "another type",
      { type_permissions: { [testType.id]: "write", "other.thing": "read" } },
      "type other.thing=read",
    ],
    [
      "a metadata entry",
      { metadata_permissions: { title: "write" } },
      "metadata title=write",
    ],
  ])("refuses a key holding %s with exit 3", async (_, grants, said) => {
    harness.server.grants = grants;
    const code = await start(
      testConnector(vendor([entry])),
      harness.runtime(["--once"]),
    );
    expect(code).toBe(exitCode.key);
    expect(harness.lines.join("\n")).toContain(said);
    expect(harness.server.rows).toEqual([]);
  });

  it("refuses with exit 3 a key Marfa refuses at the start, and one revoked between runs", async () => {
    harness.server.revoked = true;
    expect(
      await start(testConnector(vendor([entry])), harness.runtime(["--once"])),
    ).toBe(exitCode.key);

    harness.server.revoked = false;
    const held = vendor([entry]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    harness.server.revoked = true;
    await harness.clock.wake(15 * minute);
    expect(await exit).toBe(exitCode.key);
    expect(held.runs).toBe(1);
  });
});

describe("exit codes", () => {
  it("exits 0 once stopped", async () => {
    const exit = start(
      testConnector(vendor([entry])),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    harness.stop();
    expect(await exit).toBe(exitCode.stopped);
  });

  it("exits 1 for a run that fails, and for a Marfa that does not answer a start run once", async () => {
    const held = vendor([entry]);
    held.fail = new Error("the vendor answered 502");
    expect(await start(testConnector(held), harness.runtime(["--once"]))).toBe(
      exitCode.failed,
    );
    expect(
      await start(
        testConnector(vendor([entry])),
        harness.runtime(["--once"], { MARFA_API_URL: await closedUrl() }),
      ),
    ).toBe(exitCode.failed);
  });

  it("exits 2 for a command line or a definition that is wrong", async () => {
    expect(
      await start(
        testConnector(vendor()),
        harness.runtime(["--every", "soon"]),
      ),
    ).toBe(exitCode.definition);
    expect(
      await start(
        { ...testConnector(vendor()), source: "oauth:test" },
        harness.runtime(["--once"]),
      ),
    ).toBe(exitCode.definition);
    expect(harness.server.requests).toEqual([]);
  });
});
