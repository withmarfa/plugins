import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Home, homeFolder } from "../src/home.js";
import { CappedLog } from "../src/log.js";
import { scratch } from "./helpers.js";

describe("where the connector host keeps its files", () => {
  it("uses Application Support on macOS, the XDG data folder on Linux, and the folder the environment names", () => {
    expect(homeFolder({}, "darwin", "/Users/someone")).toBe(
      "/Users/someone/Library/Application Support/Marfa/Connector Host",
    );
    expect(homeFolder({}, "linux", "/home/someone")).toBe(
      "/home/someone/.local/share/marfa/connector-host",
    );
    expect(
      homeFolder({ XDG_DATA_HOME: "/data" }, "linux", "/home/someone"),
    ).toBe("/data/marfa/connector-host");
    expect(
      homeFolder({ XDG_DATA_HOME: "relative" }, "linux", "/home/someone"),
    ).toBe("/home/someone/.local/share/marfa/connector-host");
    expect(
      homeFolder(
        { MARFA_CONNECTOR_HOST_HOME: "/tmp/host" },
        "darwin",
        "/Users/someone",
      ),
    ).toBe("/tmp/host");
  });

  it("refuses a plugin name or digest that could leave the folder", () => {
    const home = new Home("/host");
    expect(home.key("rss")).toBe("/host/connectors/rss/key");
    expect(() => home.key("../rss")).toThrow("cannot name a folder");
    expect(() => home.codeFile("rss", "../../key")).toThrow("is not a SHA-256");
    expect(() => home.pluginLog("RSS")).toThrow("cannot name a file");
  });

  it("caps a log, keeping one older file", () => {
    const path = join(scratch(), "logs", "rss.log");
    const log = new CappedLog(path, 10);
    log.append("12345678\n");
    log.append("abcdefgh\n");
    log.append("ABCDEFGH\n");
    expect(readFileSync(path, "utf8")).toBe("ABCDEFGH\n");
    expect(readFileSync(`${path}.1`, "utf8")).toBe("abcdefgh\n");
    expect(existsSync(`${path}.2`)).toBe(false);
  });
});
