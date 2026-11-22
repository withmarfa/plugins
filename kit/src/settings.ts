import type { Setting, SettingsDeclaration, SettingValues } from "./define.js";
import { shortestSecret } from "./environment.js";

/** A setting as the connector's own settings door answers it. */
export interface HeldSetting {
  readonly name: string;
  readonly value?: unknown;
  readonly set?: boolean;
  readonly secret?: boolean;
  readonly unreadable?: boolean;
}

/** What `GET /connectors/{id}/settings` answers. */
export interface HeldSettings {
  readonly plugin: string;
  readonly settings: readonly HeldSetting[];
  readonly missing: readonly string[];
}

export type ReadSettings<E extends SettingsDeclaration> =
  | {
      readonly values: SettingValues<E>;
      readonly problem?: undefined;
    }
  | { readonly values?: undefined; readonly problem: string };

/** Whether a setting is secret: the build declares it so, or Marfa says it
 *  holds it as one. */
function secretIn(
  declared: SettingsDeclaration,
  held: HeldSettings,
): (name: string) => boolean {
  const secret = new Set([
    ...declared
      .filter((setting) => setting.secret === true)
      .map((setting) => setting.name),
    ...held.settings
      .filter((setting) => setting.secret === true)
      .map((setting) => setting.name),
  ]);
  return (name) => secret.has(name);
}

/** Every secret value the answer holds, whatever the connector makes of it,
 *  so the log redacts them before anything else is said. One too short to
 *  redact without hiding ordinary words is left out: `readSettings` and
 *  setup refuse it, so the connector never reads it, and the kit never says
 *  a value. */
export function secretsOf(
  declared: SettingsDeclaration,
  held: HeldSettings,
): string[] {
  const secret = secretIn(declared, held);
  return held.settings.flatMap((setting) =>
    secret(setting.name) &&
    typeof setting.value === "string" &&
    setting.value.length >= shortestSecret
      ? [setting.value]
      : [],
  );
}

/** Why the secrets held cannot be read, where one is too short to keep out
 *  of the logs, naming each by label and name and never a value. */
export function shortSecretsProblem(
  declared: SettingsDeclaration,
  held: HeldSettings,
): string | undefined {
  const secret = secretIn(declared, held);
  const short = held.settings.filter(
    (setting) =>
      secret(setting.name) &&
      typeof setting.value === "string" &&
      setting.value.length < shortestSecret,
  );
  if (short.length === 0) return undefined;
  const names = short.map((setting) => {
    const one = declared.find((each) => each.name === setting.name);
    return one === undefined ? setting.name : named(one);
  });
  return `${names.join(", ")} ${short.length === 1 ? "is" : "are"} shorter than ${String(shortestSecret)} characters, too short to keep out of the logs`;
}

function named(setting: Setting): string {
  return `${setting.label} (${setting.name})`;
}

function fitsKind(setting: Setting, value: unknown): boolean {
  switch (setting.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "choice":
      return (
        typeof value === "string" && (setting.choices ?? []).includes(value)
      );
    case "text":
      return typeof value === "string" && value !== "";
    default:
      return false;
  }
}

const kindWords: Record<string, string> = {
  boolean: "true or false",
  number: "a number",
  choice: "one of its choices",
  text: "text",
};

/** How to set a setting, as the owner types it. */
export function setCommand(plugin: string, setting: Setting): string {
  return setting.secret === true
    ? `marfa plugins secret ${plugin} ${setting.name}`
    : `marfa plugins settings ${plugin} --set ${setting.name}=<value>`;
}

/**
 * The settings as the connector reads them, typed by kind with the declared
 * default applied, or why the run cannot start with them: a required setting
 * with no value, a secret Marfa cannot open, or a value not of its kind. The
 * reason names each setting by label and name, and never a value.
 */
export function readSettings<E extends SettingsDeclaration>(
  declared: E,
  held: HeldSettings,
): ReadSettings<E> {
  const values: Record<string, unknown> = {};
  const missing = new Set(held.missing);
  const unreadable: Setting[] = [];
  const invalid: string[] = [];
  for (const setting of declared) {
    const answered = held.settings.find((one) => one.name === setting.name);
    if (answered?.unreadable === true) unreadable.push(setting);
    let value = answered?.value ?? undefined;
    value ??= setting.secret === true ? undefined : setting.default;
    if (value === undefined) {
      if (setting.required === true) missing.add(setting.name);
      values[setting.name] = undefined;
      continue;
    }
    if (!fitsKind(setting, value)) {
      invalid.push(
        `${named(setting)} is not ${kindWords[setting.kind] ?? setting.kind}`,
      );
      continue;
    }
    values[setting.name] = value;
  }
  const short = shortSecretsProblem(declared, held);
  if (short !== undefined) invalid.push(short);
  const problems: string[] = [];
  const unreadableNames = new Set(unreadable.map((setting) => setting.name));
  const lacking = declared.filter(
    (setting) =>
      missing.has(setting.name) && !unreadableNames.has(setting.name),
  );
  if (lacking.length > 0) {
    problems.push(
      `${lacking.length === 1 ? "a required setting is" : "required settings are"} not set: ${lacking.map(named).join(", ")}. Set ${lacking.length === 1 ? "it" : "them"} with ${lacking.map((setting) => `\`${setCommand(held.plugin, setting)}\``).join(", ")}`,
    );
  }
  if (unreadable.length > 0) {
    problems.push(
      `Marfa holds a value it cannot open for ${unreadable.map(named).join(", ")}, as after a restore onto another machine. Set ${unreadable.length === 1 ? "it" : "them"} again with ${unreadable.map((setting) => `\`${setCommand(held.plugin, setting)}\``).join(", ")}`,
    );
  }
  if (invalid.length > 0) {
    problems.push(
      `a setting holds a value the connector cannot use: ${invalid.join("; ")}`,
    );
  }
  if (problems.length > 0) {
    return {
      problem: `the connector cannot run with its settings: ${problems.join("; ")}`,
    };
  }
  return { values: values as SettingValues<E> };
}
