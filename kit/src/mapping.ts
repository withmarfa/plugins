import type { components } from "@withmarfa/client";
import { unreadKey, unwrittenKey } from "./agreement.js";
import type {
  ConnectionDefinition,
  Connector,
  Entry,
  Item,
  SettingsDeclaration,
} from "./define.js";
import type { EdgeType } from "./marfa.js";
import type { Narrowed } from "./own-types.js";
import { wireOf } from "./shipped.js";
import { loadTemplates, render } from "./template.js";
import { cleaned, fingerprint } from "./values.js";

export type Mapping = components["schemas"]["ConnectorMapping"];
export type Rewrite = components["schemas"]["ConnectorRewritePending"];
export type KindMapping = components["schemas"]["ConnectorMappingKind"];
export type FieldSource = components["schemas"]["ConnectorMappingField"];
export type PreviewResult = components["schemas"]["ConnectorPreviewResult"];
type StatusWord = components["schemas"]["StatusValue"];

/** A type's status field and every word it takes, inherited first. */
export interface StatusField {
  readonly field: string;
  readonly words: readonly Pick<StatusWord, "value" | "group">[];
}

/** A registered type as a write meets it: every field it holds, its own and
 *  those it inherits, its link field, and the types above it, nearest
 *  first. */
export interface ResolvedType {
  readonly id: string;
  readonly fields: ReadonlySet<string>;
  readonly tables: ReadonlySet<string>;
  readonly link: string | undefined;
  readonly above: readonly string[];
  readonly status?: StatusField | undefined;
  /** The field the type shows as an item's title, nearest type first. */
  readonly titleField?: string | undefined;
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
  /** How the kind's fields land on the target's, where they do not land
   *  one for one by name. */
  readonly fields?: FieldMap | undefined;
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

/** The prefix under which the connector's view of a row holds a target
 *  field no field of the kind's own type stands for: a fixed or templated
 *  value, or one the owner or another app wrote. The kit never sends it as
 *  named; it writes the field back as it was read. */
export const targetPrefix = "@target.";

/** The field a condition names. The view holds one the mapping fills under
 *  `targetPrefix`. */
export function namedField(field: string): string {
  return field.startsWith(targetPrefix)
    ? field.slice(targetPrefix.length)
    : field;
}

type MadeValue = Exclude<FieldSource, { from: string }>;

/** What one write of a kind's entry raises, by condition key. */
export type FieldFaults = Map<string, string>;

interface FieldMapInput {
  /** The kind's name, or its own type where it has none. */
  readonly label: string;
  readonly own: string;
  readonly target: string;
  /** The fields the connector declares for the kind. */
  readonly kindFields: readonly string[];
  readonly fields: Readonly<Record<string, FieldSource>>;
  readonly overrides: Readonly<Record<string, string>>;
  readonly ownStatus: StatusField | undefined;
  readonly targetStatus: StatusField | undefined;
  /** The kind's link field, written under its own name, where the target
   *  names no link field of its own. */
  readonly heldLink: string | undefined;
}

/**
 * How one kind's fields land on its target type's, by the owner's mapping,
 * and back. The kit names a row's fields by the kind's own type throughout;
 * this translates them at the door to Marfa.
 *
 * A target field `{from}` a field of the kind's own type is written from it,
 * and a change made to it in Marfa is carried back to that field. A field
 * `{fixed}` or `{template}` is written from the mapping alone and never
 * carried back: the connector's view holds it under `targetPrefix` as a
 * field the vendor mirrors, so a change made to it in Marfa is put back. A
 * status word lands on the target's word of the same group.
 */
export class FieldMap {
  readonly label: string;
  readonly target: string;
  /** The kind's fields written to the target, in the kind's order. */
  readonly carried: readonly string[];
  /** The kind's fields no target field is filled from: left out. */
  readonly omitted: readonly string[];
  /** The view's names of the fields the mapping alone fills. */
  readonly made: readonly string[];
  private readonly kindFields: readonly string[];
  private readonly from: ReadonlyMap<string, string>;
  /** For each carried field, the target field a change to it is read from:
   *  the first that is filled from it. */
  private readonly back: ReadonlyMap<string, string>;
  private readonly values: ReadonlyMap<string, MadeValue>;
  private readonly overrides: Readonly<Record<string, string>>;
  private readonly ownStatus: StatusField | undefined;
  private readonly targetStatus: StatusField | undefined;
  private readonly heldLink: string | undefined;
  readonly templated: boolean;
  /** A mark of how the fields land, which changes with the mapping. */
  readonly mark: string;

  constructor(input: FieldMapInput) {
    this.mark = `@mapping:${fingerprint([input.target, input.fields, input.overrides]).slice(0, 16)}`;
    this.label = input.label;
    this.target = input.target;
    this.kindFields = input.kindFields;
    this.overrides = input.overrides;
    this.heldLink = input.heldLink;
    const from = new Map<string, string>();
    const values = new Map<string, MadeValue>();
    for (const [field, source] of Object.entries(input.fields)) {
      if ("from" in source) from.set(field, source.from);
      else values.set(field, source);
    }
    this.from = from;
    this.values = values;
    const back = new Map<string, string>();
    for (const [field, own] of from) if (!back.has(own)) back.set(own, field);
    this.back = back;
    this.carried = input.kindFields.filter((field) => back.has(field));
    this.omitted = input.kindFields.filter(
      (field) => !back.has(field) && field !== input.heldLink,
    );
    this.made = [...values.keys()].map((field) => `${targetPrefix}${field}`);
    this.templated = [...values.values()].some((one) => "template" in one);
    // Words map through their group only where both fields are status
    // fields; otherwise the value is written as it is.
    const paired =
      input.ownStatus !== undefined &&
      input.targetStatus !== undefined &&
      from.get(input.targetStatus.field) === input.ownStatus.field;
    this.ownStatus = paired ? input.ownStatus : undefined;
    this.targetStatus = paired ? input.targetStatus : undefined;
  }

  /** The fields the connector's view of a row holds: those carried, the
   *  link held under its own name, and those the mapping fills. */
  get fields(): string[] {
    return [
      ...this.carried,
      ...(this.heldLink !== undefined && !this.carried.includes(this.heldLink)
        ? [this.heldLink]
        : []),
      ...this.made,
    ];
  }

  private isStatus(own: string): boolean {
    return this.ownStatus?.field === own;
  }

  /** The target's word for a word of the kind's own type: an override, the
   *  same word where the target holds it in the same group, or the
   *  target's first word of that group. `undefined` where the target holds
   *  no word of that group. */
  word(own: string): string | undefined {
    const overridden = this.overrides[own];
    if (overridden !== undefined) return overridden;
    const words = this.targetStatus?.words ?? [];
    const group = this.ownStatus?.words.find((one) => one.value === own)?.group;
    if (group === undefined) return own;
    if (words.some((one) => one.value === own && one.group === group))
      return own;
    return words.find((one) => one.group === group)?.value;
  }

  /** The kind's word for a target word: the first of the kind's words that
   *  lands on it, else the kind's first word of its group. `undefined`
   *  where the kind holds no word of that group. */
  wordBack(target: string): string | undefined {
    const own = this.ownStatus?.words ?? [];
    const landing = own.find((one) => this.word(one.value) === target);
    if (landing !== undefined) return landing.value;
    const group = this.targetStatus?.words.find(
      (one) => one.value === target,
    )?.group;
    if (group === undefined) return target;
    return own.find((one) => one.group === group)?.value;
  }

  /**
   * The entry as the connector's view writes it: its carried fields, a
   * status word as it reads back from the target, and each value the
   * mapping fills, rendered from the entry's fields. A value that cannot be
   * written, such as a template that fails or a word whose group the
   * target lacks, is named in `unwrittenKey`, so the row keeps what it
   * holds there, and raises a condition.
   */
  entry(entry: Entry, id?: string): { entry: Entry; faults: FieldFaults } {
    const given = cleaned(entry.properties);
    const properties: Record<string, unknown> = {};
    const unwritten: string[] = [];
    const faults: FieldFaults = new Map();
    const where = id ?? entry.source_id;
    for (const field of this.carried) {
      if (!Object.hasOwn(given, field)) continue;
      const value = given[field];
      if (!this.isStatus(field) || typeof value !== "string") {
        properties[field] = value;
        continue;
      }
      const word = this.word(value);
      if (word === undefined) {
        unwritten.push(field);
        faults.set(
          `mapping-status:${this.label}:${value}`,
          `the status word ${value} of ${where} is not written, since ${this.target} holds no word in its group`,
        );
        continue;
      }
      properties[field] = this.wordBack(word) ?? value;
    }
    if (this.heldLink !== undefined && Object.hasOwn(given, this.heldLink))
      properties[this.heldLink] = given[this.heldLink];
    let context: Record<string, unknown> | undefined;
    for (const [field, source] of this.values) {
      const key = `${targetPrefix}${field}`;
      if ("fixed" in source) {
        if (source.fixed !== null && source.fixed !== undefined)
          properties[key] = source.fixed;
        continue;
      }
      context ??= Object.fromEntries(
        this.kindFields.map((one) => [one, given[one] ?? null]),
      );
      const rendered = render(source.template, context);
      if (rendered.fault === undefined) {
        if (rendered.text !== "") properties[key] = rendered.text;
        continue;
      }
      unwritten.push(key);
      faults.set(
        `mapping-template:${this.label}:${field}`,
        `the template for ${field} of ${this.label} did not render for ${where}, so ${field} is not written: ${rendered.fault}`,
      );
    }
    if (unwritten.length > 0) properties[unwrittenKey] = unwritten;
    return { entry: { ...entry, properties }, faults };
  }

  /** The connector's view of a row written as the target type. */
  read(
    properties: Readonly<Record<string, unknown>>,
    raise?: (key: string, message: string) => void,
    id?: string,
  ): Record<string, unknown> {
    const view: Record<string, unknown> = {};
    const unread: string[] = [];
    const used = new Set<string>();
    for (const [own, field] of this.back) {
      if (!Object.hasOwn(properties, field)) continue;
      const value = properties[field];
      if (this.isStatus(own) && typeof value === "string") {
        const word = this.wordBack(value);
        if (word === undefined) {
          unread.push(own);
          raise?.(
            `mapping-status-back:${this.label}:${value}`,
            `the status word ${value}${id === undefined ? "" : ` of ${id}`} is not carried back, since ${this.label}'s own type holds no word in its group`,
          );
          continue;
        }
        view[own] = word;
      } else view[own] = value;
      used.add(field);
    }
    if (
      this.heldLink !== undefined &&
      Object.hasOwn(properties, this.heldLink)
    ) {
      view[this.heldLink] = properties[this.heldLink];
      used.add(this.heldLink);
    }
    for (const [field, value] of Object.entries(properties))
      if (!used.has(field)) view[`${targetPrefix}${field}`] = value;
    if (unread.length > 0) view[unreadKey] = unread;
    return view;
  }

  /** The connector's view of a row the kind wrote on its own type before
   *  the mapping moved it: the fields the mapping fills are not there to
   *  read, so they count as unchanged. */
  readUnmoved(
    properties: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    return this.made.length === 0
      ? { ...properties }
      : { ...properties, [unreadKey]: [...this.made] };
  }

  /** The target's properties for the connector's view of a row: each
   *  target field it read back as it was, each field filled from the
   *  kind's, and each the mapping fills. */
  write(view: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(view))
      if (key.startsWith(targetPrefix))
        out[key.slice(targetPrefix.length)] = value;
    const unread = new Set(
      Array.isArray(view[unreadKey]) ? (view[unreadKey] as string[]) : [],
    );
    for (const [field, own] of this.from) {
      const value = view[own];
      if (value === undefined || value === null) {
        if (!unread.has(own)) Reflect.deleteProperty(out, field);
        continue;
      }
      if (this.isStatus(own) && typeof value === "string") {
        const word = this.word(value);
        if (word !== undefined) out[field] = word;
        continue;
      }
      out[field] = value;
    }
    if (this.heldLink !== undefined) {
      const value = view[this.heldLink];
      if (value !== undefined && value !== null) out[this.heldLink] = value;
    }
    return out;
  }
}

/** The properties as sent: the connector's view holds names no write may
 *  carry. */
export function unviewed(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).filter(([key]) => !key.startsWith("@")),
  );
}

/** Translates the types and fields the connector names its rows by to
 *  those they are written as, and back. A kind that keeps its own type and
 *  fields, or is off, is not translated. */
export class TypeMap {
  private readonly toTarget = new Map<string, string>();
  private readonly toOwn = new Map<string, string>();
  private readonly held = new Map<string, string>();
  /** Field maps by the type a row is written as. */
  private readonly onTarget = new Map<string, FieldMap>();
  /** Field maps of kinds moved off their own type, by that type: rows
   *  written before the mapping hold the kind's own fields. */
  private readonly onOwn = new Map<string, FieldMap>();
  /** The type each row was last answered as, so a write by id names its
   *  fields as that type holds them. */
  private readonly served = new Map<string, string>();
  /** Where a translation raises a condition; the run sets it. */
  raise: ((key: string, message: string) => void) | undefined;

  constructor(kinds: Iterable<KindPlan>) {
    for (const kind of kinds) {
      if (kind.off !== undefined) continue;
      if (kind.fields !== undefined) {
        this.onTarget.set(kind.target, kind.fields);
        if (kind.target !== kind.own) this.onOwn.set(kind.own, kind.fields);
      }
      if (kind.target === kind.own) continue;
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

  /** The row as the connector names it: its type, and its fields. */
  item<T extends Item>(item: T): T {
    this.served.set(item.id, item.type);
    const type = this.toOwn.get(item.type);
    const onTarget = this.onTarget.get(item.type);
    const onOwn =
      onTarget === undefined ? this.onOwn.get(item.type) : undefined;
    if (type === undefined && onTarget === undefined && onOwn === undefined)
      return item;
    const properties =
      onTarget !== undefined
        ? onTarget.read(item.properties, this.raise, item.id)
        : onOwn !== undefined
          ? onOwn.readUnmoved(item.properties)
          : item.properties;
    return { ...item, type: type ?? item.type, properties };
  }

  /** The properties to send for the connector's view of a row: a new row of
   *  the connector's type, or the row by id as it was last answered. */
  properties(
    view: Readonly<Record<string, unknown>>,
    at: { type: string } | { id: string },
  ): Record<string, unknown> {
    const served = "type" in at ? this.out(at.type) : this.served.get(at.id);
    const fields = served === undefined ? undefined : this.onTarget.get(served);
    return fields === undefined ? unviewed(view) : fields.write(view);
  }

  /** Properties the row by id once held, such as an earlier version, in
   *  the connector's view, as the type it was last answered as holds them. */
  view(
    id: string,
    properties: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    const served = this.served.get(id);
    if (served === undefined) return { ...properties };
    const onTarget = this.onTarget.get(served);
    if (onTarget !== undefined) return onTarget.read(properties);
    return this.onOwn.get(served)?.readUnmoved(properties) ?? { ...properties };
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

/** Whether a kind's fields land one for one by name, with no status word
 *  moved: the kit then writes them as they are. */
function oneForOne(
  fields: Readonly<Record<string, FieldSource>>,
  overrides: Readonly<Record<string, string>>,
): boolean {
  return (
    Object.keys(overrides).length === 0 &&
    Object.entries(fields).every(
      ([field, source]) => "from" in source && source.from === field,
    )
  );
}

/**
 * The field map of a kind, and the kind's fields it leaves out. A kind on
 * its own type whose mapping names each field as itself needs none; one
 * that leaves fields out drops them; any other mapping, or a target type
 * whose status words may differ, translates.
 */
async function shapeFields(input: {
  label: string;
  own: string;
  target: string;
  kindFields: readonly string[];
  entry: KindMapping | undefined;
  heldLink: string | undefined;
  resolve: (type: string) => Promise<ResolvedType | undefined>;
  resolved: ResolvedType | undefined;
}): Promise<{ fields: FieldMap | undefined; omitted: string[] }> {
  const { entry, kindFields, heldLink } = input;
  const fields = entry?.fields;
  if (fields === undefined) return { fields: undefined, omitted: [] };
  const overrides = entry?.status_overrides ?? {};
  const named = new Set(
    Object.values(fields).flatMap((source) =>
      "from" in source ? [source.from] : [],
    ),
  );
  const unnamed = kindFields.filter(
    (field) => field !== heldLink && !named.has(field),
  );
  const simple = oneForOne(fields, overrides);
  if (input.target === input.own && simple) {
    if (unnamed.length === 0) return { fields: undefined, omitted: [] };
    // A field the type does not declare, which the mapping cannot name,
    // was never written; only a declared one the owner left out is.
    const own = await input.resolve(input.own);
    return {
      fields: undefined,
      omitted:
        own === undefined
          ? unnamed
          : unnamed.filter((field) => own.fields.has(field)),
    };
  }
  const own = await input.resolve(input.own);
  const target = input.resolved ?? own;
  const status = target?.status;
  const paired =
    status !== undefined &&
    own?.status !== undefined &&
    fields[status.field] !== undefined &&
    "from" in (fields[status.field] ?? {});
  if (simple && !paired) return { fields: undefined, omitted: unnamed };
  const map = new FieldMap({
    label: input.label,
    own: input.own,
    target: input.target,
    kindFields,
    fields,
    overrides,
    ownStatus: own?.status,
    targetStatus: status,
    heldLink,
  });
  return { fields: map, omitted: [...map.omitted] };
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
    const entry =
      kind.name === undefined ? undefined : mapping.kinds[kind.name];
    if (target === own) {
      const shaped = await shapeFields({
        label,
        own,
        target,
        kindFields: kind.fields,
        entry,
        heldLink: undefined,
        resolve,
        resolved: undefined,
      });
      if (shaped.omitted.length > 0)
        conditions.set(
          `mapping-fields:${label}`,
          `the kind ${label} lands on ${target} without ${shaped.omitted.join(", ")}, since its mapping fills no field from them`,
        );
      plans.set(own, {
        ...base,
        off: undefined,
        omitted: shaped.omitted,
        fields: shaped.fields,
      });
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
    const shaped = await shapeFields({
      label,
      own,
      target,
      kindFields: kind.fields,
      entry,
      heldLink,
      resolve,
      resolved,
    });
    const omitted =
      entry?.fields === undefined
        ? kind.fields.filter(
            (field) => field !== heldLink && !resolved.fields.has(field),
          )
        : shaped.omitted;
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
        `the kind ${label} lands on ${target} without ${left.join(", ")}, ${entry?.fields === undefined ? "which that type does not declare" : "since its mapping fills no field from them, or that type does not declare them"}`,
      );
    }
    plans.set(own, {
      ...base,
      off: undefined,
      omitted,
      omittedTables,
      heldLink,
      fields: shaped.fields,
    });
    placed.set(own, { target, above: resolved.above });
  }
  if ([...plans.values()].some((plan) => plan.fields?.templated === true))
    await loadTemplates();
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

/** A kind as a preview reads it: its name, its own type and the fields the
 *  connector declares for it. */
export interface PreviewKind {
  readonly name?: string | undefined;
  readonly type: { readonly id: string; readonly link_field?: string };
  readonly fields: readonly string[];
}

/**
 * What the kit would write for one entry of a kind, or one of the kind's
 * stored items, under the kind's entry of a mapping: the item as it would
 * land, in the form a preview's `result` takes, with the conditions the
 * write would raise. It reads nothing from Marfa or the vendor: `own` and
 * `target` are the kind's own type and the target type as Marfa answers
 * them. An item already on the target is read back first, so a template
 * sees only the fields the mapping carries from it.
 */
export async function previewOf(input: {
  readonly kind: PreviewKind;
  readonly mapping: KindMapping;
  readonly own: ResolvedType;
  readonly target: ResolvedType;
  readonly from: { readonly entry: Entry } | { readonly item: Item };
}): Promise<{ result: PreviewResult; conditions: FieldFaults }> {
  const { kind, mapping, own, target } = input;
  const targetType = mapping.target_type ?? own.id;
  const link = kind.type.link_field;
  const heldLink =
    targetType !== own.id && link !== undefined && target.link !== link
      ? link
      : undefined;
  const fields =
    mapping.fields ??
    Object.fromEntries(
      kind.fields
        .filter((field) => target.fields.has(field))
        .map((field) => [field, { from: field }]),
    );
  const map = new FieldMap({
    label: kind.name ?? own.id,
    own: own.id,
    target: targetType,
    kindFields: kind.fields,
    fields,
    overrides: mapping.status_overrides ?? {},
    ownStatus: own.status,
    targetStatus: target.status,
    heldLink,
  });
  if (map.templated) await loadTemplates();
  let entry: Entry;
  let kept: Record<string, unknown> = {};
  let sourceItem: string | null = null;
  if ("entry" in input.from) entry = input.from.entry;
  else {
    const { item } = input.from;
    sourceItem = item.id;
    let properties: Record<string, unknown> = { ...item.properties };
    if (item.type === targetType && targetType !== own.id) {
      const view = map.read(item.properties);
      const made = new Set(map.made);
      properties = {};
      for (const [key, value] of Object.entries(view)) {
        if (key.startsWith(targetPrefix)) {
          if (!made.has(key)) kept[key] = value;
        } else if (!key.startsWith("@")) properties[key] = value;
      }
    } else kept = {};
    entry = { source_id: item.source_id ?? item.id, properties };
  }
  const shaped = map.entry(
    entry,
    "item" in input.from ? input.from.item.id : undefined,
  );
  const properties = map.write({ ...kept, ...shaped.entry.properties });
  const titleField = target.titleField;
  const title = titleField === undefined ? undefined : properties[titleField];
  return {
    result: {
      type: targetType,
      properties,
      ...(typeof title === "string" && { title }),
      source_item: sourceItem,
    },
    conditions: shaped.faults,
  };
}
