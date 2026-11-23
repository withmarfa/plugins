import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { Platform } from "../node-pin.js";
import { platforms } from "../node-pin.js";
import { hostArchiveName, installHostName } from "../release/host-archive.js";
import type { Index } from "../release/only-adds.js";
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

async function standInNode(
  platform: Platform,
): Promise<{ node: string; license: string }> {
  const dir = await emptyTree();
  made.push(dir);
  await mkdir(join(dir, "bin"), { recursive: true });
  const node = join(dir, "bin", "node");
  await writeFile(node, `node ${platform}\n`);
  const license = join(dir, "LICENSE");
  await writeFile(license, `license ${platform}\n`);
  return { node, license };
}

const parts = {
  node: standInNode,
  async bundleHost(file: string): Promise<void> {
    await writeFile(file, "console.log('host')\n");
  },
};

function releaseBuild(
  version = "0.0.13",
  folder = out,
  tree = base,
): Promise<string[]> {
  return build(version, folder, tree, parts);
}

function releaseFiles(version = "0.0.13"): string[] {
  return [
    "alpha.plugin.json",
    "beta.plugin.json",
    checksumsFile,
    installHostName,
    ...platforms.map((platform) => hostArchiveName(version, platform)),
    "plugins.json",
  ];
}

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
    const files = await releaseBuild();
    expect(files).toEqual(releaseFiles());
    expect((await readdir(out)).sort()).toEqual(files);
  });

  it("lists each bundle with the SHA-256 of the file, and stamps the version of the tag in the index and the bundle", async () => {
    await releaseBuild();
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
    await releaseBuild();
    const lines = (await readFile(join(out, checksumsFile), "utf8"))
      .trim()
      .split("\n");
    const names = lines.map((line) => line.split("  ")[1]);
    expect(names).toEqual(
      releaseFiles().filter((name) => name !== checksumsFile),
    );
    for (const line of lines) {
      const [sha, name] = line.split("  ");
      expect(sha).toBe(sha256(await readFile(join(out, name ?? ""))));
    }
  });

  it("fails a plugin.json that names a version, naming the folder, and builds once it is gone", async () => {
    await writePlugin(base, "types/versioned", {
      manifest: { version: "1.0.0" },
    });
    await expect(releaseBuild()).rejects.toThrow(/types\/versioned[^]*version/);
    expect(await readdir(out).catch(() => [])).toEqual([]);

    await writePlugin(base, "types/versioned");
    expect(await releaseBuild()).toContain("versioned.plugin.json");
  });

  it("fails a folder of types that is no plugin, since it would never be released", async () => {
    await mkdir(join(base, "types", "forgotten"), { recursive: true });
    await expect(releaseBuild()).rejects.toThrow("types/forgotten");
  });

  it("fails into a folder that is not empty, never mixing two releases", async () => {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "left-behind.plugin.json"), "{}");
    await expect(releaseBuild()).rejects.toThrow("is not empty");
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

  it("fails a tree with no plugin, so no empty release is made", async () => {
    const empty = await emptyTree();
    made.push(empty);
    await expect(build("0.0.1", out, empty)).rejects.toThrow(
      "there is no plugin to release",
    );
  });
});

describe("publishing", () => {
  let fake: string;
  let log: string;
  let state: string;

  /** What the release of the tag is, as the fake `gh` answers. */
  function fakeGh(view: "absent" | "draft" | "published" | "error"): void {
    writeFileSync(state, `${view}\n`);
  }

  beforeEach(async () => {
    const folder = await emptyTree();
    made.push(folder);
    fake = join(folder, "gh");
    log = join(folder, "calls.log");
    state = join(folder, "state");
    await writeFile(
      fake,
      [
        "#!/bin/sh",
        'echo "$@" >> "$FAKE_GH_LOG"',
        'state=$(cat "$FAKE_GH_STATE")',
        'case "$1 $2" in',
        '  "release view")',
        '    case "$state" in',
        "      draft) echo '{\"isDraft\":true}' ;;",
        "      published) echo '{\"isDraft\":false}' ;;",
        '      error) echo "error connecting to api.github.com" >&2; exit 1 ;;',
        '      *) echo "release not found" >&2; exit 1 ;;',
        "    esac ;;",
        '  "release create") echo draft > "$FAKE_GH_STATE" ;;',
        '  "release delete") echo absent > "$FAKE_GH_STATE" ;;',
        '  "release edit")',
        '    case "${FAKE_GH_FAIL:-}" in',
        '      edit) echo "edit failed" >&2; exit 1 ;;',
        '      edit-after-publishing) echo published > "$FAKE_GH_STATE"; echo "edit failed" >&2; exit 1 ;;',
        "    esac",
        '    echo published > "$FAKE_GH_STATE" ;;',
        "esac",
        "exit 0",
        "",
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    vi.stubEnv("FAKE_GH_STATE", state);
    vi.stubEnv("FAKE_GH_LOG", log);
    fakeGh("absent");
    await releaseBuild();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const none = (): Promise<undefined> => Promise.resolve(undefined);
  const listing = (version: string) => (): Promise<Index> =>
    Promise.resolve({
      format: 1,
      plugins: [
        {
          name: "alpha",
          version,
          has_connector: false,
          bundle: "alpha.plugin.json",
          sha256: "0".repeat(64),
        },
      ],
    });

  it("refuses a tag no later than the latest release, creating nothing, and publishes a later one", async () => {
    for (const version of ["0.0.13", "0.0.20"]) {
      await expect(
        publish("v0.0.13", out, { gh: fake, published: listing(version) }),
      ).rejects.toThrow(`alpha at ${version}`);
    }
    expect(
      (await calls()).filter((call) => call.startsWith("release create")),
    ).toEqual([]);
    await publish("v0.0.13", out, { gh: fake, published: listing("0.0.9") });
    expect(
      (await calls()).some((call) => call.startsWith("release create")),
    ).toBe(true);
  });

  const calls = async (): Promise<string[]> =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean);

  it("creates the release of the tag with every asset, marked latest, never overwriting", async () => {
    const files = await publish("v0.0.13", out, { gh: fake, published: none });
    expect(files).toEqual(releaseFiles());
    const all = await calls();
    expect(all[0]).toBe("release view v0.0.13 --json isDraft");
    const create = all[1] ?? "";
    expect(create).toMatch(/^release create v0\.0\.13 /);
    expect(create).toContain("--draft");
    expect(create).toContain("--verify-tag");
    expect(create).not.toContain("--latest");
    expect(create).not.toContain("--clobber");
    for (const file of files) expect(create).not.toContain(join(out, file));
    const upload = all[2] ?? "";
    expect(upload).toMatch(/^release upload v0\.0\.13 /);
    for (const file of files) expect(upload).toContain(join(out, file));
    expect(all[3]).toBe("release edit v0.0.13 --draft=false --latest");
    expect(all).toHaveLength(4);
  });

  it("deletes the draft when publishing it fails, and leaves nothing published", async () => {
    vi.stubEnv("FAKE_GH_FAIL", "edit");
    await expect(
      publish("v0.0.13", out, { gh: fake, published: none }),
    ).rejects.toThrow("gh release edit v0.0.13 exited");
    expect(await calls()).toEqual([
      "release view v0.0.13 --json isDraft",
      expect.stringMatching(/^release create v0\.0\.13 /),
      expect.stringMatching(/^release upload v0\.0\.13 /),
      "release edit v0.0.13 --draft=false --latest",
      "release view v0.0.13 --json isDraft",
      "release delete v0.0.13 --yes",
    ]);
  });

  it("keeps a release the failed edit published, and says it is published", async () => {
    vi.stubEnv("FAKE_GH_FAIL", "edit-after-publishing");
    await expect(
      publish("v0.0.13", out, { gh: fake, published: none }),
    ).rejects.toThrow(/v0\.0\.13 is published/);
    const all = await calls();
    expect(all.some((call) => call.startsWith("release delete"))).toBe(false);
    expect(all.at(-1)).toBe("release view v0.0.13 --json isDraft");
  });

  it("deletes a draft a stopped run left for the tag, then publishes", async () => {
    fakeGh("draft");
    await publish("v0.0.13", out, { gh: fake, published: none });
    expect(await calls()).toEqual([
      "release view v0.0.13 --json isDraft",
      "release delete v0.0.13 --yes",
      "release view v0.0.13 --json isDraft",
      expect.stringMatching(/^release create v0\.0\.13 /),
      expect.stringMatching(/^release upload v0\.0\.13 /),
      "release edit v0.0.13 --draft=false --latest",
    ]);
  });

  it("lets a draft through without deleting it when it only asks, or in a dry run", async () => {
    fakeGh("draft");
    await expect(assertAbsent("v0.0.13", fake)).resolves.toBeUndefined();
    await publish("v0.0.13", out, { gh: fake, dryRun: true, published: none });
    expect(await calls()).toEqual([
      "release view v0.0.13 --json isDraft",
      "release view v0.0.13 --json isDraft",
    ]);
  });

  it("publishes nothing in a dry run, which still checks everything", async () => {
    const files = await publish("v0.0.13", out, {
      gh: fake,
      dryRun: true,
      published: none,
    });
    expect(files).toContain("plugins.json");
    expect(await calls()).toEqual(["release view v0.0.13 --json isDraft"]);
  });

  it("fails when a release exists for the tag, and creates nothing", async () => {
    fakeGh("published");
    await expect(
      publish("v0.0.13", out, { gh: fake, published: none }),
    ).rejects.toThrow("a release for v0.0.13 exists; it is never overwritten");
    expect(await calls()).toEqual(["release view v0.0.13 --json isDraft"]);
  });

  it("fails when it cannot ask whether the release exists, and creates nothing", async () => {
    fakeGh("error");
    await expect(
      publish("v0.0.13", out, { gh: fake, published: none }),
    ).rejects.toThrow("could not ask whether a release for v0.0.13 exists");
    expect(await calls()).toEqual(["release view v0.0.13 --json isDraft"]);
  });

  it("asks alone whether a release exists", async () => {
    await expect(assertAbsent("v0.0.13", fake)).resolves.toBeUndefined();
    fakeGh("published");
    await expect(assertAbsent("v0.0.13", fake)).rejects.toThrow("exists");
  });

  it("refuses a folder whose files are not the ones the checksums list, creating nothing", async () => {
    await writeFile(join(out, "alpha.plugin.json"), "{}");
    await expect(
      publish("v0.0.13", out, { gh: fake, published: none }),
    ).rejects.toThrow("are not the ones checksums.txt lists");
    expect(await calls()).toEqual([]);
  });

  it("refuses a tag other than the version the plugins were built at, creating nothing", async () => {
    await expect(
      publish("v0.0.14", out, { gh: fake, published: none }),
    ).rejects.toThrow("is version 0.0.13, and the tag is v0.0.14");
    expect(await calls()).toEqual([]);
  });

  it("refuses a folder that holds no index, and a name that is no tag", async () => {
    const bare = await emptyTree();
    made.push(bare);
    await expect(
      publish("v0.0.13", bare, { gh: fake, published: none }),
    ).rejects.toThrow("holds no plugins.json");
    await expect(
      publish("main", out, { gh: fake, published: none }),
    ).rejects.toThrow("is not a tag");
    expect(await calls()).toEqual([]);
  });
});

describe("what release.ts loads before anything is installed", () => {
  // `absent` and `publish` run before `pnpm install`, so every module they
  // load at start comes with Node; the build loads the rest itself.
  it("reaches no package but Node's own through its static imports", () => {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const found of source.matchAll(
        /^import\s+(?!type\b)[^;]*?\sfrom\s+"([^"]+)";/gms,
      )) {
        const specifier = found[1] ?? "";
        if (specifier.startsWith(".")) visit(resolve(file, "..", specifier));
        else if (!specifier.startsWith("node:")) packages.add(specifier);
      }
    };
    visit(join(root, "scripts", "release", "release.ts"));
    expect(seen.size).toBeGreaterThan(3);
    expect([...packages]).toEqual([]);
  });
});

describe("the release workflow", () => {
  interface Job {
    needs?: string | string[];
    if?: string;
    "runs-on": string;
    permissions?: Record<string, string>;
    steps: {
      id?: string;
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
    expect(workflow.jobs["sign"]?.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs["publish"]?.permissions).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });
  });

  it("publishes only for a pushed tag, after the build, so a manual run publishes nothing", () => {
    const job = workflow.jobs["publish"];
    expect(job?.needs).toEqual(["build", "sign"]);
    expect(job?.if).toBe("${{ github.event_name == 'push' }}");
    expect(workflow.jobs["build"]?.if).toBeUndefined();
    expect(workflow.jobs["sign"]?.needs).toBe("build");
    expect(workflow.jobs["sign"]?.if).toBeUndefined();
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

  it("builds on the Node the connector host carries, read from the pin and not written here", () => {
    const steps = workflow.jobs["build"]?.steps ?? [];
    const read = steps.findIndex((step) => step.id === "node");
    const setup = steps.findIndex((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    expect(steps[read]?.run).toContain("host/node.json");
    expect(read).toBeGreaterThan(-1);
    expect(setup).toBeGreaterThan(read);
    expect(steps[setup]?.with?.["node-version"]).toBe(
      "${{ steps.node.outputs.version }}",
    );
  });

  it("checks each darwin node signature before it publishes, and still proves the plugins", () => {
    const prove = workflow.jobs["build"]?.steps.find((step) =>
      step.run?.includes("pnpm proof --group plugins"),
    );
    expect(prove).toBeDefined();
    const check = workflow.jobs["sign"]?.steps.find((step) =>
      step.run?.includes("codesign --verify --strict"),
    );
    expect(check?.run).toContain("HX7739G8FX");
    expect(check?.run).toContain("runtime");
    expect(check?.run).toContain(
      'spctl --assess --type open --context context:primary-signature -v "$node"',
    );
    expect(check?.run).not.toContain("--type execute");
    expect(check?.run).not.toContain("--type install");
    expect(workflow.jobs["sign"]?.["runs-on"]).toBe("macos-latest");
  });

  it("runs on standard GitHub-hosted runners", () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(["ubuntu-latest", "macos-latest"]).toContain(job["runs-on"]);
    }
  });
});
