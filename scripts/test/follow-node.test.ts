/**
 * `scripts/follow-node.sh` decides when the host moves to a newer Node
 * release. `.github/workflows/follow-node.yml` calls it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts", "follow-node.sh");

function decide(over: Record<string, string> = {}): {
  status: number;
  output: string;
} {
  const input: Record<string, string> = {
    current: "26.13.1",
    versions: "v27.0.0 v26.14.0 v26.13.1 v26.13.0 v25.9.0",
    open: "0",
    ...over,
  };
  try {
    const output = execFileSync(
      "bash",
      [
        SCRIPT,
        "decide",
        ...Object.entries(input).map(([key, value]) => `${key}=${value}`),
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
    return { status: 0, output: output.trim() };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { status: failed.status, output: failed.stdout + failed.stderr };
  }
}

describe("scripts/follow-node.sh decide", () => {
  it("proposes the newest release of the same major version", () => {
    expect(decide()).toEqual({ status: 0, output: "bump 26.14.0" });
  });

  it("never proposes another major version, whatever its number", () => {
    const only27 = decide({ versions: "v27.0.0 v27.1.0 v26.13.1" });
    expect(only27.output).toBe(
      "skip: the host carries Node 26.13.1, the newest 26.x release",
    );
    // The witness: with a newer 26.x listed beside them, it is proposed.
    expect(decide({ versions: "v27.0.0 v27.1.0 v26.13.2" }).output).toBe(
      "bump 26.13.2",
    );
  });

  it("never proposes a pre-release", () => {
    const rc = decide({
      versions: "v26.14.0-rc.1 v26.14.0-nightly2026 v26.13.1",
    });
    expect(rc.output).toMatch(/^skip: /);
    expect(decide({ versions: "v26.14.0-rc.1 v26.13.2" }).output).toBe(
      "bump 26.13.2",
    );
  });

  it("compares versions as numbers", () => {
    expect(decide({ versions: "v26.9.0 v26.13.2 v26.100.0" }).output).toBe(
      "bump 26.100.0",
    );
    expect(
      decide({ current: "26.9.0", versions: "v26.10.0 v26.9.0" }).output,
    ).toBe("bump 26.10.0");
  });

  it("proposes nothing when the host is on the newest, or ahead of the list", () => {
    expect(decide({ versions: "v26.13.1 v26.12.1" }).output).toMatch(/^skip: /);
    expect(decide({ versions: "v26.12.1" }).output).toMatch(/^skip: /);
    expect(decide({ versions: "" }).output).toMatch(/^skip: /);
  });

  it("reads versions with or without a leading v, one per line or spaced", () => {
    expect(decide({ versions: "26.13.1\n26.13.2" }).output).toBe(
      "bump 26.13.2",
    );
  });

  it("leaves a pin that an open pull request already moves", () => {
    expect(decide({ open: "1" }).output).toBe(
      "skip: a pull request that moves the Node pin is open",
    );
    expect(decide({ open: "0" }).output).toBe("bump 26.14.0");
  });

  it.each([
    ["a current version that is not exact", { current: "26.13" }],
    ["a pre-release as the current version", { current: "26.13.1-rc.1" }],
    ["a count that is not a number", { open: "many" }],
    ["an argument it does not know", { release: "x" }],
  ])("refuses %s", (_name, over) => {
    const result = decide(over);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/^follow-node\.sh: /);
  });
});

describe(".github/workflows/follow-node.yml", () => {
  const workflow = readFileSync(
    join(ROOT, ".github", "workflows", "follow-node.yml"),
    "utf8",
  );

  it("checks the paths the patch staged, from a copy of the check made before it is applied, and reads no path line by line", () => {
    const copy = workflow.indexOf("cp scripts/only-staged-paths.sh");
    const apply = workflow.indexOf("git apply --index");
    const check = workflow.indexOf('"${check}" host/node.json');
    expect(copy).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(copy);
    expect(check).toBeGreaterThan(apply);
    expect(workflow).not.toContain("tr '\\0' '\\n'");
    expect(workflow).not.toContain("--numstat");
  });
});
