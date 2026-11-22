import type { components } from "@withmarfa/client";
import type {
  ConnectionDefinition,
  Connector,
  Item,
  SettingsDeclaration,
} from "./define.js";
import type { EdgeType } from "./marfa.js";
import type { Narrowed } from "./own-types.js";
import { wireOf } from "./shipped.js";

export type Mapping = components["schemas"]["ConnectorMapping"];
export type Rewrite = components["schemas"]["ConnectorRewritePending"];

/** A registered type as a write meets it: every field it holds, its own and
 *  those it inherits, its link field, and the types above it, nearest
 *  first. */
export interface ResolvedType {
  readonly id: string;
  readonly fields: ReadonlySet<string>;
  readonly tables: ReadonlySet<string>;
  readonly link: string | undefined;
  readonly above: readonly string[];
}

/** What one kind does in a run, as the owner's mapping and the instance's
 *  types allow. */
export interface KindPlan {
  /** The kind's name in the plugin's manifest; a kind without one takes its
   *  default. */
  readonly name: string | undefined;
  /** The kind's own type, by which the connector names its rows. */
  readonly own: string;
  /** The type its rows are written as. */
  readonly target: string;
  /** Why the kind writes, reads and carries nothing this run. */
  readonly off: string | undefined;
  /** The kind's fields the target type does not declare, left out. */
  readonly omitted: readonly string[];
  /** The kind's tables the target type does not declare, left out. */
  readonly omittedTables: readonly string[];
  /** Where the target's link field is not the kind's, the kind's link
   *  field, which its rows still hold as a property: the server finds no
   *  row by it, so the kit finds rows by their natural key. */
  readonly heldLink: string | undefined;
  /** The connections from the kind's rows whose edge type no longer takes
   *  one end, by the mapping. */
  readonly unfit: ReadonlySet<string>;
}

/** The mapping a run applies, with what each kind does by it. */
export interface Plan {
  readonly version: number;
  readonly kinds: ReadonlyMap<string, KindPlan>;
  readonly map: TypeMap;
  /** What the run raises for the mapping, by condition key. */
  readonly conditions: ReadonlyMap<string, string>;
}

/** The mapping that holds where none was saved: every kind on, on its own
 *  type, at the feed. */
export function defaultMapping(): Mapping {
  return { version: 0, kinds: {}, rewrites: [] };
}

/** Whether a value read from the kit's state is a mapping the server
 *  answered. */
export function isMapping(value: unknown): value is Mapping {
  if (typeof value !== "object" || value === null) return false;
  const held = value as Record<string, unknown>;
  return (
    Number.isInteger(held["version"]) &&
    typeof held["kinds"] === "object" &&
    held["kinds"] !== null &&
    !Array.isArray(held["kinds"]) &&
    Array.isArray(held["rewrites"])
  );
}

/** Translates the types the connector names its rows by to the types they
 *  are written as, and back. A kind that keeps its own type, or is off,
 *  is not translated. */
export class TypeMap {
  private readonly toTarget = new Map<string, string>();
  private readonly toOwn = new Map<string, string>();
  private readonly held = new Map<string, string>();

  constructor(kinds: Iterable<KindPlan>) {
    for (const kind of kinds) {
      if (kind.off !== undefined || kind.target === kind.own) continue;
      this.toTarget.set(kind.own, kind.target);
      this.toOwn.set(kind.target, kind.own);
      if (kind.heldLink !== undefined)
        this.held.set(kind.target, kind.heldLink);
    }
  }

  /** Whether any kind is written as another type. */
  get moved(): boolean {
    return this.toTarget.size > 0;
  }

  /** The types the rows of the connector's type are held as: its target,
   *  where they are written, and its own, which keeps the rows written
   *  before the mapping until a rewrite moves them. */
  reads(type: string): string[] {
    const target = this.toTarget.get(type);
    return target === undefined ? [type] : [target, type];
  }

  /** The type rows of the connector's type are written as. */
  out(type: string): string {
    return this.toTarget.get(type) ?? type;
  }

  /** The connector's type for rows written as this type. */
  own(type: string): string {
    return this.toOwn.get(type) ?? type;
  }

  /** The row as the connector names it. */
  item<T extends Item>(item: T): T {
    const type = this.toOwn.get(item.type);
    return type === undefined ? item : { ...item, type };
  }

  /** The link field rows of a target type hold as a property, where the
   *  server finds none by it. */
  heldLink(target: string): string | undefined {
    return this.held.get(target);
  }
}

/** Whether a list of endpoint types takes a type, by itself or a type
 *  above it: an empty list or `*` takes any. */
function takes(
  list: readonly string[] | undefined,
  type: string,
  above: readonly string[],
): boolean {
  if (list === undefined || list.length === 0 || list.includes("*"))
    return true;
  return list.includes(type) || above.some((one) => list.includes(one));
}

/** The connections from each kind's rows that an edge type no longer takes
 *  once the kinds land on their targets, each with why. */
export function unfitConnections(
  connections: readonly ConnectionDefinition[],
  kinds: ReadonlyMap<string, { target: string; above: readonly string[] }>,
  served: readonly EdgeType[],
): Map<string, Map<string, string>> {
  const unfit = new Map<string, Map<string, string>>();
  const placed = (type: string) => kinds.get(type);
  for (const connection of connections) {
    const wire = wireOf(connection.id);
    const edge = served.find((one) => one.id === wire.edge);
    if (edge === undefined) continue;
    const [rowEnd, otherEnd] = wire.inbound
      ? [edge.to_type_constraints, edge.from_type_constraints]
      : [edge.from_type_constraints, edge.to_type_constraints];
    const others = (connection.to_type_constraints ?? []).flatMap((type) => {
      const there = placed(type);
      return there === undefined || there.target === type
        ? []
        : [{ own: type, ...there }];
    });
    const farMisfit = others.find(
      (other) => !takes(otherEnd, other.target, other.above),
    );
    for (const own of connection.from_type_constraints ?? []) {
      const here = placed(own);
      if (here === undefined) continue;
      const nearMisfit =
        here.target !== own && !takes(rowEnd, here.target, here.above);
      if (!nearMisfit && farMisfit === undefined) continue;
      const why = nearMisfit
        ? `${own} lands on ${here.target}`
        : `${farMisfit?.own ?? ""} lands on ${farMisfit?.target ?? ""}`;
      const held = unfit.get(own) ?? new Map<string, string>();
      held.set(connection.id, why);
      unfit.set(own, held);
    }
  }
  return unfit;
}

/** Fields the kit cannot write a file's row without. */
const fileFields = ["blob_ref", "mime_type"];

/**
 * Works out what each kind does by the mapping: off, on its own type, or on
 * a target type the instance holds. A kind is stopped alone, with a
 * condition, where its target is gone, cannot hold its file, or is another
 * kind's type, since the kit could not tell their rows apart.
 */
export async function planKinds<E extends SettingsDeclaration>(
  connector: Connector<E>,
  mapping: Mapping,
  resolve: (type: string) => Promise<ResolvedType | undefined>,
  edgeTypes: () => Promise<readonly EdgeType[]>,
): Promise<Plan> {
  const conditions = new Map<string, string>();
  const owns = new Set(connector.types.map((kind) => kind.type.id));
  const chosen = connector.types.map((kind) => {
    const entry =
      kind.name === undefined ? undefined : mapping.kinds[kind.name];
    return {
      kind,
      enabled: entry?.enabled ?? true,
      target: entry?.target_type ?? kind.type.id,
    };
  });
  const sharing = new Map<string, number>();
  for (const { enabled, target, kind } of chosen) {
    if (enabled && target !== kind.type.id)
      sharing.set(target, (sharing.get(target) ?? 0) + 1);
  }
  const plans = new Map<string, KindPlan>();
  const placed = new Map<
    string,
    { target: string; above: readonly string[] }
  >();
  for (const { kind, enabled, target } of chosen) {
    const own = kind.type.id;
    const label = kind.name ?? own;
    const base = {
      name: kind.name,
      own,
      target,
      omitted: [] as string[],
      omittedTables: [] as string[],
      heldLink: undefined,
      unfit: new Set<string>(),
    };
    const stop = (key: string, why: string): void => {
      conditions.set(`${key}:${label}`, why);
      plans.set(own, { ...base, off: why });
    };
    if (!enabled) {
      plans.set(own, {
        ...base,
        off: `the owner turned the kind ${label} off, so it brings nothing`,
      });
      continue;
    }
    if (target === own) {
      plans.set(own, { ...base, off: undefined });
      placed.set(own, { target: own, above: [] });
      continue;
    }
    if (owns.has(target) || (sharing.get(target) ?? 0) > 1) {
      stop(
        "mapping-shared",
        `the kind ${label} is mapped onto ${target}, which ${owns.has(target) ? "is another kind's own type" : "another kind is also mapped onto"}, so the connector could not tell their items apart, and the kind brings nothing until the mapping gives it a type of its own`,
      );
      continue;
    }
    const resolved = await resolve(target);
    if (resolved === undefined) {
      stop(
        "mapping-target",
        `the kind ${label} is mapped onto ${target}, which the instance does not hold or this connector may not read, so it brings nothing until the type is back or the mapping names another`,
      );
      continue;
    }
    const lacking = fileFields.filter(
      (field) => kind.fields.includes(field) && !resolved.fields.has(field),
    );
    if (lacking.length > 0) {
      stop(
        "mapping-target",
        `the kind ${label} is mapped onto ${target}, which lacks ${lacking.join(" and ")}, so it cannot hold the kind's files, and the kind brings nothing until the mapping names a file type`,
      );
      continue;
    }
    const link = kind.type.link_field;
    const heldLink =
      link !== undefined && resolved.link !== link ? link : undefined;
    const omitted = kind.fields.filter(
      (field) => field !== heldLink && !resolved.fields.has(field),
    );
    const omittedTables = Object.keys(kind.type.tables ?? {}).filter(
      (table) => !resolved.tables.has(table),
    );
    const left = [
      ...omitted,
      ...omittedTables.map((table) => `the table ${table}`),
    ];
    if (left.length > 0) {
      conditions.set(
        `mapping-fields:${label}`,
        `the kind ${label} lands on ${target} without ${left.join(", ")}, which that type does not declare`,
      );
    }
    plans.set(own, {
      ...base,
      off: undefined,
      omitted,
      omittedTables,
      heldLink,
    });
    placed.set(own, { target, above: resolved.above });
  }
  const connections = connector.connections ?? [];
  if (
    connections.length > 0 &&
    [...placed].some(([own, p]) => own !== p.target)
  ) {
    const unfit = unfitConnections(connections, placed, await edgeTypes());
    for (const [own, skipped] of unfit) {
      const plan = plans.get(own);
      if (plan === undefined) continue;
      plans.set(own, { ...plan, unfit: new Set(skipped.keys()) });
      for (const [connection, why] of skipped) {
        conditions.set(
          `mapping-connection:${plan.name ?? own}:${connection}`,
          `the connection ${connection} from ${plan.name ?? own} is not written, since ${why}, which the edge type ${wireOf(connection).edge} does not take`,
        );
      }
    }
  }
  return {
    version: mapping.version,
    kinds: plans,
    map: new TypeMap(plans.values()),
    conditions,
  };
}

/** The read-only types a registration names: the targets of the kinds that
 *  are on and not carried back. */
export function readOnlyTargets(
  plan: Plan,
  readOnly: readonly string[],
): string[] {
  return [
    ...new Set(
      readOnly.flatMap((own) => {
        const kind = plan.kinds.get(own);
        return kind === undefined
          ? [own]
          : kind.off === undefined
            ? [kind.target]
            : [];
      }),
    ),
  ];
}

/** The fields and tables each kind writes without: those the installed
 *  types lack, and those its target type does not declare. */
export function narrowedBy(
  plan: Plan,
  narrowed: Narrowed | undefined,
): Narrowed | undefined {
  const fields = new Map(narrowed?.fields ?? []);
  const tables = new Map(narrowed?.tables ?? []);
  for (const kind of plan.kinds.values()) {
    if (kind.omitted.length > 0)
      fields.set(kind.own, [
        ...new Set([...(fields.get(kind.own) ?? []), ...kind.omitted]),
      ]);
    if (kind.omittedTables.length > 0)
      tables.set(kind.own, [
        ...new Set([...(tables.get(kind.own) ?? []), ...kind.omittedTables]),
      ]);
  }
  if (fields.size === 0 && tables.size === 0) return narrowed;
  return { fields, tables, conditions: narrowed?.conditions ?? new Map() };
}
