/**
 * The RSS connector parses a feed in the one thread, so what bounds it is the
 * size, the element, attribute and entry counts and the cap on what it reads
 * to, and the heap cap every bundle runs under (`scripts/permission-flags.ts`)
 * stands above them. These tests read the largest documents those counts admit
 * under that cap, from the connector as built.
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { maxHeapMb } from "../permission-flags.js";

const run = promisify(execFile);
const measure = resolve(
  import.meta.dirname,
  "../../connectors/rss/test/fixtures/measure.js",
);

async function measured(
  kind: string,
  heapMb: number,
): Promise<{ outcome: string; heapMiB: number }> {
  const { stdout } = await run(
    process.execPath,
    [`--max-old-space-size=${String(heapMb)}`, measure, kind],
    { timeout: 90_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout) as { outcome: string; heapMiB: number };
}

describe("the heap cap of a bundle", () => {
  for (const [kind, reads] of [
    ["attributes", "all the attributes the count allows"],
    ["wide", "all the elements the count allows"],
  ] as const) {
    it(`holds a feed with ${reads}, with at least twice the room it takes`, async () => {
      const { outcome, heapMiB } = await measured(kind, maxHeapMb);
      expect(outcome).toMatch(/^read /);
      expect(heapMiB).toBeLessThan(maxHeapMb / 2);
    }, 90_000);
  }

  it("is what ends a read that needs more, which the same feed shows under a smaller one", async () => {
    await expect(measured("attributes", 24)).rejects.toThrow(
      /heap out of memory/i,
    );
  }, 90_000);
});
