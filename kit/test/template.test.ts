import { beforeAll, describe, expect, it } from "vitest";
import { loadTemplates, render, templateCharacters } from "../src/template.js";

beforeAll(async () => {
  await loadTemplates();
});

describe("rendering a mapping's template", () => {
  it("renders the values given, and none as nothing", () => {
    expect(render("{{ a | upper }}-{{ b }}", { a: "x", b: null })).toEqual({
      text: "X-",
    });
  });

  it("counts characters as Marfa does, so a surrogate pair is one", () => {
    const emoji = "\u{1F600}";
    expect(
      render("{{ e }}", { e: emoji.repeat(templateCharacters) }).text,
    ).toHaveLength(2 * templateCharacters);
    expect(
      render("{{ e }}", { e: emoji.repeat(templateCharacters + 1) }).fault,
    ).toContain("more than 100,000 characters");
  });

  it("reads no template, file or global beyond the values given", () => {
    expect(render("{% include 'other' %}", {}).fault).toContain(
      "template not found",
    );
    expect(render("{% import 'other' as o %}", {}).fault).toContain(
      "template not found",
    );
    expect(render("{{ debug() }}", {}).fault).toContain("unknown function");
    expect(render("{{ env }}", {}).fault).toContain("undefined value");
  });
});
