import type { Connector, SettingsDeclaration } from "../src/define.js";
import { start as begin } from "../src/main.js";
import type { Runtime } from "../src/runtime.js";
import { ScriptedServer } from "./scripted-server.js";

/**
 * Starts a connector against a scripted server that holds its plugin's types
 * and connection types, as an owner's `marfa plugins install` leaves a Marfa:
 * the kit registers neither, so a start finds them there or says they differ.
 * A test that means something else sets the server's types itself first, or
 * turns `installs` off.
 */
export function start<E extends SettingsDeclaration>(
  connector: Connector<E>,
  runtime: Runtime,
): Promise<number> {
  ScriptedServer.at(runtime.env["MARFA_API_URL"]?.trim())?.install(connector);
  return begin(connector, runtime);
}
