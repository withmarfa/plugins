import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The type the template writes, as its plugin would install it. */
export function exampleType(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../src/example.item.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
}
