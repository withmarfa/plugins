import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  Connector,
  Setting,
  SettingsDeclaration,
  SettingValues,
} from "../src/define.js";
import {
  checkDefinition,
  ConfigurationError,
  readEnvironment,
} from "../src/environment.js";
import { readSettings, secretsOf } from "../src/settings.js";

const required = {
  MARFA_API_URL: "https://marfa.test",
  MARFA_API_KEY: "marfa-test-api-key",
};

function connector(
  settings: SettingsDeclaration,
  more: Partial<Connector> = {},
): Connector {
  return {
    name: "settings",
    source: "settings",
    types: [{ type: { id: "settings.item", fields: {} }, fields: [] }],
    settings,
    run: () => Promise.resolve(),
    ...more,
  };
}

const token = {
  name: "test_token",
  label: "Token",
  kind: "text",
  secret: true,
  required: true,
} as const satisfies Setting;

function refusal(
  settings: SettingsDeclaration,
  more: Partial<Connector> = {},
): string | undefined {
  try {
    checkDefinition(connector(settings, more));
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return (error as Error).message;
  }
  return undefined;
}

describe("the settings a connector declares", () => {
  it("takes a setting of each kind with a label, a default of its kind and its choices", () => {
    expect(
      refusal([
        token,
        { name: "a", label: "A", kind: "text", default: "x" },
        { name: "b1", label: "B", kind: "number", default: 3 },
        { name: "c_c", label: "C", kind: "boolean", default: false },
        {
          name: "d",
          label: "D",
          kind: "choice",
          choices: ["one", "two"],
          default: "two",
        },
      ]),
    ).toBeUndefined();
  });

  it("refuses a setting with no label, or one over 100 characters", () => {
    expect(refusal([{ name: "bare", label: "", kind: "text" }])).toMatch(
      /labeled with 1 to 100 characters, where bare is not/,
    );
    expect(
      refusal([{ name: "long", label: "x".repeat(101), kind: "text" }]),
    ).toMatch(/where long is not/);
    expect(
      refusal([{ name: "missing", kind: "text" } as unknown as Setting]),
    ).toMatch(/labeled with 1 to 100 characters, where missing is not/);
  });

  it("refuses a secret with a default, or of a kind other than text", () => {
    expect(refusal([{ ...token, default: "fixed-secret-value" }])).toMatch(
      /a secret setting to have no default, where test_token has one/,
    );
    expect(
      refusal([{ name: "pin", label: "Pin", kind: "number", secret: true }]),
    ).toMatch(/a secret setting to be text, where pin is not/);
    expect(
      refusal([
        {
          name: "flag",
          label: "Flag",
          kind: "boolean",
          secret: true,
          default: true,
        },
      ]),
    ).toMatch(/to be text, where flag is not.*no default, where flag has one/);
  });

  it("refuses a name that is not lowercase snake case, one longer than 64 characters and one given twice", () => {
    for (const name of ["Upper", "1st", "has-dash", "has space", "", "é"]) {
      expect(refusal([{ name, label: "L", kind: "text" }])).toMatch(
        /named in lowercase letters, digits and underscores/,
      );
    }
    expect(
      refusal([{ name: `a${"b".repeat(64)}`, label: "L", kind: "text" }]),
    ).toMatch(/at most 64 characters/);
    expect(
      refusal([{ name: `a${"b".repeat(63)}`, label: "L", kind: "text" }]),
    ).toBeUndefined();
    expect(
      refusal([
        { name: "same", label: "One", kind: "text" },
        { name: "same", label: "Two", kind: "text" },
      ]),
    ).toMatch(/each setting once/);
  });

  it("refuses a default that is not of its kind or not one of its choices, and choices on the wrong kind", () => {
    expect(
      refusal([{ name: "n", label: "N", kind: "number", default: "3" }]),
    ).toMatch(/a default of its setting's kind.*where n has not/);
    expect(
      refusal([{ name: "b", label: "B", kind: "boolean", default: "true" }]),
    ).toMatch(/where b has not/);
    expect(
      refusal([
        { name: "c", label: "C", kind: "choice", choices: ["a"], default: "z" },
      ]),
    ).toMatch(/where c has not/);
    expect(refusal([{ name: "c", label: "C", kind: "choice" }])).toMatch(
      /choices for each choice setting and for no other, where c does not/,
    );
    expect(
      refusal([{ name: "t", label: "T", kind: "text", choices: ["a"] }]),
    ).toMatch(/where t does not/);
    expect(
      refusal([{ name: "d", label: "D", kind: "choice", choices: ["a", "a"] }]),
    ).toMatch(/choices of 1 to 100 characters, each once, where d has others/);
  });

  it("refuses a kind named badly or twice, a direction that is not one of three, and a title or maker out of bounds", () => {
    const kind = (name: string | undefined, direction?: string) => ({
      ...(name === undefined ? {} : { name }),
      ...(direction === undefined ? {} : { direction }),
      type: { id: `settings.${name ?? "item"}`, fields: {} },
      fields: [],
    });
    const types = (...kinds: unknown[]) =>
      ({ types: kinds }) as unknown as Partial<Connector>;
    expect(refusal([], types(kind("Bad Name", "in")))).toMatch(
      /each kind named in lowercase letters/,
    );
    expect(
      refusal([], {
        types: [
          { ...kind("one", "in"), type: { id: "settings.a", fields: {} } },
          { ...kind("one", "out"), type: { id: "settings.b", fields: {} } },
        ],
      } as unknown as Partial<Connector>),
    ).toMatch(/each kind once/);
    expect(refusal([], types(kind("one", "sideways")))).toMatch(
      /each kind to move in, out or both, where settings\.one does not/,
    );
    expect(refusal([], types(kind("one", "both")))).toBeUndefined();
    expect(refusal([], { title: "" })).toMatch(
      /a title of 1 to 100 characters/,
    );
    expect(refusal([], { maker: "x".repeat(65) })).toMatch(
      /a maker of 1 to 64 characters/,
    );
  });
});

describe("the settings a connector reads", () => {
  const settings = [
    token,
    { name: "test_region", label: "Region", kind: "text" },
    { name: "test_on", label: "On", kind: "boolean", default: false },
    { name: "test_count", label: "Count", kind: "number" },
    {
      name: "test_mode",
      label: "Mode",
      kind: "choice",
      choices: ["a", "b"],
      default: "a",
    },
  ] as const satisfies SettingsDeclaration;

  it("types each by its kind, never undefined where it is required or has a default", () => {
    expectTypeOf<SettingValues<typeof settings>>().toEqualTypeOf<{
      readonly test_token: string;
      readonly test_region: string | undefined;
      readonly test_on: boolean;
      readonly test_count: number | undefined;
      readonly test_mode: string;
    }>();
    const read = readSettings(settings, {
      plugin: "test",
      settings: [{ name: "test_token", value: "a-secret-token", set: true }],
      missing: [],
    });
    expect(read.values).toEqual({
      test_token: "a-secret-token",
      test_region: undefined,
      test_on: false,
      test_count: undefined,
      test_mode: "a",
    });
  });
});

describe("the environment", () => {
  it("holds only MARFA_API_URL and MARFA_API_KEY, trimmed", () => {
    expect(
      readEnvironment({
        ...required,
        MARFA_API_KEY: ` ${required.MARFA_API_KEY} `,
        TEST_TOKEN: "a-secret-token",
      }),
    ).toEqual({ url: required.MARFA_API_URL, key: required.MARFA_API_KEY });
  });

  it("refuses a key too short to keep out of the logs", () => {
    expect(() =>
      readEnvironment({ ...required, MARFA_API_KEY: "tiny" }),
    ).toThrow("MARFA_API_KEY is shorter than 8 characters");
  });
});

describe("the settings Marfa answers", () => {
  const settings = [
    token,
    { name: "test_key", label: "Key", kind: "text", secret: true },
    { name: "test_on", label: "On", kind: "boolean", default: false },
  ] as const satisfies SettingsDeclaration;
  const held = (
    entries: { name: string; value: unknown; unreadable?: boolean }[],
    missing: string[] = [],
  ) => ({
    plugin: "test",
    settings: entries.map((entry) => ({
      set: entry.value !== null,
      unreadable: false,
      ...entry,
    })),
    missing,
  });

  it("reads an optional secret not set as undefined, and runs", () => {
    const read = readSettings(
      settings,
      held([
        { name: "test_token", value: "a-secret-token" },
        { name: "test_key", value: null },
      ]),
    );
    expect(read.values).toEqual({
      test_token: "a-secret-token",
      test_key: undefined,
      test_on: false,
    });
  });

  it("keeps every secret long enough to redact for the log, and none shorter", () => {
    expect(
      secretsOf(
        settings,
        held([
          { name: "test_token", value: "a-secret-token" },
          { name: "test_key", value: "tiny" },
          { name: "test_on", value: true },
        ]),
      ),
    ).toEqual(["a-secret-token"]);
  });

  it("names every problem at once, by label and name, and no value", () => {
    const read = readSettings(
      settings,
      held(
        [
          { name: "test_token", value: null },
          { name: "test_key", value: null, unreadable: true },
          { name: "test_on", value: "yes-please" },
        ],
        ["test_token"],
      ),
    );
    expect(read.problem).toContain(
      "a required setting is not set: Token (test_token)",
    );
    expect(read.problem).toContain("cannot open for Key (test_key)");
    expect(read.problem).toContain("On (test_on) is not true or false");
    expect(read.problem).not.toContain("yes-please");
  });
});
