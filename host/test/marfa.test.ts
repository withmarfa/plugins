import { describe, expect, it } from "vitest";
import { hostApi, redeem, RedeemRefused } from "../src/marfa.js";
import { assigned, marfaAnswer } from "./helpers.js";

/** A fetch that records each request and answers from `answers` in turn. */
function recorder(...answers: Response[]) {
  const sent: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  const send: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    sent.push({
      method: request.method,
      url: request.url,
      auth: request.headers.get("authorization"),
      body: text === "" ? undefined : JSON.parse(text),
    });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("no answer scripted");
    return answer;
  };
  return { send, sent };
}

describe("the connector host's calls to Marfa", () => {
  it("redeems a link's code with no credential, keeping the host's identity and key", async () => {
    const { send, sent } = recorder(
      marfaAnswer(201, {
        host: { id: "host-1", name: "Studio Mac" },
        key: "marfa_k1_host",
        key_id: "key-1",
      }),
    );
    await expect(redeem("https://marfa.example.com", "the-code", send)).resolves.toEqual({
      host: { id: "host-1", name: "Studio Mac" },
      key: "marfa_k1_host",
    });
    expect(sent).toEqual([
      {
        method: "POST",
        url: "https://marfa.example.com/connector-hosts/redeem",
        auth: null,
        body: { code: "the-code" },
      },
    ]);
  });

  it.each([
    [404, "it was used already, it is more than 15 minutes old, or a newer link replaced it"],
    [429, "too many tries from this address"],
    [400, "did not take the link's code"],
    [500, "answered 500 internal to the link"],
  ])("explains a refused redeem answered %i", async (status, said) => {
    const { send } = recorder(
      marfaAnswer(status, { code: status === 500 ? "internal" : "x" }),
    );
    const refused = await redeem("https://marfa.example.com", "code", send).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(RedeemRefused);
    expect((refused as Error).message).toContain(said);
  });

  it("explains a redeem that reached no server", async () => {
    const send: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    await expect(redeem("https://marfa.example.com", "code", send)).rejects.toThrow(
      "Could not reach Marfa at https://marfa.example.com: fetch failed",
    );
  });

  it("asks for its connectors with its own key, and reads 401 as unlinked", async () => {
    const self = {
      id: "host-1",
      name: "Studio Mac",
      connectors: [assigned("rss", "0.0.1", undefined)],
    };
    const { send, sent } = recorder(
      marfaAnswer(200, self),
      marfaAnswer(401, { code: "unauthorized" }),
      marfaAnswer(503, { code: "unavailable" }),
    );
    const api = hostApi("https://marfa.example.com", "marfa_k1_host", send);
    await expect(api.self()).resolves.toEqual({ kind: "ok", self });
    await expect(api.self()).resolves.toEqual({ kind: "unlinked" });
    await expect(api.self()).resolves.toEqual({ kind: "failed", reason: "503 unavailable" });
    expect(sent.map((one) => [one.method, one.url, one.auth])).toEqual(
      Array.from({ length: 3 }, () => [
        "GET",
        "https://marfa.example.com/connector-hosts/self",
        "Bearer marfa_k1_host",
      ]),
    );
  });

  it("mints a connector's key through its own door, and reads 404 as unassigned", async () => {
    const { send, sent } = recorder(
      marfaAnswer(201, {
        plugin: "rss",
        key: "marfa_k1_rss",
        key_id: "key-2",
        source: "rss",
      }),
      marfaAnswer(404, { code: "plugin_not_found" }),
    );
    const api = hostApi("https://marfa.example.com", "marfa_k1_host", send);
    await expect(api.mint("rss")).resolves.toEqual({ kind: "ok", key: "marfa_k1_rss" });
    await expect(api.mint("rss")).resolves.toEqual({ kind: "unassigned" });
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "https://marfa.example.com/connector-hosts/self/connectors/rss/key",
      auth: "Bearer marfa_k1_host",
    });
  });

  it("registers with the connector's own key, as the kit does, and reports one failed run", async () => {
    const { send, sent } = recorder(
      marfaAnswer(201, { id: "reg-1", name: "rss" }),
      marfaAnswer(201, { id: "run-1" }),
    );
    const api = hostApi("https://marfa.example.com", "marfa_k1_host", send);
    await api.reportStartFailure({
      plugin: "rss",
      key: "marfa_k1_rss",
      readOnlyTypes: ["rss.entry"],
      at: new Date("2026-11-23T09:00:00Z"),
      error: "The connector's process exited 1 (it failed) before it registered",
    });
    expect(sent).toEqual([
      {
        method: "POST",
        url: "https://marfa.example.com/connectors",
        auth: "Bearer marfa_k1_rss",
        body: { name: "rss", read_only_types: ["rss.entry"] },
      },
      {
        method: "POST",
        url: "https://marfa.example.com/connectors/reg-1/runs",
        auth: "Bearer marfa_k1_rss",
        body: {
          outcome: "failed",
          started_at: "2026-11-23T09:00:00.000Z",
          finished_at: "2026-11-23T09:00:00.000Z",
          error: "The connector's process exited 1 (it failed) before it registered",
        },
      },
    ]);
  });
});
