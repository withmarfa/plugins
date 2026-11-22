import { afterEach, beforeEach, expect, it } from "vitest";
import { defineConnector, type ConnectionDefinition } from "../src/define.js";
import { start } from "./installed.js";
import { Harness, testType } from "./harness.js";

let harness: Harness;
const extra = { ...testType, id: "test.extra" };
const connection: ConnectionDefinition = {
  id: "test.in-repository",
  label: "Kept label",
  description: "Kept description",
  cardinality: "many-to-one",
  from_type_constraints: [testType.id],
  to_type_constraints: [testType.id],
};

beforeEach(async () => {
  harness = await Harness.create();
  harness.server.grants = {
    type_permissions: { [testType.id]: "write", [extra.id]: "write" },
    edge_permissions: { [connection.id]: "write" },
  };
});
afterEach(async () => {
  await harness.close();
});

function reader(definition = connection, includeExtra = false) {
  return defineConnector({
    name: "test",
    source: "test",
    description: "A connection evolution reader.",
    types: [testType, extra].map((type) => ({ type, fields: ["title"] })),
    connections: [definition],
    async run(context) {
      await context.upsert(testType.id, [
        { source_id: "target", properties: { title: "Target" } },
        {
          source_id: "source",
          properties: { title: "Source" },
          connections: {
            [connection.id]: [{ type: testType.id, id: "target" }],
          },
        },
      ]);
      if (includeExtra)
        await context.upsert(extra.id, [
          {
            source_id: "extra",
            properties: { title: "New source" },
            connections: {
              [connection.id]: [{ type: testType.id, id: "target" }],
            },
          },
        ]);
    },
  });
}
const widened = () => ({
  ...connection,
  from_type_constraints: [testType.id, extra.id],
});
const run = (definition = connection, includeExtra = false) =>
  start(reader(definition, includeExtra), harness.runtime(["--once"]));

/** The registrations of an edge type, which the kit never sends. */
const registered = (): number =>
  harness.server.requests.filter(
    (request) => request.method !== "GET" && request.path === "/edge-types",
  ).length;

it("writes its edges to the installed connection type and registers nothing", async () => {
  expect(await run(), harness.lines.join("\n")).toBe(0);
  expect(
    harness.server.targetsOf(harness.server.row("source").id, connection.id),
  ).toEqual([harness.server.row("target").id]);
  expect(registered()).toBe(0);
});

it("imports the newly admitted source once the plugin is updated to admit it", async () => {
  expect(await run(), harness.lines.join("\n")).toBe(0);
  const original = structuredClone(harness.server.edges[0]);
  const before = structuredClone(harness.server.row("source"));
  harness.server.edgeTypes.set(connection.id, {
    ...harness.server.edgeTypes.get(connection.id),
    from_type_constraints: [testType.id, extra.id],
  });
  expect(await run(widened(), true), harness.lines.join("\n")).toBe(0);
  expect(harness.server.edges.find((edge) => edge.id === original?.id)).toEqual(
    original,
  );
  expect(harness.server.row("source")).toEqual(before);
  expect(
    harness.server.targetsOf(harness.server.row("extra").id, connection.id),
  ).toEqual([harness.server.row("target").id]);
  expect(registered()).toBe(0);
});

it("stops on a build that admits a source the installed connection type does not, and sends nothing", async () => {
  expect(await run()).toBe(0);
  const held = structuredClone(harness.server.edgeTypes.get(connection.id));
  expect(await run(widened(), true)).toBe(1);
  const error = harness.lastRun().error ?? "";
  expect(error).toContain("the installed plugin's types differ");
  expect(error).toContain("from_type_constraints");
  expect(error).toContain("marfa plugins install test");
  expect(harness.server.edgeTypes.get(connection.id)).toEqual(held);
  expect(registered()).toBe(0);
  expect(harness.server.rows.some((row) => row.type === extra.id)).toBe(false);
});

it("stops on a build that admits a target the installed connection type does not", async () => {
  expect(await run()).toBe(0);
  expect(
    await run({
      ...connection,
      to_type_constraints: [testType.id, extra.id],
    }),
  ).toBe(1);
  expect(harness.lastRun().error).toContain("to_type_constraints");
  expect(registered()).toBe(0);
});

it("keeps the stored presentation text, whatever the build's text says", async () => {
  expect(await run()).toBe(0);
  expect(
    await run({
      ...connection,
      label: "New label",
      description: "New description",
    }),
  ).toBe(0);
  expect(harness.server.edgeTypes.get(connection.id)).toMatchObject({
    label: connection.label,
    description: connection.description,
  });
  expect(registered()).toBe(0);
});

it.each<Partial<ConnectionDefinition>>([
  { cardinality: "many-to-many" },
  { reverse_name: "test.contains" },
  { written_from: "to" },
])("stops on a structural difference: %j", async (change) => {
  expect(await run()).toBe(0);
  const held = structuredClone(harness.server.edgeTypes.get(connection.id));
  expect(await run({ ...connection, ...change })).toBe(1);
  const error = harness.lastRun().error ?? "";
  expect(error).toContain(`the connection type ${connection.id} differs`);
  expect(error).toContain("marfa plugins install test");
  expect(harness.server.edgeTypes.get(connection.id)).toEqual(held);
  expect(registered()).toBe(0);
});

it("stops on a connection type the plugin did not install, before a row is written", async () => {
  harness.server.installs = false;
  harness.server.installType({ ...testType });
  harness.server.installType({ ...extra });
  expect(await run()).toBe(1);
  expect(harness.lastRun().error).toContain(
    `the connection type ${connection.id} is not installed`,
  );
  expect(harness.server.rows).toEqual([]);
  expect(registered()).toBe(0);
});

it("takes an installed end that is unrestricted", async () => {
  expect(await run()).toBe(0);
  const stored = harness.server.edgeTypes.get(connection.id);
  if (stored === undefined) throw new Error("No held definition");
  stored["from_type_constraints"] = [];
  expect(await run(widened(), true)).toBe(0);
  expect(registered()).toBe(0);
});
