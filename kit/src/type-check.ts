import type { ConnectionDefinition, TypeDefinition } from "./define.js";
import type { EdgeType } from "./marfa.js";

const shape = [
  "type",
  "items_type",
  "format",
  "enum_values",
  "searchable",
  "max_length",
  "max_items",
] as const;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function names(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").sort()
    : [];
}

function requiredSet(type: Record<string, unknown>): string[] {
  const fields = record(type["fields"]);
  const flagged = Object.entries(fields)
    .filter(([, field]) => record(field)["required"] === true)
    .map(([name]) => name);
  return [...new Set([...names(type["required"]), ...flagged])].sort();
}

function show(value: unknown): string {
  return value === undefined ? "nothing" : JSON.stringify(value);
}

export interface TypeDifferences {
  /** Optional fields the build declares and the server lacks, one of the two
   *  differences a connector writes around: it writes the type without
   *  them until the plugin is updated. */
  readonly missing: readonly string[];
  /** Tables the build declares that the server lacks, or lacks an optional
   *  column of or the `order` of, the other difference a connector writes
   *  around: each is named by its table. */
  readonly tables: readonly string[];
  /** Every other difference, which a connector cannot write around. */
  readonly other: readonly string[];
}

const columnShape = [
  "type",
  "enum_values",
  "format",
  "max_length",
  "minimum",
  "maximum",
  "type_constraints",
  "adds_up",
] as const;

/** What a table the build declares needs of the server's: the tables and
 *  optional columns it lacks, and what differs beyond that. The server's own
 *  tables and columns that the build does not declare are no difference. */
function tableDifferences(
  carried: Record<string, unknown>,
  served: Record<string, unknown>,
): { missing: string[]; other: string[] } {
  const missing: string[] = [];
  const other: string[] = [];
  const mine = record(carried["tables"]);
  const theirs = record(served["tables"]);
  for (const name of Object.keys(mine).sort()) {
    if (!Object.hasOwn(theirs, name)) {
      missing.push(name);
      continue;
    }
    const here = record(mine[name]);
    const there = record(theirs[name]);
    const columns = record(here["columns"]);
    const held = record(there["columns"]);
    let lacks = false;
    for (const column of Object.keys(columns).sort()) {
      const wanted = record(columns[column]);
      if (!Object.hasOwn(held, column)) {
        if (wanted["required"] === true)
          other.push(
            `table "${name}" column "${column}" is required here and missing on the server`,
          );
        else lacks = true;
        continue;
      }
      const have = record(held[column]);
      for (const attribute of columnShape) {
        if (
          JSON.stringify(wanted[attribute]) !== JSON.stringify(have[attribute])
        )
          other.push(
            `table "${name}" column "${column}" has ${attribute} ${show(wanted[attribute])} here and ${show(have[attribute])} on the server`,
          );
      }
      for (const attribute of ["required", "searchable"] as const) {
        if ((wanted[attribute] ?? false) !== (have[attribute] ?? false))
          other.push(
            `table "${name}" column "${column}" has ${attribute} ${show(wanted[attribute] ?? false)} here and ${show(have[attribute] ?? false)} on the server`,
          );
      }
    }
    const order = here["order"];
    if (order !== undefined && order !== there["order"]) {
      if (there["order"] === undefined) lacks = true;
      else
        other.push(
          `table "${name}" has order ${show(order)} here and ${show(there["order"])} on the server`,
        );
    }
    if (lacks) missing.push(name);
  }
  return { missing, other };
}

/** Fields the server holds and the connector does not declare are no
 *  difference, unless the server requires them: another version of the
 *  connector, or an operator, added them, and they are kept. */
export function typeDifferences(
  carried: TypeDefinition,
  served: Record<string, unknown>,
  declared: Record<string, unknown> = served,
): TypeDifferences {
  const missing: string[] = [];
  const other: string[] = [];
  const mine = record(carried.fields);
  const theirs = record(served["fields"]);
  const required = requiredSet(carried);

  for (const name of Object.keys(mine)
    .filter((n) => !Object.hasOwn(theirs, n))
    .sort()) {
    if (required.includes(name)) {
      other.push(`field "${name}" is required here and missing on the server`);
    } else missing.push(name);
  }
  for (const name of Object.keys(mine)
    .filter((n) => Object.hasOwn(theirs, n))
    .sort()) {
    const here = record(mine[name]);
    const there = record(theirs[name]);
    for (const attribute of shape) {
      const a = here[attribute];
      const b = there[attribute];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        other.push(
          `field "${name}" has ${attribute} ${show(a)} here and ${show(b)} on the server`,
        );
      }
    }
  }

  for (const name of Object.keys(mine)
    .filter((n) => Object.hasOwn(theirs, n))
    .sort()) {
    const here = record(mine[name]);
    if (here["type"] !== "status") continue;
    // The server answers every word the chain gives, the type's own last, so
    // each word this type declares has to be among them, in its group. A
    // connector cannot write the status without a word it declares, so a
    // missing one stops the start like one in another group.
    const there = Array.isArray(record(theirs[name])["status_values"])
      ? (record(theirs[name])["status_values"] as unknown[]).map(record)
      : [];
    const lacking: string[] = [];
    for (const word of Array.isArray(here["status_values"])
      ? (here["status_values"] as unknown[]).map(record)
      : []) {
      const held = there.find((one) => one["value"] === word["value"]);
      if (held === undefined) lacking.push(show(word["value"]));
      else if (held["group"] !== word["group"]) {
        other.push(
          `field "${name}" has the status word ${show(word["value"])} in group ${show(word["group"])} here and ${show(held["group"])} on the server`,
        );
      }
    }
    if (lacking.length > 0)
      other.push(
        `field "${name}" lacks the status ${lacking.length === 1 ? "word" : "words"} ${lacking.join(", ")} on the server`,
      );
  }

  const requiredDeclared = requiredSet(declared);
  const requiredThere = requiredSet(served).filter(
    (n) => Object.hasOwn(mine, n) || requiredDeclared.includes(n),
  );
  for (const name of required.filter(
    (n) => Object.hasOwn(theirs, n) && !requiredThere.includes(n),
  )) {
    other.push(`field "${name}" is required here and not on the server`);
  }
  for (const name of requiredThere.filter((n) => !required.includes(n))) {
    other.push(`field "${name}" is required on the server and not here`);
  }

  if (carried.parent !== served["parent"]) {
    other.push(
      `parent is ${show(carried.parent)} here and ${show(served["parent"])} on the server`,
    );
  }
  const linkThere = served["link_field"] ?? undefined;
  if (carried.link_field !== linkThere) {
    other.push(
      `link_field is ${show(carried.link_field)} here and ${show(linkThere)} on the server`,
    );
  }
  const tables = tableDifferences(carried, served);
  other.push(...tables.other);
  return { missing, tables: tables.missing, other };
}

/** Whether the installed endpoints take every type the build writes: an
 *  installed list that is empty or holds `*` takes any, and a build that
 *  names none needs one that does. The plugin installs the widest shape a
 *  connector takes, so a build may write fewer. */
function covers(
  installed: readonly string[],
  built: readonly string[] | undefined,
): boolean {
  const any = (values: readonly string[]) =>
    values.length === 0 || values.includes("*");
  if (any(installed)) return true;
  if (built === undefined || any(built)) return false;
  return built.every((value) => installed.includes(value));
}

/** An endpoint list as its names, since a logged list in brackets is cut. */
function named(values: readonly string[] | undefined): string {
  return values === undefined || values.length === 0
    ? "any type"
    : values.join(", ");
}

export function edgeTypeDifferences(
  carried: ConnectionDefinition,
  served: EdgeType,
): string[] {
  const pairs: [string, unknown, unknown][] = [
    ["cardinality", carried.cardinality, served.cardinality],
    [
      "cascade_on_delete",
      carried.cascade_on_delete ?? "orphan",
      served.cascade_on_delete,
    ],
    ["reverse_name", carried.reverse_name, served.reverse_name],
    ["written_from", carried.written_from ?? "from", served.written_from],
  ];
  const ends: [string, readonly string[] | undefined, readonly string[]][] = [
    [
      "from_type_constraints",
      carried.from_type_constraints,
      served.from_type_constraints,
    ],
    [
      "to_type_constraints",
      carried.to_type_constraints,
      served.to_type_constraints,
    ],
  ];
  return [
    ...pairs
      .filter(
        ([, here, there]) => JSON.stringify(here) !== JSON.stringify(there),
      )
      .map(
        ([name, here, there]) =>
          `${name} is ${show(here)} here and ${show(there)} on the server`,
      ),
    ...ends
      .filter(([, here, there]) => !covers(there, here))
      .map(
        ([name, here, there]) =>
          `${name} is ${named(here)} here and ${named(there)} on the server, which does not take every type the connector writes`,
      ),
  ];
}
