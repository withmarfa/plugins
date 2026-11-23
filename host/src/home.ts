import { join } from "node:path";

/**
 * The folder the host keeps everything in: `MARFA_CONNECTOR_HOST_HOME` when
 * set, else the platform's place for an app's data.
 */
export function homeFolder(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  userHome: string,
): string {
  const chosen = env["MARFA_CONNECTOR_HOST_HOME"];
  if (chosen !== undefined && chosen !== "") return chosen;
  if (platform === "darwin")
    return join(
      userHome,
      "Library",
      "Application Support",
      "Marfa",
      "Connector Host",
    );
  const data = env["XDG_DATA_HOME"];
  const base =
    data !== undefined && data.startsWith("/")
      ? data
      : join(userHome, ".local", "share");
  return join(base, "marfa", "connector-host");
}

const pluginName = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const digest = /^[0-9a-f]{64}$/;

/** Whether `name` is a plugin's name, lowercase words and numbers joined by
 *  hyphens, and so can name a folder of its own. */
export function safePluginName(name: string): boolean {
  return name.length <= 128 && pluginName.test(name);
}

export function safeDigest(sha256: string): boolean {
  return digest.test(sha256);
}

/** Where each file lives inside the host's folder. */
export class Home {
  constructor(readonly root: string) {}

  get hostJson(): string {
    return join(this.root, "host.json");
  }

  get hostKey(): string {
    return join(this.root, "host.key");
  }

  get status(): string {
    return join(this.root, "status.json");
  }

  get lock(): string {
    return join(this.root, "run.lock");
  }

  get connectors(): string {
    return join(this.root, "connectors");
  }

  get logs(): string {
    return join(this.root, "logs");
  }

  get hostLog(): string {
    return join(this.logs, "host.log");
  }

  connector(plugin: string): string {
    if (!safePluginName(plugin))
      throw new Error(`${JSON.stringify(plugin)} cannot name a folder`);
    return join(this.connectors, plugin);
  }

  key(plugin: string): string {
    return join(this.connector(plugin), "key");
  }

  /** The version the key on disk was minted for. */
  minted(plugin: string): string {
    return join(this.connector(plugin), "minted");
  }

  code(plugin: string): string {
    return join(this.connector(plugin), "code");
  }

  codeFile(plugin: string, sha256: string): string {
    if (!safeDigest(sha256))
      throw new Error(`${JSON.stringify(sha256)} is not a SHA-256`);
    return join(this.code(plugin), `${sha256}.mjs`);
  }

  pluginLog(plugin: string): string {
    if (!safePluginName(plugin))
      throw new Error(`${JSON.stringify(plugin)} cannot name a file`);
    return join(this.logs, `${plugin}.log`);
  }
}
