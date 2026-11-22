import type { Connector, Setting, SettingsDeclaration } from "./define.js";
import { shippedConnection, wireOf } from "./shipped.js";

export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

/** What the kit reads from the environment: Marfa's address and the
 *  connector's key. Every other setting comes from Marfa. */
export interface Environment {
  url: string;
  key: string;
}

const reservedSourcePrefixes = ["oauth:", "restored:", "connector:"];

/** Shorter than this, a secret cannot be redacted without the redaction
 *  showing where each character falls in ordinary text. */
export const shortestSecret = 8;

function isServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      !/[?#]/.test(value)
    );
  } catch {
    return false;
  }
}

export function readEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Environment {
  const present = (name: string): string | undefined => {
    const trimmed = env[name]?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
  };
  const url = present("MARFA_API_URL");
  const key = present("MARFA_API_KEY");
  const missing = [
    ...(url === undefined ? ["MARFA_API_URL"] : []),
    ...(key === undefined ? ["MARFA_API_KEY"] : []),
  ];
  if (url === undefined || key === undefined) {
    throw new ConfigurationError(
      `cannot start without ${missing.join(", ")} in the environment`,
    );
  }
  // Named and not shown: a value pasted into the wrong variable is often
  // the key itself.
  if (!isServerUrl(url)) {
    throw new ConfigurationError(
      "MARFA_API_URL is not an http or https address without credentials, a query or a fragment",
    );
  }
  if (key.length < shortestSecret) {
    throw new ConfigurationError(
      `MARFA_API_KEY is shorter than ${String(shortestSecret)} characters, too short to keep out of the logs`,
    );
  }
  return { url, key };
}

function fitsText(text: string, longest: number): boolean {
  return text.trim() !== "" && text.length <= longest;
}

/** A setting's or a kind's name as the contract writes it. */
const snakeCase = /^[a-z][a-z0-9_]*$/;

const settingKinds: readonly string[] = ["text", "number", "boolean", "choice"];
const directions: readonly string[] = ["in", "out", "both"];

function fits(setting: Setting): boolean {
  const given = setting.default;
  if (given === undefined) return true;
  switch (setting.kind) {
    case "text":
      return typeof given === "string";
    case "number":
      return typeof given === "number" && Number.isFinite(given);
    case "boolean":
      return typeof given === "boolean";
    case "choice":
      return (
        typeof given === "string" && (setting.choices ?? []).includes(given)
      );
    default:
      return false;
  }
}

/** What stops the settings a connector declares from being the plugin's
 *  manifest: each is a refusal `POST /plugins` would make, found here first. */
function settingProblems(settings: readonly Setting[]): string[] {
  const problems: string[] = [];
  const named = settings.map((setting) => setting.name);
  const bad = named.filter((name) => !snakeCase.test(name) || name.length > 64);
  if (bad.length > 0) {
    problems.push(
      `each setting named in lowercase letters, digits and underscores, starting with a letter, at most 64 characters, where ${bad.join(", ")} is not`,
    );
  }
  if (new Set(named).size !== named.length) problems.push("each setting once");
  const unlabeled = settings.filter(
    (setting) =>
      typeof setting.label !== "string" ||
      setting.label.trim() === "" ||
      setting.label.length > 100,
  );
  if (unlabeled.length > 0) {
    problems.push(
      `each setting labeled with 1 to 100 characters, where ${unlabeled.map((setting) => setting.name).join(", ")} is not`,
    );
  }
  const kindless = settings.filter(
    (setting) => !settingKinds.includes(setting.kind),
  );
  if (kindless.length > 0) {
    problems.push(
      `each setting of kind text, number, boolean or choice, where ${kindless.map((setting) => setting.name).join(", ")} is not`,
    );
  }
  const secrets = settings.filter((setting) => setting.secret === true);
  const wrongKind = secrets.filter((setting) => setting.kind !== "text");
  if (wrongKind.length > 0) {
    problems.push(
      `a secret setting to be text, where ${wrongKind.map((setting) => setting.name).join(", ")} is not`,
    );
  }
  const withDefault = secrets.filter(
    (setting) => setting.default !== undefined,
  );
  if (withDefault.length > 0) {
    problems.push(
      `a secret setting to have no default, where ${withDefault.map((setting) => setting.name).join(", ")} has one`,
    );
  }
  const misfit = settings.filter(
    (setting) =>
      settingKinds.includes(setting.kind) &&
      setting.secret !== true &&
      !fits(setting),
  );
  if (misfit.length > 0) {
    problems.push(
      `a default of its setting's kind, and one of its choices for a choice, where ${misfit.map((setting) => setting.name).join(", ")} has not`,
    );
  }
  const choiceless = settings.filter((setting) =>
    setting.kind === "choice"
      ? (setting.choices ?? []).length === 0
      : setting.choices !== undefined,
  );
  if (choiceless.length > 0) {
    problems.push(
      `choices for each choice setting and for no other, where ${choiceless.map((setting) => setting.name).join(", ")} does not`,
    );
  }
  const choices = settings.filter(
    (setting) =>
      new Set(setting.choices).size !== (setting.choices ?? []).length ||
      (setting.choices ?? []).some(
        (choice) => choice === "" || choice.length > 100,
      ),
  );
  if (choices.length > 0) {
    problems.push(
      `choices of 1 to 100 characters, each once, where ${choices.map((setting) => setting.name).join(", ")} has others`,
    );
  }
  return problems;
}

/** The 200, 2000 and 200 limits are the server's bounds on a registration and
 *  a source. */
export function checkDefinition<E extends SettingsDeclaration>(
  connector: Connector<E>,
): void {
  const problems: string[] = [];
  if (connector.name.length < 1 || connector.name.length > 200) {
    problems.push("a name of 1 to 200 characters");
  }
  if ((connector.description?.length ?? 0) > 2000) {
    problems.push("a description of at most 2000 characters");
  }
  const source = connector.source.trim();
  if (source === "" || source.length > 200) {
    problems.push("a source of 1 to 200 characters");
  }
  const lowered = source.toLowerCase();
  if (reservedSourcePrefixes.some((prefix) => lowered.startsWith(prefix))) {
    problems.push(
      `a source outside the reserved ${reservedSourcePrefixes.join(" and ")} prefixes`,
    );
  }
  problems.push(...settingProblems(connector.settings ?? []));
  if (connector.title !== undefined && !fitsText(connector.title, 100)) {
    problems.push("a title of 1 to 100 characters");
  }
  if (connector.maker !== undefined && !fitsText(connector.maker, 64)) {
    problems.push("a maker of 1 to 64 characters");
  }
  const kindNames = connector.types.flatMap((kind) =>
    kind.name === undefined ? [] : [kind.name],
  );
  const badKindNames = kindNames.filter(
    (name) => !snakeCase.test(name) || name.length > 64,
  );
  if (badKindNames.length > 0) {
    problems.push(
      `each kind named in lowercase letters, digits and underscores, starting with a letter, at most 64 characters, where ${badKindNames.join(", ")} is not`,
    );
  }
  if (new Set(kindNames).size !== kindNames.length)
    problems.push("each kind once");
  const badDirections = connector.types.filter(
    (kind) =>
      kind.direction !== undefined && !directions.includes(kind.direction),
  );
  if (badDirections.length > 0) {
    problems.push(
      `each kind to move in, out or both, where ${badDirections.map((kind) => kind.type.id).join(", ")} does not`,
    );
  }
  const ids = connector.types.map((kind) => kind.type.id);
  if (ids.length < 1 || ids.length > 10) {
    problems.push("one to ten types, as far as the log's type filter reaches");
  }
  if (new Set(ids).size !== ids.length) problems.push("each type once");
  for (const kind of connector.types) {
    const from = new Set(
      (connector.connections ?? [])
        .filter((connection) =>
          connection.from_type_constraints?.includes(kind.type.id),
        )
        .map((connection) => connection.id),
    );
    const outside = [
      ...(kind.readOnly ?? []).filter((name) => !from.has(name)),
      ...(kind.type.link_field === undefined ? [] : [kind.type.link_field]),
    ].filter((field) => !kind.fields.includes(field));
    const loose = (kind.derived ?? []).filter(
      (field) => !(kind.readOnly ?? []).includes(field),
    );
    if (loose.length > 0) {
      problems.push(
        `${kind.type.id}'s derived fields among its read-only fields, where ${loose.join(", ")} ${loose.length === 1 ? "is" : "are"} not`,
      );
    }
    if (outside.length > 0) {
      problems.push(
        `${kind.type.id}'s link and read-only fields among its fields or the connection types from it, where ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not`,
      );
    }
  }
  const types = new Set(ids);
  const connections = (connector.connections ?? []).map((kind) => kind.id);
  const clashing = connections.filter((id) =>
    connector.types.some((kind) => kind.fields.includes(id)),
  );
  if (clashing.length > 0) {
    problems.push(
      `connection types named apart from every field, where ${clashing.join(", ")} ${clashing.length === 1 ? "is" : "are"} both`,
    );
  }
  if (new Set(connections).size !== connections.length) {
    problems.push("each connection type once");
  }
  const edges = (connector.connections ?? []).map(
    (kind) => wireOf(kind.id).edge,
  );
  if (
    new Set(connections).size === connections.length &&
    new Set(edges).size !== edges.length
  ) {
    problems.push(
      "child-of and parent-of declared once between them, since they are one edge type",
    );
  }
  for (const kind of connector.connections ?? []) {
    const ends = [
      ...(kind.from_type_constraints ?? []),
      ...(kind.to_type_constraints ?? []),
    ];
    if (
      (kind.from_type_constraints ?? []).length === 0 ||
      (kind.to_type_constraints ?? []).length === 0 ||
      ends.some((end) => !types.has(end))
    ) {
      problems.push(`${kind.id}'s both ends constrained to its own types`);
    }
    const wire = wireOf(kind.id);
    if (
      wire.inbound &&
      connector.types.some(
        (held) => held.policy !== undefined && ends.includes(held.type.id),
      )
    ) {
      problems.push(
        `${kind.id}'s ends without a row policy, since the instance conditions an edge's write only on its source's version`,
      );
    }
    if (
      shippedConnection(kind.id) === undefined &&
      (kind.cascade_on_delete ?? "orphan") !== "orphan"
    ) {
      problems.push(
        `${kind.id} to orphan on delete, so a trash in Marfa takes no vendor's row with it`,
      );
    }
    if (
      Object.values(kind.property_schema ?? {}).some(
        (property) => property.required === true,
      )
    ) {
      problems.push(
        `${kind.id} to require no property, since the kit writes none`,
      );
    }
  }
  if (problems.length > 0) {
    throw new ConfigurationError(`the connector needs ${problems.join("; ")}`);
  }
}
