import { parseJSONSafely, validateWidgetJSON } from '@scalius/shared/json-repair';
import { parseTagBasedResponse, validateParsedWidget } from '@scalius/shared/tag-parser';
import {
  evaluateWidgetRenderability,
  hasLikelyTruncatedCss,
  normalizeWidgetParts,
  stripWidgetRuntimeMarkup,
} from '@scalius/shared/widget-rendering';

export type GeneratedWidgetContent = { html: string; css: string; js?: string };

const COMPOSITION_BOUNDARY_GUARD_CSS = `

/* Scalius composition boundary guard */
[data-scalius-widget-root="true"] {
  gap: 0;
  margin: 0;
}

[data-scalius-widget-root="true"] > :first-child {
  margin-top: 0;
}

[data-scalius-widget-root="true"] > :last-child {
  margin-bottom: 0;
}`;

function assertUsableCss(css: string): void {
  const trimmed = css.trim();
  if (!trimmed || !/[{}]/.test(trimmed)) {
    throw new Error('Generated widget is missing usable CSS. Please regenerate.');
  }
  if (hasLikelyTruncatedCss(trimmed)) {
    throw new Error('Generated widget CSS was malformed or incomplete. Please regenerate.');
  }
}

function assertRenderableWidgetContent(widget: GeneratedWidgetContent): void {
  const report = evaluateWidgetRenderability({
    id: 'preview-validation',
    htmlContent: widget.html,
    cssContent: widget.css,
    jsContent: widget.js,
  });

  if (report.hasInputHtml && !report.hasRenderableHtml) {
    throw new Error(
      report.warnings[0] || 'Generated widget HTML could not be rendered safely. Please regenerate.',
    );
  }

  if (report.cssReport.warnings.length > 0) {
    throw new Error('Generated widget CSS was malformed or incomplete. Please regenerate.');
  }

  if (!report.hasRenderableCss) {
    throw new Error(
      report.warnings[0] || 'Generated widget CSS could not be rendered safely. Please regenerate.',
    );
  }
}

function normalizeParsedWidgetContent(widget: GeneratedWidgetContent): GeneratedWidgetContent {
  const parts = normalizeWidgetParts({
    htmlContent: widget.html,
    cssContent: widget.css,
    jsContent: widget.js,
  });

  return {
    html: parts.html,
    css: parts.css,
    js: parts.js,
  };
}

export function parseGeneratedWidgetContent(content: string): GeneratedWidgetContent {
  const tagResult = parseTagBasedResponse(content);

  if (tagResult.success && tagResult.data) {
    const validation = validateParsedWidget(tagResult.data);
    if (!validation.valid) {
      throw new Error(validation.error || 'Invalid widget structure');
    }

    assertUsableCss(tagResult.data.css || '');
    const widget = normalizeParsedWidgetContent({
      html: tagResult.data.html,
      css: tagResult.data.css || '',
      js: tagResult.data.js || '',
    });
    assertRenderableWidgetContent(widget);
    return widget;
  }

  const parsed = parseJSONSafely(content);
  if (!parsed.success) {
    throw new Error(parsed.error || 'Failed to parse response');
  }

  const validation = validateWidgetJSON(parsed.data);
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid widget structure');
  }

  const widgetData = parsed.data as {
    html?: string;
    htmljs?: string;
    htmlContent?: string;
    css?: string;
    cssContent?: string;
    js?: string;
    javascript?: string;
    jsContent?: string;
  };
  const html = widgetData.html || widgetData.htmljs || widgetData.htmlContent || '';
  const css = widgetData.css || widgetData.cssContent || '';
  const js = widgetData.js || widgetData.javascript || widgetData.jsContent || '';
  assertUsableCss(css);
  const widget = normalizeParsedWidgetContent({
    html,
    css,
    js,
  });
  assertRenderableWidgetContent(widget);
  return widget;
}

export function normalizeGeneratedWidgetContent(widget: GeneratedWidgetContent): GeneratedWidgetContent {
  const html = stripWidgetRuntimeMarkup(widget.html);
  return { html, css: `${widget.css || ''}${COMPOSITION_BOUNDARY_GUARD_CSS}`, js: widget.js || '' };
}
