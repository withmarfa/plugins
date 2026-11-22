import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const entry = { source_id: "a:1", properties: { title: "One" } };

describe("configuration", () => {
  it("refuses to start without a required value, naming every one missing", async () => {
    expect(await harness.once(vendor([entry]))).toBe(0);
    const reached = harness.server.requests.length;
    expect(reached).toBeGreaterThan(0);

    const required = ["MARFA_API_URL", "MARFA_API_KEY"];
    for (const name of required) {
      harness.lines.length = 0;
      expect(await harness.once(vendor([entry]), { [name]: undefined })).toBe(
        2,
      );
      expect(harness.lines.join("\n")).toContain(
        `cannot start without ${name} in the environment`,
      );
    }
    harness.lines.length = 0;
    const code = await harness.once(
      vendor([entry]),
      Object.fromEntries(required.map((name) => [name, " "])),
    );
    expect(code).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      `cannot start without ${required.join(", ")} in the environment`,
    );
    expect(harness.server.requests.length).toBe(reached);
  });

  it("refuses to start on the old names alone, naming the ones it needs", async () => {
    const server = harness.server.url;
    const code = await harness.once(vendor([entry]), {
      MARFA_API_URL: undefined,
      MARFA_API_KEY: undefined,
      MARFA_URL: server,
      MARFA_KEY: "marfa_k1_the_old_name_holds_a_key",
    });
    expect(code).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "cannot start without MARFA_API_URL, MARFA_API_KEY in the environment",
    );
    expect(harness.server.requests).toEqual([]);
  });

  it("takes an optional value as absent when it is unset", async () => {
    let region: string | undefined = "unread";
    const connector = testConnector(vendor());
    const run = connector.run.bind(connector);
    const code = await start(
      {
        ...connector,
        run: async (context) => {
          region = context.env.test_region;
          await run(context);
        },
      },
      harness.runtime(["--once"]),
    );
    expect(code).toBe(0);
    expect(region).toBeUndefined();
  });

  it("refuses a schedule it cannot read", async () => {
    for (const argv of [
      [],
      ["--every"],
      ["--every", "soon"],
      ["--once", "--every", "1m"],
    ]) {
      expect(await start(testConnector(vendor()), harness.runtime(argv))).toBe(
        2,
      );
    }
    expect(harness.server.requests).toEqual([]);
    expect(
      await start(testConnector(vendor()), harness.runtime(["--once"])),
    ).toBe(0);
    expect(harness.server.requests.length).toBeGreaterThan(0);
  });

  it("says what to run it with when it is given nothing, and on --help", async () => {
    expect(await start(testConnector(vendor()), harness.runtime([]))).toBe(2);
    expect(harness.lines.join("\n")).not.toContain('got ""');
    expect(harness.lines.join("\n")).toContain("no schedule was given");
    harness.lines.length = 0;
    expect(
      await start(testConnector(vendor()), harness.runtime(["--help"])),
    ).toBe(0);
    const help = harness.lines.join("\n");
    expect(help).toContain("--every");
    expect(help).toContain("MARFA_API_URL");
    expect(help).toContain("test_token (Test token, text, secret)");
    expect(help).toContain("marfa plugins settings test");
    expect(help).not.toContain("TEST_TOKEN");
    expect(help).toContain("as the template's README says");
    harness.lines.length = 0;
    await start(
      { ...testConnector(vendor()), readme: "connectors/test/README.md" },
      harness.runtime(["--help"]),
    );
    expect(harness.lines.join("\n")).toContain(
      "as connectors/test/README.md says",
    );
    expect(harness.server.requests).toEqual([]);
  });

  it.each([
    "Connector:test",
    "oauth:test",
    "restored:oauth:test",
    " Restored:oauth:test ",
  ])("refuses source %s under a reserved prefix", async (source) => {
    const connector = { ...testConnector(vendor()), source };
    expect(await start(connector, harness.runtime(["--once"]))).toBe(2);
    expect(harness.server.requests).toEqual([]);
    expect(
      await start(testConnector(vendor()), harness.runtime(["--once"])),
    ).toBe(0);
    expect(harness.server.requests.length).toBeGreaterThan(0);
  });

  it("refuses a MARFA_API_URL it cannot use, without showing what it holds", async () => {
    const pasted = "marfa_k1_pasted_into_the_wrong_variable";
    expect(await harness.once(vendor(), { MARFA_API_URL: pasted })).toBe(2);
    expect(
      await harness.once(vendor(), {
        MARFA_API_URL: "ftp://marfa.example.com",
      }),
    ).toBe(2);
    const said = harness.lines.join("\n");
    expect(said).toContain("MARFA_API_URL");
    expect(said).not.toContain(pasted);
    expect(harness.server.requests).toEqual([]);
    expect(await harness.once(vendor())).toBe(0);
    expect(harness.server.requests.length).toBeGreaterThan(0);
  });

  it("refuses a secret too short to keep out of the logs", async () => {
    harness.server.settings = { test_token: "abcdefg" };
    expect(await harness.once(vendor())).toBe(4);
    expect(harness.lines.join("\n")).toContain("test_token");
    expect(harness.server.rows).toEqual([]);
    harness.server.settings = { test_token: "abcdefgh" };
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("refuses settings the connector's own check refuses, under either schedule, before it writes anything", async () => {
    const connector = {
      ...testConnector(vendor([entry])),
      checkEnv: (env: {
        test_region: string | undefined;
        test_token: string;
      }) => {
        if (env.test_region === "nowhere") {
          throw new Error(`no region nowhere for ${env.test_token}`);
        }
      },
    };
    harness.server.settings = { test_token: secretToken, test_region: "nowhere" };
    for (const argv of [["--once"], ["--every", "1m"]]) {
      expect(await start(connector, harness.runtime(argv))).toBe(4);
    }
    const said = harness.lines.join("\n");
    expect(said).toContain("no region nowhere for [redacted]");
    expect(said).not.toContain(secretToken);
    expect(JSON.stringify(harness.server.runs)).not.toContain(secretToken);
    expect(harness.server.rows).toEqual([]);
    harness.server.settings = { test_token: secretToken };
    expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("waits on a check that answers later, and refuses what it refuses", async () => {
    const connector = {
      ...testConnector(vendor([entry])),
      checkEnv: async () => {
        await Promise.resolve();
        throw new Error("the region is refused");
      },
    };
    expect(await start(connector, harness.runtime(["--once"]))).toBe(4);
    expect(harness.lines.join("\n")).toContain("the region is refused");
    expect(harness.server.rows).toEqual([]);
  });

  it("starts no run once told to stop while registering", async () => {
    const held = vendor([entry]);
    harness.server.beforeAnswer = (request) => {
      if (request.path === "/connectors") harness.stop();
    };
    expect(await harness.once(held)).toBe(0);
    expect(held.runs).toBe(0);
    expect(harness.server.runs).toEqual([]);

    harness.server.beforeAnswer = undefined;
    expect(await harness.once(held)).toBe(0);
    expect(held.runs).toBe(1);
  });
});

describe("registration", () => {
  it("registers on every start, under the same registration", async () => {
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(await harness.once(vendor([entry]))).toBe(0);
    const registrations = harness.server.requestsTo("POST", "/connectors");
    expect(registrations).toHaveLength(2);
    expect(registrations[0]?.body).toEqual({
      name: "test",
      description: "A connector the kit's tests drive.",
      read_only_types: ["test.entry"],
    });
    expect(harness.server.runs).toHaveLength(2);
    expect(harness.server.heartbeats).toBeGreaterThanOrEqual(2);
  });
});

describe("the key check on start", () => {
  it("starts on a key holding read and write on its own type and the registration of it", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
    };
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.server.requestsTo("GET", "/keys/current")).toHaveLength(1);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("refuses a key wider than its type, naming the key and what is too wide, before it checks the types or writes a row", async () => {
    harness.server.grants = {
      permissions: ["keys.mint", "items.purge"],
      type_permissions: { "test.entry": "write", "core.note": "read" },
      metadata_permissions: { types: "write", tags: "write" },
      edge_permissions: { "*": "write" },
    };
    expect(await harness.once(vendor([entry]))).toBe(3);
    const error = harness.lastRun().error ?? "";
    expect(harness.lastRun().outcome).toBe("failed");
    for (const named of [
      "keys.mint",
      "items.purge",
      "type core.note=read",
      "metadata tags=write",
      "edge *=write",
    ]) {
      expect(error).toContain(named);
    }
    expect(error).not.toContain("type test.entry");
    expect(harness.server.rows).toEqual([]);
    expect(harness.server.requestsTo("POST", "/types/normalize")).toEqual([]);
  });

  it("sends an owner whose key is too wide to the connector's own README where it names one, and to the template's otherwise", async () => {
    harness.server.grants = {
      permissions: ["keys.mint"],
      type_permissions: { "test.entry": "write" },
    };
    expect(await harness.once(vendor([entry]))).toBe(3);
    expect(harness.lastRun().error).toContain(
      "Revoke it and mint another as the template's README says.",
    );
    const own = "connectors/test/README.md";
    expect(
      await start(
        { ...testConnector(vendor([entry])), readme: own },
        harness.runtime(["--once"]),
      ),
    ).toBe(3);
    const error = harness.lastRun().error ?? "";
    expect(error).toContain(`Revoke it and mint another as ${own} says.`);
    expect(error).not.toContain("template's README");
    expect(harness.server.rows).toEqual([]);
  });

  it("refuses schema.write, which a connector's key no longer holds, naming it, before it checks the types or writes a row", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      permissions: ["schema.write"],
    };
    expect(await harness.once(vendor([entry]))).toBe(3);
    const error = harness.lastRun().error ?? "";
    expect(error).toContain("key-1");
    expect(error.slice(error.indexOf("is refused:"))).toContain("schema.write");
    expect(harness.server.rows).toEqual([]);
    expect(harness.server.requestsTo("POST", "/types/normalize")).toEqual([]);
  });

  it("refuses a pattern over every type, management permissions, any extension or profile reach, and an enforcement override, naming each", async () => {
    for (const [grants, named] of [
      [{ type_permissions: { "*": "write" } }, "type *=write"],
      [{ permissions: ["instance.read"] }, "instance.read"],
      [{ permissions: ["instance.maintain"] }, "instance.maintain"],
      [{ permissions: ["connectors.manage"] }, "connectors.manage"],
      [{ permissions: ["blobs.manage"] }, "blobs.manage"],
      [{ permissions: ["keys.manage"] }, "keys.manage"],
      [{ extension_permissions: { "app.x": "read" } }, "extension app.x=read"],
      [{ profile_permissions: { email: "read" } }, "profile email=read"],
      [
        { enforcement_override: { strict_mode: { types: ["test.entry"] } } },
        "an enforcement override of strict_mode",
      ],
      [
        {
          type_permissions: { "test.entry": "write" },
          metadata_permissions: { edge_types: "write" },
        },
        "metadata edge_types=write",
      ],
      [
        {
          type_permissions: { "test.entry": "write" },
          metadata_permissions: { types: "write" },
        },
        "metadata types=write",
      ],
    ] as const) {
      harness.server.grants = grants;
      expect(await harness.once(vendor([entry]))).toBe(3);
      expect(harness.lastRun().error).toContain(named);
      expect(harness.lastRun().error).toContain("key-1");
      expect(harness.server.rows).toEqual([]);
    }
  });

  it("refuses a key that claims any source, its connector's included, naming them, before it checks the types or writes a row", async () => {
    for (const [keySource, sources] of [
      ["test", ["other.app"]],
      ["test-second", ["test"]],
    ] as const) {
      harness.server.keySource = keySource;
      harness.server.grants = {
        sources: [...sources],
        type_permissions: { "test.entry": "write" },
      };
      expect(await harness.once(vendor([entry]))).toBe(3);
      const error = harness.lastRun().error ?? "";
      expect(harness.lastRun().outcome).toBe("failed");
      expect(error).toContain("key-1");
      expect(error).toContain(keySource === "test" ? "claims sources" : "not the connector's");
      expect(harness.server.rows).toEqual([]);
      expect(harness.server.requestsTo("POST", "/types")).toEqual([]);
    }
  });

  it("refuses a key whose own source is not the connector's", async () => {
    harness.server.keySource = "elsewhere";
    harness.server.grants = { type_permissions: { "test.entry": "write" } };
    expect(await harness.once(vendor([entry]))).toBe(3);
    const error = harness.lastRun().error ?? "";
    expect(error).toContain("elsewhere");
    expect(error).toContain("not the connector's, test");
    expect(harness.server.rows).toEqual([]);
    expect(harness.server.requestsTo("POST", "/types")).toEqual([]);
  });

  it("refuses a key whose default tier is not the feed, since the connector names no tier on most writes", async () => {
    harness.server.grants = { default_tier: "library" } as never;
    expect(await harness.once(vendor([entry]))).toBe(3);
    expect(harness.lastRun().error).toContain("a default tier of library");
    expect(harness.server.rows).toEqual([]);
  });

  it("refuses a key an app made, however narrow, before it registers anything, saying how to mint another", async () => {
    harness.server.grants = {
      oauth_client_id: "client-1",
      type_permissions: { "test.entry": "write" },
    };
    expect(await harness.once(vendor([entry]))).toBe(3);
    const said = harness.lines.join("\n");
    expect(said).toContain("key-1");
    expect(said).toContain("an app made it");
    expect(said).toContain("the key its connector host mints for it");
    expect(harness.server.requestsTo("POST", "/connectors")).toEqual([]);
    expect(harness.server.requestsTo("POST", "/types")).toEqual([]);
    expect(harness.server.runs).toEqual([]);
    expect(harness.server.rows).toEqual([]);
  });

  it("registers on the same key where no app made it", async () => {
    harness.server.grants = { type_permissions: { "test.entry": "write" } };
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.server.requestsTo("POST", "/connectors")).toHaveLength(1);
  });

  it("stops, saying what the server said, when it refuses to show the key", async () => {
    harness.server.refuseNext(
      "GET /keys/current",
      404,
      "not_found",
      "Not found",
    );
    expect(await harness.once(vendor([entry]))).toBe(1);
    expect(harness.lines.join("\n")).toContain("could not start");
    expect(harness.lines.join("\n")).toContain("Not found");
    expect(harness.server.runs).toEqual([]);
    expect(harness.server.rows).toEqual([]);
  });

  it("reads a level of none as holding nothing", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write", "core.note": "none" },
      metadata_permissions: { types: "none" },
    };
    expect(await harness.once(vendor([entry]))).toBe(0);
  });
});

describe("the type check on start", () => {
  it("stops, and registers nothing, when the server has no type", async () => {
    harness.server.installs = false;
    expect(await harness.once(vendor([entry]))).toBe(1);
    expect(harness.lastRun().error).toContain("the type test.entry");
    expect(harness.server.requestsTo("POST", "/types")).toEqual([]);
    expect(harness.server.types.size).toBe(0);
    expect(harness.server.rows).toEqual([]);
  });

  it("carries on when the server's type has the same shape, whatever its words", async () => {
    harness.server.types.set("test.entry", {
      ...testType,
      label: "Something else",
      description: "Described differently.",
      version: 3,
      fields: {
        title: { type: "string", required: true, description: "The title" },
        note: { type: "string" },
        link: { type: "url", description: "Where it lives" },
        vendor_id: { type: "string" },
      },
    });
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.server.requestsTo("POST", "/types")).toEqual([]);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("reads a required list and per-field flags as the same thing", async () => {
    harness.server.types.set("test.entry", {
      id: "test.entry",
      required: ["title"],
      fields: {
        title: { type: "string" },
        note: { type: "string" },
        link: { type: "url" },
        vendor_id: { type: "string" },
      },
    });
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("stops with the difference named when the server's type differs, and never rewrites it, whatever the key holds", async () => {
    const served = {
      id: "test.entry",
      fields: {
        title: { type: "string" },
        note: { type: "integer" },
        extra: { type: "string" },
      },
      parent: "core.note",
    };
    harness.server.types.set("test.entry", served);
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
    };
    expect(await harness.once(vendor([entry]))).toBe(1);

    const run = harness.lastRun();
    expect(run.outcome).toBe("failed");
    for (const difference of [
      '"note"',
      '"link"',
      '"title"',
      "parent is",
      "marfa plugins install test",
    ]) {
      expect(run.error).toContain(difference);
    }
    expect(run.error).not.toContain('"extra"');
    expect(harness.server.rows).toEqual([]);
    expect(harness.server.requestsTo("POST", "/types")).toEqual([]);
    expect(
      harness.server.requests.some((request) => request.method === "PUT"),
    ).toBe(false);
    expect(harness.server.types.get("test.entry")).toBe(served);
  });

  it("starts on a type that only lacks optional fields, and leaves it as it is", async () => {
    const served = {
      ...testType,
      fields: { title: { type: "string", required: true } },
    };
    harness.server.types.set("test.entry", served);
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.lastRun().summary).toContain("marfa plugins install test");
    expect(harness.server.requestsTo("PUT", "/types/test.entry")).toEqual([]);
    expect(harness.server.requestsTo("POST", "/types")).toEqual([]);
    expect(harness.server.types.get("test.entry")).toBe(served);
  });

  it("reads a format that is a field type of its own as that type", async () => {
    const connector = testConnector(vendor([entry]));
    const carried = {
      ...connector,
      types: [
        {
          ...connector.types[0],
          fields: testFields,
          type: {
            ...testType,
            fields: {
              title: { type: "string" as const, required: true },
              note: { type: "string" as const },
              link: { type: "string" as const, format: "url" as const },
              vendor_id: { type: "string" as const },
            },
          },
        },
      ],
    };
    harness.server.types.set("test.entry", testType);
    expect(await start(carried, harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("takes the fields the server answers from a parent as the parent's", async () => {
    harness.server.types.set("test.base", {
      id: "test.base",
      fields: { origin: { type: "string", required: true } },
    });
    harness.server.store({ ...testType, parent: "test.base" });
    const connector = testConnector(vendor([entry]));
    const child = {
      ...connector,
      types: [
        {
          fields: testFields,
          type: { ...testType, parent: "test.base" },
        },
      ],
    };
    expect(await start(child, harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });
});

describe("--once", () => {
  it("answers 0 for a run that succeeded and 1 for one that failed", async () => {
    expect(await harness.once(vendor([entry]))).toBe(0);
    const failing = vendor([entry]);
    failing.fail = new Error("the vendor answered 500");
    expect(await harness.once(failing)).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
  });

  it("answers 1 when nothing answers at the server's address, having asked and written nothing", async () => {
    const closed = await closedUrl();
    expect(await harness.once(vendor([entry]), { MARFA_API_URL: closed })).toBe(
      1,
    );
    expect(harness.lines.at(-1)).toContain(
      `could not start: the server at MARFA_API_URL (${closed}) did not answer`,
    );
    expect(harness.server.requests).toEqual([]);

    // The witness: at the address that answers, the same run writes its row.
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("answers 1 when the server answers the registration 503 write_contention, having written nothing", async () => {
    harness.server.refuseNext("POST /connectors", 503, "write_contention");
    expect(await harness.once(vendor([entry]))).toBe(1);
    expect(harness.server.rows).toEqual([]);
  });
});
