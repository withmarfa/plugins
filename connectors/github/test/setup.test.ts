import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
import { apiVersion } from "../src/github.js";
import { hookUrl, readOnly } from "../src/setup.js";

const built = resolve(import.meta.dirname, "../dist/main.js");

let marfa: ScriptedServer;
let github: GitHubStub;

beforeEach(async () => {
  marfa = await new ScriptedServer("github", {
    types: [
      "github.repository",
      "github.issue",
      "github.comment",
      "github.file",
      "github.file.image",
      "github.pull_request",
      "github.discussion",
      "github.notification",
      "github.repository_file",
      "github.directory",
    ],
    edges: [
      "github.in-repository",
      "github.sub-issue-of",
      "github.blocked-by",
      "github.relates-to",
      "github.duplicate-of",
      "attached-to",
      "github.closes",
      "github.closed-by",
      "parent-of",
      "about",
      "references",
      "comments-on",
      "in-thread",
      "in-collection",
    ],
  }).start();
  github = await new GitHubStub().start();
  github.appId = 424242;
  github.appPem = appKey();
});

afterEach(async () => {
  await marfa.stop();
  await github.stop();
});

/** Runs setup, answering what it logged and the commands it printed on
 *  standard output. */
function setup(
  env: Record<string, unknown>,
  seen: (line: string) => void,
): Promise<{ code: number | null; output: string; printed: string }> {
  const child = spawn("node", [built, "--setup"], {
    env: marfa.processEnv({
      PATH: process.env["PATH"],
      MARFA_API_URL: marfa.url,
      MARFA_API_KEY: marfa.key,
      ...github.settings,
      ...env,
    }),
  });
  let output = "";
  let printed = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    printed += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
    for (const line of chunk.split("\n")) if (line !== "") seen(line);
  });
  return new Promise((done) => {
    child.on("close", (code) => {
      done({ code, output, printed });
    });
  });
}

function decoded(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("the webhook's address", () => {
  it("keeps the public address's own path before the endpoint's", () => {
    expect(hookUrl("https://marfa.example", "/inbound/in_1")).toBe(
      "https://marfa.example/inbound/in_1",
    );
    expect(hookUrl("https://marfa.example/a/b/", "/inbound/in_1")).toBe(
      "https://marfa.example/a/b/inbound/in_1",
    );
  });
});

describe("read-only kinds", () => {
  it("accepts individual kinds while preserving the other kind's writes", () => {
    expect(readOnly("issue", "issue")).toBe(true);
    expect(readOnly("issue", "comment")).toBe(false);
    expect(readOnly("pull_request")).toBe(false);
    expect(readOnly("pull_request", "pull_request")).toBe(true);
    expect(readOnly("pull_request", "issue")).toBe(false);
    expect(readOnly(" issue, comment, discussion ")).toBe(true);
    expect(readOnly("issue, comment")).toBe(false);
    expect(readOnly("discussion", "discussion")).toBe(true);
    expect(readOnly("discussion", "comment")).toBe(false);
    expect(readOnly("true", "comment")).toBe(true);
    expect(readOnly("false", "issue")).toBe(false);
    expect(readOnly(undefined, "issue")).toBe(false);
  });

  it("rejects unknown kinds and empty list members", () => {
    expect(() => readOnly("isssue")).toThrow("github_read_only");
    expect(() => readOnly("issue,,comment")).toThrow("github_read_only");
    expect(() => readOnly("discussions")).toThrow("unknown kind (discussions)");
    expect(readOnly("discussions", "issue")).toBe(false);
  });
});

describe("setup", () => {
  it("registers the App from a manifest, with its webhook at the instance's public address, and prints the commands that set its settings in Marfa", async () => {
    let visited: Promise<void> | undefined;
    const seenPage: {
      action?: string;
      manifest?: Record<string, unknown>;
      onward?: string | undefined;
    } = {};
    const finished = await setup(
      { github_public_url: "https://marfa.example/behind/a/prefix/" },
      (line) => {
        const opened = / open (\S+) in a browser/.exec(line)?.[1];
        if (opened === undefined) return;
        visited = (async () => {
          const html = await (await fetch(opened)).text();
          seenPage.action = decoded(/action="([^"]+)"/.exec(html)?.[1] ?? "");
          seenPage.manifest = JSON.parse(
            decoded(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? ""),
          ) as Record<string, unknown>;
          const state = new URL(seenPage.action).searchParams.get("state");
          const back = await fetch(
            `${String(seenPage.manifest["redirect_url"])}?code=manifest-code&state=${String(state)}`,
            { redirect: "manual" },
          );
          seenPage.onward = back.headers.get("location") ?? undefined;
        })();
      },
    );
    await visited;
    expect(finished.code).toBe(0);
    expect(seenPage.action).toMatch(
      new RegExp(`^${github.url}/settings/apps/new\\?state=[0-9a-f-]{36}$`),
    );
    expect(seenPage.manifest).toMatchObject({
      name: "Marfa",
      url: "https://github.com/withmarfa/plugins",
      hook_attributes: { active: true },
      public: false,
      default_permissions: {
        issues: "write",
        discussions: "write",
        pull_requests: "read",
        checks: "read",
        statuses: "read",
        contents: "read",
        metadata: "read",
      },
      default_events: [
        "issues",
        "issue_comment",
        "discussion",
        "discussion_comment",
        "sub_issues",
        "issue_dependencies",
        "issue_relates_to",
        "repository",
        "pull_request",
        "check_run",
        "check_suite",
        "status",
      ],
    });
    const hook = (seenPage.manifest?.["hook_attributes"] as { url: string })
      .url;
    expect(hook).toMatch(
      /^https:\/\/marfa\.example\/behind\/a\/prefix\/inbound\/in_/,
    );
    expect(finished.printed).toBe(
      [
        "marfa plugins settings github --set github_app_id=424242",
        `printf '%s' '${github.appPem}' | marfa plugins secret github github_private_key`,
        "printf '%s' stub-webhook-secret-from-github | marfa plugins secret github github_webhook_secret",
        "",
      ].join("\n"),
    );
    expect(finished.output).toContain(
      "install it on the repositories to sync at https://github.com/apps/marfa-sync-test/installations/new",
    );
    expect(seenPage.onward).toBe(
      "https://github.com/apps/marfa-sync-test/installations/new",
    );
    expect(finished.output).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(finished.output).not.toContain("stub-webhook-secret-from-github");
    expect(
      github.asked
        .filter((one) => one.path.startsWith("/app-manifests/"))
        .map((one) => one.version),
    ).toEqual([apiVersion]);
  });

  it("asks only to read where the connector runs read only, and leaves the webhook off without a public address", async () => {
    let manifest: Record<string, unknown> | undefined;
    let visited: Promise<void> | undefined;
    const finished = await setup({ github_read_only: "true" }, (line) => {
      const opened = / open (\S+) in a browser/.exec(line)?.[1];
      if (opened === undefined) return;
      visited = (async () => {
        const html = await (await fetch(opened)).text();
        manifest = JSON.parse(
          decoded(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? ""),
        ) as Record<string, unknown>;
        const action = decoded(/action="([^"]+)"/.exec(html)?.[1] ?? "");
        const state = new URL(action).searchParams.get("state");
        await fetch(
          `${String(manifest["redirect_url"])}?code=manifest-code&state=${String(state)}`,
        );
      })();
    });
    await visited;
    expect(finished.code).toBe(0);
    expect(manifest).toMatchObject({
      hook_attributes: { active: false },
      default_permissions: {
        issues: "read",
        pull_requests: "read",
        checks: "read",
        statuses: "read",
        contents: "read",
        metadata: "read",
      },
    });
    expect(finished.output).toContain("its webhook is off");
  });

  it("uses no code GitHub sent back with another state, and prints nothing", async () => {
    let visited: Promise<void> | undefined;
    const finished = await setup({}, (line) => {
      const opened = / open (\S+) in a browser/.exec(line)?.[1];
      if (opened === undefined) return;
      visited = (async () => {
        const html = await (await fetch(opened)).text();
        const manifest = JSON.parse(
          decoded(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? ""),
        ) as Record<string, unknown>;
        await fetch(
          `${String(manifest["redirect_url"])}?code=manifest-code&state=forged`,
        );
      })();
    });
    await visited;
    expect(finished.code).toBe(1);
    expect(finished.output).toContain("carried another state");
    expect(finished.printed).toBe("");
    expect(github.manifestCode).toBe("manifest-code");
  });

  it("points an App already in its settings at this instance, with a new secret", async () => {
    const finished = await setup(
      {
        github_app_id: "424242",
        github_private_key: github.appPem,
        github_public_url: "https://marfa.example",
      },
      () => undefined,
    );
    expect(finished.code).toBe(0);
    const secret =
      /^printf '%s' (\S+) \| marfa plugins secret github github_webhook_secret\n$/.exec(
        finished.printed,
      )?.[1];
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(String(github.hook?.["url"])).toMatch(
      /^https:\/\/marfa\.example\/inbound\/in_/,
    );
    expect(github.hook?.["content_type"]).toBe("json");
    expect(github.hook?.["secret"]).toBe(secret);
    expect(finished.output).not.toContain(secret);
  });

  it("with a personal token set, requires no setup and exits cleanly", async () => {
    const finished = await setup(
      { github_personal_token: "github_pat_test_12345678" },
      () => undefined,
    );
    expect(finished.code).toBe(0);
    expect(finished.output).toContain("personal access token");
    expect(finished.printed).toBe("");
    expect(marfa.endpoints).toHaveLength(1);
    expect(github.asked).toEqual([]);
  });

  it("keeps write permission for comments when only issues are read only", async () => {
    let manifest: Record<string, unknown> | undefined;
    let visited: Promise<void> | undefined;
    const finished = await setup({ github_read_only: "issue" }, (line) => {
      const opened = / open (\S+) in a browser/.exec(line)?.[1];
      if (opened === undefined) return;
      visited = (async () => {
        const html = await (await fetch(opened)).text();
        manifest = JSON.parse(
          decoded(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? ""),
        ) as Record<string, unknown>;
        const action = decoded(/action="([^"]+)"/.exec(html)?.[1] ?? "");
        const state = new URL(action).searchParams.get("state");
        await fetch(
          `${String(manifest["redirect_url"])}?code=manifest-code&state=${String(state)}`,
        );
      })();
    });
    await visited;
    expect(finished.code).toBe(0);
    // issue is read-only but comment is still carried, so issues:write is needed.
    expect(manifest).toMatchObject({
      default_permissions: { issues: "write", metadata: "read" },
    });
  });

  it("asks only to read for github_read_only listing both issue and comment", async () => {
    let manifest: Record<string, unknown> | undefined;
    let visited: Promise<void> | undefined;
    const finished = await setup(
      { github_read_only: "issue,comment" },
      (line) => {
        const opened = / open (\S+) in a browser/.exec(line)?.[1];
        if (opened === undefined) return;
        visited = (async () => {
          const html = await (await fetch(opened)).text();
          manifest = JSON.parse(
            decoded(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? ""),
          ) as Record<string, unknown>;
          const action = decoded(/action="([^"]+)"/.exec(html)?.[1] ?? "");
          const state = new URL(action).searchParams.get("state");
          await fetch(
            `${String(manifest["redirect_url"])}?code=manifest-code&state=${String(state)}`,
          );
        })();
      },
    );
    await visited;
    expect(finished.code).toBe(0);
    expect(manifest).toMatchObject({
      default_permissions: {
        issues: "read",
        discussions: "write",
        metadata: "read",
      },
    });
  });

  async function manifestFor(
    readOnlyValue: string,
  ): Promise<Record<string, unknown> | undefined> {
    let manifest: Record<string, unknown> | undefined;
    let visited: Promise<void> | undefined;
    const finished = await setup(
      { github_read_only: readOnlyValue },
      (line) => {
        const opened = / open (\S+) in a browser/.exec(line)?.[1];
        if (opened === undefined) return;
        visited = (async () => {
          const html = await (await fetch(opened)).text();
          manifest = JSON.parse(
            decoded(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? ""),
          ) as Record<string, unknown>;
          const action = decoded(/action="([^"]+)"/.exec(html)?.[1] ?? "");
          const state = new URL(action).searchParams.get("state");
          await fetch(
            `${String(manifest["redirect_url"])}?code=manifest-code&state=${String(state)}`,
          );
        })();
      },
    );
    await visited;
    expect(finished.code).toBe(0);
    return manifest;
  }

  it("asks to read Discussions only where discussion and comment are both read only", async () => {
    expect(await manifestFor("discussion,comment")).toMatchObject({
      default_permissions: {
        issues: "write",
        discussions: "read",
        metadata: "read",
      },
    });
  });

  it("still asks to write Discussions where only discussion is read only, since comments are carried", async () => {
    expect(await manifestFor("discussion")).toMatchObject({
      default_permissions: {
        issues: "write",
        discussions: "write",
        metadata: "read",
      },
    });
  });
});
