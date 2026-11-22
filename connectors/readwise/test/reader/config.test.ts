import { expect, it } from "vitest";
import { parseConfig } from "../../src/reader/config.js";

const values = (maximum: string | undefined) => ({
  readwise_account: "sample",
  readwise_access_token: "fixture",
  readwise_api_url: undefined,
  readwise_reader_api_url: undefined,
  readwise_reader_include_feed: undefined,
  readwise_reader_pictures: undefined,
  readwise_reader_inbound_only: undefined,
  readwise_reader_propagate_purge: undefined,
  readwise_content_max_bytes: maximum,
  readwise_reader: undefined,
});

it.each([
  [undefined, 268435456],
  ["1", 1],
  ["0001", 1],
  ["143307926", 143307926],
  ["1073741824", 1073741824],
] as const)("uses the configured resource byte limit %s", (input, expected) => {
  expect(parseConfig(values(input))).toMatchObject({
    contentMaxBytes: expected,
  });
});
it.each([
  "",
  "0",
  "-1",
  "1.5",
  "1e6",
  "NaN",
  "Infinity",
  " 256",
  "1073741825",
  "9007199254740992",
])("rejects invalid resource byte limit %s", (input) => {
  expect(() => parseConfig(values(input))).toThrow(
    "READWISE_CONTENT_MAX_BYTES",
  );
});
it.each([
  [undefined, "addresses"],
  ["addresses", "addresses"],
  ["save", "save"],
  ["save-in-library", "save-in-library"],
] as const)("reads READWISE_READER_PICTURES %s", (input, expected) => {
  expect(
    parseConfig({ ...values(undefined), readwise_reader_pictures: input }),
  ).toMatchObject({ pictures: expected });
});
it.each(["", "true", "Save", "library"])(
  "refuses READWISE_READER_PICTURES %s at start",
  (input) => {
    expect(() =>
      parseConfig({ ...values(undefined), readwise_reader_pictures: input }),
    ).toThrow(
      "READWISE_READER_PICTURES must be addresses, save or save-in-library",
    );
  },
);
