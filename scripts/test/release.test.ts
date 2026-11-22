import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  assertAbsent,
  build,
  checksumsFile,
  publish,
  versionOf,
  versionOfTag,
} from "../release/release.js";
import { emptyTree, remove, writePlugin } from "./plugin-fixtures.js";

const root = resolve(import.meta.dirname, "../..");

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

interface Listed {
  name: string;
  version: string;
  bundle: string;
  sha256: string;
}

let base: string;
let out: string;
const made: string[] = [];

beforeEach(async () => {
  base = await emptyTree();
  out = join(await emptyTree(), "release");
  made.push(base, out);
  await writePlugin(base, "types/alpha", {
    guidance: { "common.alpha": "Use alpha well.\n" },
  });
  await writePlugin(base, "connectors/beta/plugin");
});

afterEach(async () => {
  for (const folder of made.splice(0)) await remove(folder);
});

describe("the build", () => {
  it("writes a bundle for each plugin, an index and a checksums file, and nothing else", async () => {
    const files = await build("0.0.13", out, base);
    expect(files).toEqual([
      "alpha.plugin.json",
      "beta.plugin.json",
      checksumsFile,
      "plugins.json",
    ]);
    expect((await readdir(out)).sort()).toEqual(files);
  });

  it("lists each bundle with the SHA-256 of the file, and stamps the version of the tag in the index and the bundle", async () => {
    await build("0.0.13", out, base);
    const index = JSON.parse(
      await readFile(join(out, "plugins.json"), "utf8"),
    ) as {
      format: number;
      plugins: Listed[];
    };
    expect(index.format).toBe(1);
    expect(index.plugins.map((entry) => entry.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    for (const entry of index.plugins) {
      const bytes = await readFile(join(out, entry.bundle));
      expect(entry.sha256).toBe(sha256(bytes));
      expect(entry.version).toBe("0.0.13");
      const bundle = JSON.parse(bytes.toString("utf8")) as {
        version: string;
        types: { guidance?: string }[];
      };
      expect(bundle.version).toBe("0.0.13");
    }
    const alpha = JSON.parse(
      await readFile(join(out, "alpha.plugin.json"), "utf8"),
    ) as { types: { guidance?: string }[] };
    expect(alpha.types[0]?.guidance).toBe("Use alpha well.");
  });

  it("lists every file but itself in the checksums, each with the SHA-256 of its bytes", async () => {
    await build("0.0.13", out, base);
    const lines = (await readFile(join(out, checksumsFile), "utf8"))
      .trim()
      .split("\n");
    const names = lines.map((line) => line.split("  ")[1]);
    expect(names).toEqual([
      "alpha.plugin.json",
      "beta.plugin.json",
      "plugins.json",
    ]);
    for (const line of lines) {
      const [sha, name] = line.split("  ");
      expect(sha).toBe(sha256(await readFile(join(out, name ?? ""))));
    }
  });

  it("fails a plugin.json that names a version, naming the folder, and builds once it is gone", async () => {
    await writePlugin(base, "types/versioned", {
      manifest: { version: "1.0.0" },
    });
    await expect(build("0.0.13", out, base)).rejects.toThrow(
      /types\/versioned[^]*version/,
    );
    expect(await readdir(out).catch(() => [])).toEqual([]);

    await writePlugin(base, "types/versioned");
    expect(await build("0.0.13", out, base)).toContain("versioned.plugin.json");
  });

  it("fails a folder of types that is no plugin, since it would never be released", async () => {
    await mkdir(join(base, "types", "forgotten"), { recursive: true });
    await expect(build("0.0.13", out, base)).rejects.toThrow("types/forgotten");
  });

  it("fails into a folder that is not empty, never mixing two releases", async () => {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "left-behind.plugin.json"), "{}");
    await expect(build("0.0.13", out, base)).rejects.toThrow("is not empty");
  });

  it("refuses what is not a version or a tag", () => {
    for (const text of ["", "1.2", "v1.2.3", "1.2.3-rc1"]) {
      expect(() => versionOf(text), text).toThrow("is not a version");
    }
    for (const text of ["1.2.3", "v1.2", "v1.2.3-rc1", "refs/tags/v1.2.3"]) {
      expect(() => versionOfTag(text), text).toThrow("is not a tag");
    }
    expect(versionOfTag("v1.2.3")).toBe("1.2.3");
  });

  it("builds a tree with no plugin into an index that lists none", async () => {
    const empty = await emptyTree();
    made.push(empty);
    expect(await build("0.0.1", out, empty)).toEqual([
      checksumsFile,
      "plugins.json",
    ]);
  });
});

describe("publishing", () => {
  let fake: string;
  let log: string;

  function fakeGh(view: "absent" | "exists" | "error"): void {
    vi.stubEnv("FAKE_GH_VIEW", view);
  }

  beforeEach(async () => {
    const folder = await emptyTree();
    made.push(folder);
    fake = join(folder, "gh");
    log = join(folder, "calls.log");
    await writeFile(
      fake,
      [
        "#!/bin/sh",
        'echo "$@" >> "$FAKE_GH_LOG"',
        'if [ "$1 $2" = "release view" ]; then',
        '  case "$FAKE_GH_VIEW" in',
        "    exists) exit 0 ;;",
        '    error) echo "error connecting to api.github.com" >&2; exit 1 ;;',
        '    *) echo "release not found" >&2; exit 1 ;;',
        "  esac",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    vi.stubEnv("FAKE_GH_LOG", log);
    fakeGh("absent");
    await build("0.0.13", out, base);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const calls = async (): Promise<string[]> =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean);

  it("creates the release of the tag with every asset, marked latest, never overwriting", async () => {
    const files = await publish("v0.0.13", out, { gh: fake });
    expect(files).toEqual([
      "alpha.plugin.json",
      "beta.plugin.json",
      checksumsFile,
      "plugins.json",
    ]);
    const all = await calls();
    expect(all[0]).toBe("release view v0.0.13");
    const create = all[1] ?? "";
    expect(create).toMatch(/^release create v0\.0\.13 /);
    for (const file of files) expect(create).toContain(join(out, file));
    expect(create).toContain("--latest");
    expect(create).toContain("--verify-tag");
    expect(create).not.toContain("--clobber");
    expect(all).toHaveLength(2);
  });

  it("publishes nothing in a dry run, which still checks everything", async () => {
    const files = await publish("v0.0.13", out, { gh: fake, dryRun: true });
    expect(files).toContain("plugins.json");
    expect(await calls()).toEqual(["release view v0.0.13"]);
  });

  it("fails when a release exists for the tag, and creates nothing", async () => {
    fakeGh("exists");
    await expect(publish("v0.0.13", out, { gh: fake })).rejects.toThrow(
      "a release for v0.0.13 exists; it is never overwritten",
    );
    expect(await calls()).toEqual(["release view v0.0.13"]);
  });

  it("fails when it cannot ask whether the release exists, and creates nothing", async () => {
    fakeGh("error");
    await expect(publish("v0.0.13", out, { gh: fake })).rejects.toThrow(
      "could not ask whether a release for v0.0.13 exists",
    );
    expect(await calls()).toEqual(["release view v0.0.13"]);
  });

  it("asks alone whether a release exists", async () => {
    await expect(assertAbsent("v0.0.13", fake)).resolves.toBeUndefined();
    fakeGh("exists");
    await expect(assertAbsent("v0.0.13", fake)).rejects.toThrow("exists");
  });

  it("refuses a folder whose files are not the ones the checksums list, creating nothing", async () => {
    await writeFile(join(out, "alpha.plugin.json"), "{}");
    await expect(publish("v0.0.13", out, { gh: fake })).rejects.toThrow(
      "are not the ones checksums.txt lists",
    );
    expect(await calls()).toEqual([]);
  });

  it("refuses a tag other than the version the plugins were built at, creating nothing", async () => {
    await expect(publish("v0.0.14", out, { gh: fake })).rejects.toThrow(
      "is version 0.0.13, and the tag is v0.0.14",
    );
    expect(await calls()).toEqual([]);
  });

  it("refuses a folder that holds no index, and a name that is no tag", async () => {
    const bare = await emptyTree();
    made.push(bare);
    await expect(publish("v0.0.13", bare, { gh: fake })).rejects.toThrow(
      "holds no plugins.json",
    );
    await expect(publish("main", out, { gh: fake })).rejects.toThrow(
      "is not a tag",
    );
    expect(await calls()).toEqual([]);
  });
});

describe("the release workflow", () => {
  interface Job {
    needs?: string | string[];
    if?: string;
    "runs-on": string;
    permissions?: Record<string, string>;
    steps: {
      name?: string;
      uses?: string;
      run?: string;
      with?: Record<string, string>;
    }[];
  }
  interface Workflow {
    on: {
      push?: { tags?: string[]; branches?: string[] };
      workflow_dispatch?: unknown;
    };
    permissions?: Record<string, string>;
    jobs: Record<string, Job>;
  }
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
  ) as Workflow;

  it("runs for a pushed version tag and by hand, and for no branch", () => {
    expect(workflow.on.push).toEqual({ tags: ["v*"] });
    expect(workflow.on.workflow_dispatch).toBeDefined();
  });

  it("holds no permission by default, and each job only the ones it uses", () => {
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs["build"]?.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs["publish"]?.permissions).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });
  });

  it("publishes only for a pushed tag, after the build, so a manual run publishes nothing", () => {
    const job = workflow.jobs["publish"];
    expect(job?.needs).toBe("build");
    expect(job?.if).toBe("${{ github.event_name == 'push' }}");
    expect(workflow.jobs["build"]?.if).toBeUndefined();
  });

  it("attests the assets before it publishes them", () => {
    const steps = workflow.jobs["publish"]?.steps ?? [];
    const attest = steps.findIndex((step) =>
      step.uses?.startsWith("actions/attest-build-provenance@"),
    );
    const create = steps.findIndex((step) =>
      step.run?.includes("release.ts publish"),
    );
    expect(attest).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(attest);
  });

  it("runs on standard hosted Linux", () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job["runs-on"]).toBe("ubuntu-latest");
    }
  });
});
