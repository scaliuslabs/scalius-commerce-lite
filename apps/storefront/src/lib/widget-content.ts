import {
  getWidgetScopeClass,
  normalizeWidgetCss,
  normalizeWidgetHtml,
  prepareScopedWidgetContent,
  type PreparedScopedWidgetContent,
} from "@scalius/shared/widget-rendering";
import {
  optimizeCssImageUrls,
  optimizeRichContentImages,
} from "./rich-content-media";

interface WidgetContentInput {
  id: string;
  htmlContent?: string | null;
  cssContent?: string | null;
}

interface PrepareWidgetContentOptions {
  priority?: boolean;
}

export type PreparedWidgetContent = PreparedScopedWidgetContent;

export { getWidgetScopeClass, normalizeWidgetCss, normalizeWidgetHtml };

export function prepareWidgetContent(
  widget: WidgetContentInput,
  options: PrepareWidgetContentOptions = {},
): PreparedWidgetContent {
  return prepareScopedWidgetContent(widget, {
    transformHtml: (html) =>
      optimizeRichContentImages(html, { priority: options.priority }),
    transformCss: optimizeCssImageUrls,
  });
}
