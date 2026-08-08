import { DomUtils, parseDocument } from "htmlparser2";
import { isTag, type ChildNode } from "domhandler";

export type HtmlAnchorAttributeTransform = (
  attributes: Readonly<Record<string, string>>,
) => Record<string, string> | undefined;

function transformAnchorNodes(
  nodes: ChildNode[] = [],
  transform: HtmlAnchorAttributeTransform,
): void {
  for (const node of nodes) {
    if (!isTag(node)) continue;

    if (node.name.toLowerCase() === "a") {
      const nextAttributes = transform({ ...node.attribs });
      if (nextAttributes) node.attribs = nextAttributes;
    }

    transformAnchorNodes(node.children ?? [], transform);
  }
}

/**
 * Transforms anchor attributes in an HTML fragment with a real HTML parser.
 * Text and attribute values are serialized safely instead of being treated as
 * attribute syntax by regular expressions.
 */
export function transformHtmlAnchorAttributes(
  html: string,
  transform: HtmlAnchorAttributeTransform,
): string {
  if (!html) return "";

  const document = parseDocument(html, {
    decodeEntities: true,
    lowerCaseAttributeNames: true,
    lowerCaseTags: true,
  });
  transformAnchorNodes(document.children, transform);
  return DomUtils.getOuterHTML(document.children);
}
