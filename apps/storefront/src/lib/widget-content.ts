import {
  getWidgetScopeClass,
  normalizeWidgetCss,
  normalizeWidgetHtml,
  rewriteWidgetHrefTargets,
  createScopedWidgetScript,
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
  jsContent?: string | null;
}

interface PrepareWidgetContentOptions {
  priority?: boolean;
}

export type PreparedWidgetContent = PreparedScopedWidgetContent;

export { getWidgetScopeClass, normalizeWidgetCss, normalizeWidgetHtml };
export { createScopedWidgetScript };

const WIDGET_STOREFRONT_HREF_REWRITES: Record<string, string> = {
  "/collections": "/search",
  "/collections/all": "/search",
};

export function prepareWidgetContent(
  widget: WidgetContentInput,
  options: PrepareWidgetContentOptions = {},
): PreparedWidgetContent {
  return prepareScopedWidgetContent(widget, {
    transformHtml: (html) => {
      const optimizedHtml = optimizeRichContentImages(html, {
        priority: options.priority,
      });
      return rewriteWidgetHrefTargets(
        optimizedHtml,
        WIDGET_STOREFRONT_HREF_REWRITES,
      );
    },
    transformCss: optimizeCssImageUrls,
  });
}
