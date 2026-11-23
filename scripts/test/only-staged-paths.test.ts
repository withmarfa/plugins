/**
 * `scripts/only-staged-paths.sh` decides whether a patch applied by a
 * workflow touched only the paths that workflow may change. The patch comes
 * from a job that ran code fetched from the network, so what it names, a path
 * that holds a newline among it, must not get past.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "..", "only-staged-paths.sh");
const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function git(folder: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: folder, stdio: "pipe" });
}

/** A repository holding `files`, committed. */
function repository(files: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), "staged-paths-"));
  folders.push(folder);
  git(folder, "init", "-q", ".");
  git(folder, "config", "user.email", "test@example.invalid");
  git(folder, "config", "user.name", "test");
  write(folder, files);
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "start");
  return folder;
}

function write(folder: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
}

function check(
  folder: string,
  allowed: string[],
): { status: number | null; output: string } {
  const result = spawnSync(SCRIPT, allowed, { cwd: folder, encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

const start = { "host/node.json": "{}\n", "README.md": "a\n" };

describe("scripts/only-staged-paths.sh", () => {
  it("lets a change to the one path through", () => {
    const folder = repository(start);
    write(folder, { "host/node.json": '{"a":1}\n' });
    git(folder, "add", "-A");
    expect(check(folder, ["host/node.json"])).toEqual({
      status: 0,
      output: "",
    });
  });

  it("refuses a second file, naming it", () => {
    const folder = repository(start);
    write(folder, { "host/node.json": '{"a":1}\n', "README.md": "b\n" });
    git(folder, "add", "-A");
    const { status, output } = check(folder, ["host/node.json"]);
    expect(status).toBe(1);
    expect(output).toContain("README.md");
  });

  it("refuses a path that holds a newline and then names another, which a line-by-line check reads as two paths", () => {
    const folder = repository(start);
    const hidden = "host/node.json\n.github/workflows/pwn.yml";
    write(folder, { "host/node.json": '{"a":1}\n', [hidden]: "x\n" });
    git(folder, "add", "-A");
    const { status, output } = check(folder, ["host/node.json"]);
    expect(status).toBe(1);
    // The path is named on one line, its newline written out.
    expect(output).toContain("pwn.yml");
    expect(
      output.split("\n").filter((line) => line.startsWith(".github")),
    ).toEqual([]);
  });

  it("refuses a path that holds a newline even when it is the only one, and when the allowed path is its first line", () => {
    const folder = repository(start);
    write(folder, { "host/node.json\nx": "x\n" });
    git(folder, "add", "-A");
    expect(check(folder, ["host/node.json"]).status).toBe(1);
  });

  it("refuses a rename onto the path, whose old path is a second one, and a rename away from it", () => {
    const onto = repository(start);
    git(onto, "rm", "-q", "-f", "host/node.json");
    mkdirSync(join(onto, "host"));
    git(onto, "mv", "README.md", "host/node.json");
    expect(check(onto, ["host/node.json"]).status).toBe(1);

    const away = repository(start);
    git(away, "mv", "host/node.json", ".github-pwn.yml");
    const { status, output } = check(away, ["host/node.json"]);
    expect(status).toBe(1);
    expect(output).toContain(".github-pwn.yml");
  });

  it("refuses nothing staged, since a patch that changes nothing is a fault of the job that made it", () => {
    const folder = repository(start);
    expect(check(folder, ["host/node.json"]).status).toBe(1);
  });

  it("takes several allowed paths, each compared as it is", () => {
    const folder = repository({ "a.json": "1", "b.json": "1", "c.json": "1" });
    write(folder, { "a.json": "2", "b.json": "2" });
    git(folder, "add", "-A");
    expect(check(folder, ["a.json", "b.json", "c.json"]).status).toBe(0);
    expect(check(folder, ["a.json"]).status).toBe(1);
    expect(check(folder, ["a.json", "b.json "]).status).toBe(1);
    expect(check(folder, []).status).toBe(2);
  });
});
