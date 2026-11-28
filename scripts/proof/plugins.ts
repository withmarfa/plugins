import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "./check.js";
import type { ProofServer } from "./server.js";
import {
  bundle,
  install,
  InstallRefused,
  proveAgainstPublished,
  readPublished,
  releaseAddress,
  type Target,
} from "../release/only-adds.ts";
import { findPlugins, root, runMarfa } from "../release/plugins.ts";
import { build } from "../release/release.ts";

type Fields = Record<string, { type: "string" }>;

/** Writes a plugin's source folder, `types/<name>/` of `base`, with one type. */
async function writeSource(
  base: string,
  name: string,
  type: { id: string; fields: Fields; guidance?: string },
): Promise<string> {
  const folder = join(base, "types", name);
  await mkdir(join(folder, "types"), { recursive: true });
  await writeFile(
    join(folder, "plugin.json"),
    JSON.stringify({
      name,
      title: name,
      description: "A plugin the proof makes up.",
      mark: "lucide:box",
      maker: "Marfa",
      marfa: "0.0.1",
    }),
  );
  await writeFile(
    join(folder, "types", `${type.id}.json`),
    JSON.stringify({
      id: type.id,
      parent: "core.task",
      description: "A type the proof makes up.",
      fields: type.fields,
    }),
  );
  if (type.guidance !== undefined) {
    await writeFile(join(folder, "types", `${type.id}.md`), type.guidance);
  }
  return folder;
}

/** Serves the files of `dir` over HTTP, as a release's download address does. */
async function serve(dir: string): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    const asked = (request.url ?? "").replace(/^\/+/, "");
    readdir(dir)
      .then((names) => {
        const name = names.find((held) => held === asked);
        if (name === undefined) throw new Error(`${asked} is not served`);
        return readFile(join(dir, name));
      })
      .then(
        (bytes) => {
          response.writeHead(200).end(bytes);
        },
        () => {
          response.writeHead(404).end();
        },
      );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    server,
  };
}

function stop(server: Server): Promise<void> {
  return new Promise((done) => {
    server.close(() => {
      done();
    });
    server.closeAllConnections();
  });
}

export async function provePlugins(
  url: string,
  mintKey: ProofServer["mintKey"],
): Promise<void> {
  const minted = await mintKey({
    label: "plugins proof",
    source: "plugins-proof",
    permissions: ["schema.write", "connectors.manage"],
    type_permissions: { "*": "write" },
    extension_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
    metadata_permissions: { "*": "write" },
    profile_permissions: { "*": "read" },
  });
  const target: Target = { url, key: minted.key };
  const work = await mkdtemp(join(tmpdir(), "plugins-proof-plugins-"));
  const served: Server[] = [];
  try {
    await check(
      "plugins: a plugin installs from a bundle file, and the type it installed answers the guidance written beside its definition",
      async () => {
        const source = await writeSource(join(work, "file"), "proof-file", {
          id: "common.proofwidgeta",
          fields: { colour: { type: "string" } },
          guidance: "File one widget per request.\n",
        });
        const file = await bundle(source, "0.0.1", join(work, "file", "out"));
        const done = await install("proof-file", file, target);
        const ran = await runMarfa(
          ["--json", "types", "get", "common.proofwidgeta"],
          { env: { MARFA_API_URL: url, MARFA_API_KEY: minted.key } },
        );
        const guidance = (JSON.parse(ran.stdout) as { guidance?: string })
          .guidance;
        if (
          done.outcome !== "installed" ||
          guidance !== "File one widget per request."
        ) {
          throw new Error(
            `outcome ${done.outcome}, guidance ${JSON.stringify(guidance)}`,
          );
        }
        return `installed ${done.version}, guidance ${JSON.stringify(guidance)}`;
      },
    );

    await check(
      "plugins: a plugin installs by name from a release folder served over HTTP, as the bundle its index lists, whose SHA-256 the server keeps as its fingerprint",
      async () => {
        const base = join(work, "name");
        await writeSource(base, "proof-name", {
          id: "common.proofwidgetb",
          fields: { colour: { type: "string" } },
        });
        // The release's own build: the bundle, the index and the checksums.
        const out = join(work, "name", "out");
        await build("0.0.1", out, base);
        const release_ = await serve(out);
        served.push(release_.server);
        // A folder of this name in the working folder would be taken for a
        // path, so the install runs where there is none.
        const done = await install("proof-name", "proof-name", target, {
          address: release_.url,
          cwd: join(work, "name"),
        });
        const index = (await readPublished(release_.url))?.plugins[0];
        const ran = await runMarfa(["--json", "plugins", "get", "proof-name"], {
          env: { MARFA_API_URL: url, MARFA_API_KEY: minted.key },
        });
        const fingerprint = (JSON.parse(ran.stdout) as { fingerprint?: string })
          .fingerprint;
        if (
          done.outcome !== "installed" ||
          index === undefined ||
          fingerprint !== index.sha256
        ) {
          throw new Error(
            `outcome ${done.outcome}, fingerprint ${String(fingerprint)}, index ${index?.sha256 ?? "empty"}`,
          );
        }
        return `installed ${done.version} from ${release_.url}, fingerprint ${fingerprint}`;
      },
    );

    await check(
      "plugins: against a release that lists it, a plugin installs as published and then as the source at the next version, one that is not listed installs alone, and a source that drops a field is refused plugin_narrows naming the plugin and the field",
      async () => {
        const base = join(work, "published");
        await writeSource(base, "proof-keeps", {
          id: "common.proofwidgetc",
          fields: { colour: { type: "string" } },
        });
        await writeSource(base, "proof-narrows", {
          id: "common.proofwidgetd",
          fields: { colour: { type: "string" }, size: { type: "string" } },
        });
        const out = join(work, "published", "release");
        await build("0.0.4", out, base);
        const release_ = await serve(out);
        served.push(release_.server);
        const published = await readPublished(release_.url);
        const prove = (name: string) =>
          proveAgainstPublished(
            { folder: `types/${name}`, name },
            published,
            release_.url,
            target,
            join(work, "published", "work"),
            {},
            base,
          );
        const said: string[] = [await prove("proof-keeps")];

        await writeSource(base, "proof-alone", {
          id: "common.proofwidgete",
          fields: { colour: { type: "string" } },
        });
        said.push(await prove("proof-alone"));

        await writeSource(base, "proof-narrows", {
          id: "common.proofwidgetd",
          fields: { colour: { type: "string" } },
        });
        try {
          await prove("proof-narrows");
        } catch (error) {
          const changes = JSON.stringify(
            error instanceof InstallRefused ? error.changes : undefined,
          );
          if (
            !(error instanceof InstallRefused) ||
            error.code !== "plugin_narrows" ||
            error.plugin !== "proof-narrows" ||
            !error.message.includes("proof-narrows") ||
            !changes.includes("common.proofwidgetd") ||
            !changes.includes("fields.size")
          ) {
            throw error;
          }
          return `${said.join("; ")}; refused: ${changes}`;
        }
        throw new Error("the source that drops a field was installed");
      },
    );

    await check(
      "plugins: every plugin of this repository installs as the latest published release has it, then as the source at the next version, or alone when no release lists it",
      async () => {
        // The folders are read from where the proof runs, built or not, so a
        // root found wrongly would read as no plugins.
        if (!existsSync(join(root, "types", "README.md"))) {
          throw new Error(
            `${root} is not this repository: it has no types/README.md`,
          );
        }
        const { plugins, problems } = findPlugins();
        if (problems.length > 0) throw new Error(problems.join("; "));
        const address = releaseAddress();
        const published = await readPublished(address);
        const said: string[] = [];
        for (const plugin of plugins) {
          said.push(
            await proveAgainstPublished(
              plugin,
              published,
              address,
              target,
              join(work, "repository"),
            ),
          );
        }
        const where =
          published === undefined
            ? `${address} has no release`
            : `${address} lists ${published.plugins.map((entry) => `${entry.name} ${entry.version}`).join(", ") || "nothing"}`;
        return `${String(plugins.length)} plugins; ${where}${said.map((line) => `; ${line}`).join("")}`;
      },
    );

    await check(
      "plugins: the Readwise highlight type, installed over the published release, takes core.highlight's display hints: its passage as the body, no title field and no name from the body",
      async () => {
        const ran = await runMarfa(
          ["--json", "types", "get", "readwise.highlight"],
          { env: { MARFA_API_URL: url, MARFA_API_KEY: minted.key } },
        );
        const hints = (
          JSON.parse(ran.stdout) as {
            display_hints?: {
              body_field?: string;
              name_from_body?: boolean;
              title_field?: string;
            };
          }
        ).display_hints;
        if (
          hints?.body_field !== "text" ||
          hints.name_from_body !== false ||
          hints.title_field !== undefined
        ) {
          throw new Error(`display hints ${JSON.stringify(hints)}`);
        }
        return `body_field ${hints.body_field}, name_from_body ${String(hints.name_from_body)}, no title_field`;
      },
    );
  } finally {
    await Promise.all(served.map(stop));
    await rm(work, { recursive: true, force: true });
  }
}
