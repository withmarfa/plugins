import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { ScriptedServer } from "../../kit/test/scripted-server.js";
import { plan } from "../connector-plugins.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

async function copiedConnector(place: string): Promise<string> {
  await copyFile(
    join(root, "tsconfig.base.json"),
    join(place, "tsconfig.base.json"),
  );
  await symlink(join(root, "kit"), join(place, "kit"));
  await symlink(join(root, "node_modules"), join(place, "node_modules"));
  const copied = join(place, "connectors", "copied");
  await cp(join(root, "template", "connector"), copied, {
    recursive: true,
    filter: (source) => !/[/\\](dist|node_modules)$/.test(source),
  });
  await mkdir(join(copied, "node_modules", "@withmarfa"), { recursive: true });
  await symlink(
    join(root, "kit"),
    join(copied, "node_modules", "@withmarfa", "connector"),
  );
  await run(join(root, "node_modules", ".bin", "tsc"), [
    "-p",
    join(copied, "tsconfig.json"),
  ]);
  return copied;
}

it("builds and runs once copied to a connector's place", async () => {
  const place = await mkdtemp(join(tmpdir(), "template-copy-"));
  const marfa = await new ScriptedServer("example", {
    types: ["example.item"],
  }).start();
  const vendor = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        account: "acct",
        items: [{ id: "1", title: "One", created: "2026-09-01T10:00:00Z" }],
      }),
    );
  });
  await new Promise<void>((done) => vendor.listen(0, "127.0.0.1", done));
  try {
    const copied = await copiedConnector(place);
    // The plugin folder the copy generates is what an owner installs, and the
    // connector registers no type of its own.
    const made = await plan(place);
    for (const [path, text] of made.write) {
      if (/\/plugin\/types\/[^/]+\.json$/.test(path)) {
        marfa.installType(JSON.parse(text) as Record<string, unknown>);
      }
    }
    await run("node", [join(copied, "dist", "main.js"), "--once"], {
      env: marfa.processEnv({
        PATH: process.env["PATH"],
        MARFA_API_URL: marfa.url,
        MARFA_API_KEY: marfa.key,
        example_url: `http://127.0.0.1:${String((vendor.address() as AddressInfo).port)}/`,
        example_token: "example-vendor-token",
      }),
    });
    expect(marfa.requestsTo("POST", "/types")).toEqual([]);
    // Copying the template into connectors/ is all it takes to have a plugin
    // folder generated, with the guidance the template brings.
    expect(made.missing).toEqual([]);
    expect([...made.write.keys()]).toEqual([
      "connectors/copied/plugin/plugin.json",
      "connectors/copied/plugin/types/example.item.json",
    ]);
    expect(
      JSON.parse(
        made.write.get("connectors/copied/plugin/plugin.json") ?? "null",
      ),
    ).toMatchObject({
      name: "example",
      connector: {
        kinds: [{ name: "item", type: "example.item", direction: "both" }],
      },
    });
    expect(marfa.rows.map((row) => [row.source_id, row.properties])).toEqual([
      ["acct:1", { example_id: "1", title: "One" }],
    ]);
  } finally {
    vendor.closeAllConnections();
    await new Promise((done) => vendor.close(done));
    await marfa.stop();
    await rm(place, { recursive: true, force: true });
  }
}, 60_000);
