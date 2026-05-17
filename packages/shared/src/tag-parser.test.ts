import { describe, expect, it } from "vitest";
import { parseTagBasedResponse } from "./tag-parser";

describe("parseTagBasedResponse", () => {
  it("extracts widget tags that include attributes", () => {
    const result = parseTagBasedResponse(`
      <htmljs lang="html">
        <section class="hero">Launch</section>
      </htmljs>
      <css scoped="true" data-format="safe">
        .hero { color: red; }
      </css>
    `);

    expect(result.success).toBe(true);
    expect(result.data?.html).toContain('<section class="hero">Launch</section>');
    expect(result.data?.css).toContain(".hero { color: red; }");
  });

  it("extracts attributed staged parts without dropping section CSS", () => {
    const result = parseTagBasedResponse(`
      <part1 role="hero">
        <htmljs><section class="hero">Hero</section></htmljs>
        <css scoped>.hero { padding: 32px; }</css>
      </part1>
      <part2 role="products">
        <htmljs><section class="grid">Grid</section></htmljs>
        <css scoped>.grid { display: grid; }</css>
      </part2>
    `);

    expect(result.success).toBe(true);
    expect(result.sections).toHaveLength(2);
    expect(result.data?.html).toContain("Hero");
    expect(result.data?.html).toContain("Grid");
    expect(result.data?.css).toContain(".hero { padding: 32px; }");
    expect(result.data?.css).toContain(".grid { display: grid; }");
  });

  it("recovers raw HTML documents that include style tags", () => {
    const result = parseTagBasedResponse(`
      <!doctype html>
      <html>
        <head><style>.drinks { display: grid; }</style></head>
        <body><section class="drinks"><h2>Drinks</h2></section></body>
      </html>
    `);

    expect(result.success).toBe(true);
    expect(result.data?.html).toContain('<section class="drinks">');
    expect(result.data?.css).toContain(".drinks { display: grid; }");
  });
});
