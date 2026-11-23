import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CodeRefused, CodeStore } from "../src/code.js";
import { Home } from "../src/home.js";
import { CodeServer, scratch, sha256 } from "./helpers.js";

function store() {
  const home = new Home(scratch());
  const server = new CodeServer();
  return { home, server, code: new CodeStore(home, server.transport) };
}

const text = "export const connector = 1;\n".repeat(20);

describe("the connector host's code store", () => {
  it("keeps code whose SHA-256 matches, readable by the user alone, and reuses it", async () => {
    const { home, server, code } = store();
    const served = server.serve("rss", text);
    const file = await code.ensure("rss", served);
    expect(file).toBe(home.codeFile("rss", served.sha256));
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await code.ensure("rss", served);
    expect(server.asked).toHaveLength(1);
  });

  it("fetches again over a cached file whose bytes changed", async () => {
    const { home, server, code } = store();
    const served = server.serve("rss", text);
    const file = home.codeFile("rss", served.sha256);
    mkdirSync(home.code("rss"), { recursive: true });
    writeFileSync(file, "tampered");
    await code.ensure("rss", served);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(server.asked).toHaveLength(1);
  });

  it("keeps nothing whose SHA-256 differs", async () => {
    const { home, server, code } = store();
    const served = { ...server.serve("rss", text), sha256: sha256("other") };
    await expect(code.ensure("rss", served)).rejects.toThrow(
      /has SHA-256 .* where the plugin names .*, so it was not kept/,
    );
    expect(readdirSync(home.code("rss"))).toEqual([]);
  });

  it("cuts off a body larger than its size and keeps nothing", async () => {
    const { home, server, code } = store();
    const served = server.serve("rss", text);
    const small = { ...served, size: 40 };
    await expect(code.ensure("rss", small)).rejects.toThrow(
      "is larger than the 40 bytes the plugin names",
    );
    // 16-byte chunks: the third passes 40 bytes, and nothing after it is read.
    expect(server.handedOut).toBe(3);
    expect(readdirSync(home.code("rss"))).toEqual([]);
  });

  it("refuses an http address for code", async () => {
    const { home, server, code } = store();
    const served = server.serve("rss", text);
    const plain = { ...served, url: "http://code.example.com/rss" };
    await expect(code.ensure("rss", plain)).rejects.toThrow(CodeRefused);
    await expect(code.ensure("rss", plain)).rejects.toThrow("is not https");
    expect(server.asked).toEqual([]);
    expect(existsSync(home.codeFile("rss", served.sha256))).toBe(false);
  });

  it("refuses a redirect to http, and follows one to https", async () => {
    const { home, server, code } = store();
    const served = server.serve("rss", text);
    server.redirects.set("https://code.example.com/moved", "http://code.example.com/rss");
    await expect(
      code.ensure("rss", { ...served, url: "https://code.example.com/moved" }),
    ).rejects.toThrow("is not https");
    expect(server.asked).toEqual(["https://code.example.com/moved"]);
    server.redirects.set("https://code.example.com/moved", "/rss");
    const file = await code.ensure("rss", {
      ...served,
      url: "https://code.example.com/moved",
    });
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(server.asked.at(-1)).toBe("https://code.example.com/rss");
    expect(readdirSync(home.code("rss"))).toEqual([`${served.sha256}.mjs`]);
  });

  it("refuses an answer that is not the code", async () => {
    const { home, code } = store();
    await expect(
      code.ensure("rss", {
        url: "https://code.example.com/missing",
        sha256: sha256("x"),
        size: 1,
      }),
    ).rejects.toThrow("answered 404 for the code");
    expect(readdirSync(home.code("rss"))).toEqual([]);
  });

  it("deletes every code file but the one it keeps", async () => {
    const { home, server, code } = store();
    const one = server.serve("one", text);
    const two = server.serve("two", `${text}two`);
    await code.ensure("rss", one);
    await code.ensure("rss", two);
    await code.prune("rss", two.sha256);
    expect(readdirSync(home.code("rss"))).toEqual([`${two.sha256}.mjs`]);
    await code.prune("rss", undefined);
    expect(readdirSync(home.code("rss"))).toEqual([]);
  });
});
