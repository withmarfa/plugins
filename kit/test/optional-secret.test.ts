import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  Connector,
  SettingsDeclaration,
  SettingValues,
} from "../src/define.js";
import { readEnvironment } from "../src/environment.js";
import { Logger } from "../src/log.js";
import { systemClock } from "../src/runtime.js";

const settings = [
  { name: "test_token", label: "Test token", kind: "text", secret: true },
] as const satisfies SettingsDeclaration;
const connector: Connector<typeof settings> = {
  name: "optional-secret",
  source: "optional-secret",
  types: [],
  settings,
  run: () => Promise.resolve(),
};
const required = {
  MARFA_API_URL: "https://marfa.test",
  MARFA_API_KEY: "marfa-test-api-key",
};

describe("an optional secret", () => {
  it("can be omitted or blank without stopping startup", () => {
    expectTypeOf<SettingValues<typeof settings>["test_token"]>().toEqualTypeOf<
      string | undefined
    >();
    for (const value of [undefined, "", "   "]) {
      const result = readEnvironment(connector, {
        ...required,
        TEST_TOKEN: value,
      });
      expect(result.values["TEST_TOKEN"]).toBeUndefined();
      expect(result.secrets).toEqual([required.MARFA_API_KEY]);
    }
  });

  it.each([false, true])(
    "redacts a present value and its encoded spelling (setup: %s)",
    (setup) => {
      const token = "optional-token/value+123";
      const result = readEnvironment(
        connector,
        { ...required, TEST_TOKEN: ` ${token} ` },
        setup,
      );
      expect(result.values["TEST_TOKEN"]).toBe(token);
      const logger = new Logger(() => undefined, systemClock, result.secrets);
      expect(logger.redact(`${token} ${encodeURIComponent(token)}`)).toBe(
        "[redacted] [redacted]",
      );
      expect(logger.redact("an ordinary message")).toBe("an ordinary message");
    },
  );

  it.each([false, true])(
    "refuses a value too short to redact without showing it (setup: %s)",
    (setup) => {
      expect(() =>
        readEnvironment(connector, { ...required, TEST_TOKEN: "tiny" }, setup),
      ).toThrow("TEST_TOKEN is shorter than 8 characters");
    },
  );
});
