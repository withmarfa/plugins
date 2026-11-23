import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { NoSkippedTests } from "./scripts/no-skipped-tests.js";
import { RetriedTests } from "./scripts/retried-tests.js";

// Connectors run with `--allow-net`, which Node before the pinned major
// refuses, so the tests that start them under the permission flags run only on
// the pin (the `Tests` job runs on it as well as on Node 22).
const pinned = (
  JSON.parse(
    readFileSync(new URL("host/node.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
const onPinnedMajor =
  Number(process.versions.node.split(".")[0]) >= Number(pinned.split(".")[0]);

export default defineConfig({
  test: {
    include: ["**/test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "vendor/**",
      ".claude/**",
      "_trash/**",
      "_archive/**",
      ...(onPinnedMajor
        ? []
        : [
            "host/test/supervisor.test.ts",
            "scripts/test/bundle-connectors.test.ts",
          ]),
    ],
    // Many tests drive real processes, which pass in a second or two locally
    // and outlast the 5 s default on a loaded CI runner; a test that truly
    // hangs still fails.
    testTimeout: 30_000,
    // A failing test runs once more in CI, and RetriedTests reports each one
    // that then passed. Locally a failure stays a failure.
    retry: process.env["CI"] === undefined ? 0 : 1,
    reporters: ["default", new NoSkippedTests(), new RetriedTests()],
  },
});
