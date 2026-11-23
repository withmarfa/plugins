import { describe, expect, it } from "vitest";
import { LinkRefused, parseLink } from "../src/link.js";

describe("a connector host link", () => {
  it("names the instance and the code after the #", () => {
    expect(parseLink(" https://marfa.example.com/connect#abc-123 ")).toEqual({
      origin: "https://marfa.example.com",
      code: "abc-123",
    });
    expect(parseLink("http://127.0.0.1:8080/connect#code")).toEqual({
      origin: "http://127.0.0.1:8080",
      code: "code",
    });
    expect(parseLink("http://localhost:3000/connect#code").origin).toBe(
      "http://localhost:3000",
    );
    expect(parseLink("http://[::1]:3000/connect#code").origin).toBe(
      "http://[::1]:3000",
    );
  });

  it.each([
    ["not a link", "not a connector host link"],
    ["https://marfa.example.com/connect", "with the code after the #"],
    ["https://marfa.example.com/connect#", "with the code after the #"],
    ["https://marfa.example.com/other#code", "with the code after the #"],
    ["https://marfa.example.com/connect?x=1#code", "with the code after the #"],
    [
      "https://user:pass@marfa.example.com/connect#code",
      "with the code after the #",
    ],
    ["ftp://marfa.example.com/connect#code", "with the code after the #"],
    ["http://marfa.example.com/connect#code", "which is not https"],
    ["http://192.168.1.4/connect#code", "which is not https"],
  ])("refuses %s", (link, said) => {
    expect(() => parseLink(link)).toThrow(LinkRefused);
    expect(() => parseLink(link)).toThrow(said);
  });
});
