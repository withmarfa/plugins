import type { TypeDefinition } from "./define.js";
import type { Marfa } from "./marfa.js";
import { typeDifferences } from "./type-check.js";

/** What the connector writes without, since the type its plugin installed lacks
 *  it. */
export interface Narrowed {
  readonly fields: ReadonlyMap<string, readonly string[]>;
  /** The tables the connector writes none of, by type, since the installed
   *  type lacks them, or a column or the order of them. */
  readonly tables: ReadonlyMap<string, readonly string[]>;
  /** What a run raises, by condition key. */
  readonly conditions: ReadonlyMap<string, string>;
}

export interface TypeStep {
  readonly problem: string | undefined;
  readonly narrowed: Narrowed | undefined;
}

/** Fields no row can be written without as the connector means it. */
const fileFields = ["blob_ref", "mime_type"];

/** What every difference between the installed plugin and this build says,
 *  first, since a condition is cut at 500 characters. */
export const differs = "the installed plugin's types differ from this build";

/** The one way to mend a difference: the installed plugin is replaced by a
 *  version that matches this build, which may only add to its types. */
export function updateCommand(plugin: string): string {
  return `marfa plugins install ${plugin}`;
}

/** Why a start stops on a difference the connector cannot write around. */
export function differenceProblem(plugin: string, what: string): string {
  return `Update the plugin with \`${updateCommand(plugin)}\`, then start the connector again; ${differs}, and the connector cannot write without them: ${what}`;
}

function omissions(
  plugin: string,
  fields: ReadonlyMap<string, readonly string[]>,
  tables: ReadonlyMap<string, readonly string[]>,
): string {
  const parts = [
    ...[...fields].map(
      ([type, names]) => `the type ${type} without ${names.join(", ")}`,
    ),
    ...[...tables].map(
      ([type, names]) =>
        `no rows to the ${names.length === 1 ? "table" : "tables"} ${names.join(", ")} of the type ${type}`,
    ),
  ];
  return `update the plugin with \`${updateCommand(plugin)}\`, and the connector writes them on its next start or scheduled run; ${differs}, so until then it writes ${parts.join(" and ")}, which this build declares and the installed type lacks`;
}

/**
 * Reads each type the connector writes as the instance serves it, and holds
 * it to what this build carries. Registers nothing: installing the plugin
 * registered the types, and an update of it changes them. An optional field
 * or table the installed type lacks is written around, with one condition
 * that names the update, and lifted by the next check once the plugin is
 * updated. Every other difference, and a type the instance does not hold,
 * stops the start, so a build never writes to a type it was not made for.
 */
export async function checkTypes(
  plugin: string,
  types: readonly TypeDefinition[],
  marfa: Marfa,
): Promise<TypeStep> {
  const fields = new Map<string, readonly string[]>();
  const tables = new Map<string, readonly string[]>();
  const absent: string[] = [];
  const unlike: string[] = [];
  const lacking: string[] = [];
  for (const type of types) {
    const snapshot = await marfa.normalizeType(type);
    const resolved = snapshot.resolved_type;
    if (resolved === null) {
      absent.push(`the type ${type.id} is not installed`);
      continue;
    }
    if (snapshot.registered_type === null)
      throw new Error("invalid normalized type snapshot");
    const differences = typeDifferences(
      snapshot.type,
      resolved,
      snapshot.registered_type,
    );
    if (differences.other.length > 0) {
      unlike.push(
        `the type ${type.id} differs: ${[
          ...differences.other,
          ...differences.missing.map(
            (name) => `field "${name}" is missing on the server`,
          ),
        ].join("; ")}`,
      );
      continue;
    }
    const needed = differences.missing.filter(
      (name) => name === type.link_field || fileFields.includes(name),
    );
    if (needed.length > 0) {
      lacking.push(
        `the type ${type.id} lacks ${needed.join(", ")}, without which this connector cannot write its rows`,
      );
      continue;
    }
    if (differences.missing.length > 0)
      fields.set(type.id, differences.missing);
    if (differences.tables.length > 0) tables.set(type.id, differences.tables);
  }
  const problems = [...absent, ...unlike, ...lacking];
  if (problems.length > 0) {
    return {
      problem: differenceProblem(plugin, problems.join("; ")),
      narrowed: undefined,
    };
  }
  return {
    problem: undefined,
    narrowed:
      fields.size === 0 && tables.size === 0
        ? undefined
        : {
            fields,
            tables,
            conditions: new Map([
              ["plugin-types", omissions(plugin, fields, tables)],
            ]),
          },
  };
}
