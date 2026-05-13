import { parseJSONSafely, validateWidgetJSON } from '@scalius/shared/json-repair';
import { parseTagBasedResponse, validateParsedWidget } from '@scalius/shared/tag-parser';
import { stripWidgetRuntimeMarkup } from '@scalius/shared/widget-rendering';

export type GeneratedWidgetContent = { html: string; css: string };

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
}

export function parseGeneratedWidgetContent(content: string): GeneratedWidgetContent {
  const tagResult = parseTagBasedResponse(content);

  if (tagResult.success && tagResult.data) {
    const validation = validateParsedWidget(tagResult.data);
    if (!validation.valid) {
      throw new Error(validation.error || 'Invalid widget structure');
    }

    assertUsableCss(tagResult.data.css || '');
    return {
      html: tagResult.data.html,
      css: tagResult.data.css || '',
    };
  }

  const parsed = parseJSONSafely(content);
  if (!parsed.success) {
    throw new Error(parsed.error || 'Failed to parse response');
  }

  const validation = validateWidgetJSON(parsed.data);
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid widget structure');
  }

  const widgetData = parsed.data as { html: string; css?: string };
  assertUsableCss(widgetData.css || '');
  return {
    html: widgetData.html,
    css: widgetData.css || '',
  };
}

export function normalizeGeneratedWidgetContent(widget: GeneratedWidgetContent): GeneratedWidgetContent {
  const html = stripWidgetRuntimeMarkup(widget.html);
  return { html, css: `${widget.css || ''}${COMPOSITION_BOUNDARY_GUARD_CSS}` };
}

