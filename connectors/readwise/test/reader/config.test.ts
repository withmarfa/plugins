import { expect, it } from "vitest";
import { parseConfig } from "../../src/reader/config.js";

const values = (maximum = 268435456) => ({
  readwise_account: "sample",
  readwise_access_token: "fixture",
  readwise_api_url: "https://readwise.io/api/v2/",
  readwise_reader_api_url: "https://readwise.io/api/v3/",
  readwise_reader_include_feed: false,
  readwise_reader_pictures: "addresses",
  readwise_reader_inbound_only: false,
  readwise_reader_propagate_purge: false,
  readwise_content_max_bytes: maximum,
  readwise_reader: false,
});

it.each([1, 143307926, 1073741824])(
  "uses the configured resource byte limit %s",
  (input) => {
    expect(parseConfig(values(input))).toMatchObject({
      contentMaxBytes: input,
    });
  },
);
it.each([0, -1, 1.5, Number.NaN, Infinity, 1073741825, 9007199254740992])(
  "rejects invalid resource byte limit %s",
  (input) => {
    expect(() => parseConfig(values(input))).toThrow(
      "readwise_content_max_bytes",
    );
  },
);
it.each([
  [undefined, "addresses"],
  ["addresses", "addresses"],
  ["save", "save"],
] as const)("reads readwise_reader_pictures %s", (input, expected) => {
  expect(
    parseConfig({
      ...values(),
      readwise_reader_pictures: input as unknown as string,
    }),
  ).toMatchObject({ pictures: expected });
});
it.each(["", "true", "Save", "library", "save-in-library"])(
  "refuses readwise_reader_pictures %s at start",
  (input) => {
    expect(() =>
      parseConfig({ ...values(), readwise_reader_pictures: input }),
    ).toThrow("readwise_reader_pictures must be addresses or save");
  },
);
