// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The screens Wave 7 added (settings cards, provider cards and setup sheets,
 * apps, content types, address) read every word from the en + bn catalogs.
 * Raw text between JSX tags, or in a text attribute, would stay English in
 * the Bangla dashboard.
 */
const SCREENS = ["settings", "apps", "metaobjects", "address"];
const ROOT = join(__dirname, "..", "components", "admin");
const TEXT_ATTRIBUTES = new Set(["title", "placeholder", "aria-label", "alt", "label", "description", "aria-description", "tooltip"]);
/** Values that are the same in every language: formats, hosts, ids. */
const LANGUAGE_NEUTRAL = /^(https?:\/\/|[\w.-]+@[\w.-]+|[a-z0-9_.-]+(\.[a-z]{2,})+$|[a-z_]+$|pk_|sk_|[\s·•—–|/:.,()+-]*$)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

function rawEnglish(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (node: ts.Node, value: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${file.slice(ROOT.length + 1)}:${line + 1} ${value.replace(/\s+/g, " ").trim()}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const value = node.getText().replace(/&nbsp;/g, " ");
      if (/[A-Za-z]{2,}/.test(value) && !LANGUAGE_NEUTRAL.test(value.trim())) report(node, value);
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && TEXT_ATTRIBUTES.has(node.name.getText())) {
      const value = node.initializer.text;
      if (/[A-Za-z]{3,}/.test(value) && !LANGUAGE_NEUTRAL.test(value)) report(node, `${node.name.getText()}="${value}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("raw English in the Wave 7 screens", () => {
  it("has none: every word comes from the en + bn catalogs", () => {
    const found = SCREENS.flatMap((screen) => sourceFiles(join(ROOT, screen)).flatMap(rawEnglish));
    expect(found).toEqual([]);
  });
});
