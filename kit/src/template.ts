import type { Environment } from "minijinja-js";

/**
 * How much work one render may do, in MiniJinja's fuel: each instruction
 * costs some, and so does building a long value. A template that loops or
 * grows runs out within milliseconds, so this is the render's time bound,
 * and it holds the same on every machine.
 */
export const templateFuel = 100_000;

/** The longest text a render may give, in Unicode characters: the most a
 *  string field takes where it names no `max_length` of its own. */
export const templateCharacters = 100_000;

let loaded: Promise<typeof import("minijinja-js")> | undefined;
let engine: Environment | undefined;

/** Loads the template engine, which a mapping with no template never needs:
 *  its WebAssembly is read from disk on first use. */
export async function loadTemplates(): Promise<void> {
  loaded ??= import("minijinja-js");
  const { Environment } = await loaded;
  if (engine !== undefined) return;
  const made = new Environment();
  made.undefinedBehavior = "strict";
  made.fuel = templateFuel;
  // `none` renders as nothing, as an absent field reads in Marfa.
  made.setFinalizer((value: unknown) => (value === null ? "" : undefined));
  // The engine's one global that reads beyond the values given.
  made.removeGlobal("debug");
  engine = made;
}

export type Rendered =
  | { readonly text: string; readonly fault?: undefined }
  | { readonly text?: undefined; readonly fault: string };

/**
 * Renders a template against the values given and nothing else: no loader
 * is set, so `include`, `import` and `extends` find nothing, and no global
 * reads the environment, a file or the network. A name the values do not
 * hold is an error. A render that runs out of fuel, or gives more than
 * `templateCharacters`, is cut off.
 */
export function render(
  source: string,
  values: Readonly<Record<string, unknown>>,
): Rendered {
  if (engine === undefined)
    return { fault: "the template engine was not loaded" };
  let text: string;
  try {
    text = engine.renderStr(source, values);
  } catch (error) {
    const kind =
      typeof error === "object" && error !== null && "kind" in error
        ? String(error.kind)
        : undefined;
    if (kind === "OutOfFuel")
      return {
        fault:
          "the template did more work than a render may, so it was cut off",
      };
    const message = error instanceof Error ? error.message : String(error);
    return { fault: message.split("\n")[0] ?? message };
  }
  // A character is one or two UTF-16 code units, so only text between the
  // bound and twice it needs counting.
  const over =
    text.length > templateCharacters &&
    (text.length > 2 * templateCharacters ||
      characters(text) > templateCharacters);
  if (over)
    return {
      fault: `the template gave more than ${templateCharacters.toLocaleString("en-US")} characters, so it was cut off`,
    };
  return { text };
}

/** Unicode characters, as Marfa counts a string's length: a surrogate pair
 *  is one. */
function characters(text: string): number {
  let count = 0;
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    const pair =
      unit >= 0xd800 && unit <= 0xdbff && at + 1 < text.length
        ? text.charCodeAt(at + 1)
        : 0;
    if (pair >= 0xdc00 && pair <= 0xdfff) at += 1;
    count += 1;
  }
  return count;
}
