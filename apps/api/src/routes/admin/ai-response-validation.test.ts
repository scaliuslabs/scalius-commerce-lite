import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../utils/api-error';
import {
  createNoContextFallbackWidget,
  normalizeStagedPlanOutput,
  normalizeStagedPlanText,
  normalizeWidgetGenerationText,
} from './ai-response-validation';

describe('AI response validation', () => {
  it('canonicalizes tag-based widget output', () => {
    expect(
      normalizeWidgetGenerationText(`
        Sure:
        <htmljs><section class="hero">Hello</section></htmljs>
        <css>.hero { color: red; }</css>
      `),
    ).toBe(`<htmljs>\n<section class="hero">Hello</section>\n</htmljs>\n\n<css>\n.hero{color:red}\n</css>`);
  });

  it('retains CSS from attributed model response tags', () => {
    expect(
      normalizeWidgetGenerationText(`
        <htmljs format="fragment"><section class="hero">Hello</section></htmljs>
        <css scoped="true">.hero { color: red; }</css>
      `),
    ).toBe(`<htmljs>\n<section class="hero">Hello</section>\n</htmljs>\n\n<css>\n.hero{color:red}\n</css>`);
  });

  it('sanitizes generated HTML attributes and stylesheet URLs before returning', () => {
    const output = normalizeWidgetGenerationText(`
      <htmljs><section onclick="alert(1)"><a href="javascript:alert(1)">Deal</a></section></htmljs>
      <css>.promo { background-image: url("javascript:alert(1)"); color: blue; }</css>
    `);

    expect(output).toContain('<section><a>Deal</a></section>');
    expect(output).not.toContain('onclick');
    expect(output).not.toContain('javascript:');
    expect(output).toContain('color:blue');
  });

  it('extracts generated style tags into the returned stylesheet', () => {
    const output = normalizeWidgetGenerationText(`
      <htmljs>
        <section class="promo">
          <style>.promo { color: red; }</style>
          <h2>Deal</h2>
        </section>
      </htmljs>
      <css>.promo h2 { margin: 0; }</css>
    `);

    expect(output).toContain('<section class="promo">');
    expect(output).not.toContain('<style>');
    expect(output).toContain('.promo h2');
    expect(output).toContain('.promo{color:red}');
  });

  it('canonicalizes JSON widget output with htmljs', () => {
    expect(
      normalizeWidgetGenerationText(
        JSON.stringify({
          htmljs: '<div class="promo">Deal</div>',
          css: '.promo { display: grid; }',
        }),
      ),
    ).toContain('<div class="promo">Deal</div>');
  });

  it('canonicalizes raw HTML document output when the provider ignores artifact tags', () => {
    const output = normalizeWidgetGenerationText(`
      <!doctype html>
      <html>
        <head><style>.promo { display: grid; }</style></head>
        <body><section class="promo"><h2>Deal</h2></section></body>
      </html>
    `);

    expect(output).toContain('<section class="promo"><h2>Deal</h2></section>');
    expect(output).toContain('.promo{display:grid}');
  });

  it('rejects prose without usable widget markup', () => {
    expect(() => normalizeWidgetGenerationText('I can help you build that.')).toThrow(ValidationError);
  });

  it('rejects widget output without HTML tags', () => {
    expect(() => normalizeWidgetGenerationText('<htmljs>plain text</htmljs>')).toThrow(ValidationError);
  });

  it('extracts script tags into scoped JS when the script is local-safe', () => {
    const output = normalizeWidgetGenerationText(`
      <htmljs><section class="promo"><button>Deal</button><script>widget.query("button")?.classList.add("ready")</script></section></htmljs>
      <css>.promo { color: red; }</css>
    `);

    expect(output).toContain('<section class="promo"><button>Deal</button></section>');
    expect(output).toContain('<js>');
    expect(output).toContain('widget.query("button")');
  });

  it('rejects widgets without usable CSS', () => {
    expect(() =>
      normalizeWidgetGenerationText(`
        <htmljs><section class="promo"><h2>Deal</h2></section></htmljs>
        <css></css>
      `),
    ).toThrow(ValidationError);
  });

  it('rejects truncated generated CSS instead of recovering a partial design', () => {
    expect(() =>
      normalizeWidgetGenerationText(`
        <htmljs><section class="promo"><a class="cta">Deal</a></section></htmljs>
        <css>.promo { padding: 24px; }.cta { display: inline-flex; align-items: }</css>
      `),
    ).toThrow(ValidationError);
  });

  it('rejects generated CSS that ends in a dangling declaration', () => {
    expect(() =>
      normalizeWidgetGenerationText(`
        <htmljs><section class="promo"><span class="badge">Deal</span></section></htmljs>
        <css>.promo { padding: 24px; }.badge { position: absolute; top:</css>
      `),
    ).toThrow(ValidationError);
  });

  it('rejects generated CSS that ends in an unfinished property name', () => {
    expect(() =>
      normalizeWidgetGenerationText(`
        <htmljs><section class="promo"><a class="btn">Deal</a></section></htmljs>
        <css>.promo { padding: 24px; }.btn { display: inline-flex; text-decoration</css>
      `),
    ).toThrow(ValidationError);
  });

  it('rejects unsupported commerce claims when no catalog facts were provided', () => {
    expect(() =>
      normalizeWidgetGenerationText(
        `<htmljs>
          <section>
            <h2>Limited Release Energy</h2>
            <p>Fast Delivery and Satisfaction Guaranteed.</p>
          </section>
        </htmljs>
        <css>section{padding:24px}</css>`,
        { commerceFactsProvided: false },
      ),
    ).toThrow(ValidationError);
  });

  it('allows generic non-factual no-context widgets', () => {
    expect(
      normalizeWidgetGenerationText(
        `<htmljs>
          <section>
            <h2>Explore the range</h2>
            <p>Find a fresh pick for your everyday routine.</p>
          </section>
        </htmljs>
        <css>section{padding:24px}</css>`,
        { commerceFactsProvided: false },
      ),
    ).toContain('Explore the range');
  });

  it('rejects invented catalog cards when no catalog facts were provided', () => {
    expect(() =>
      normalizeWidgetGenerationText(
        `<htmljs>
          <section>
            <a href="#" aria-label="View Core Daily details">Core Daily</a>
            <span>Available in 3 finishes</span>
          </section>
        </htmljs>
        <css>section{padding:24px}</css>`,
        { commerceFactsProvided: false },
      ),
    ).toThrow(ValidationError);
  });

  it('provides a deterministic safe fallback for no-context generations', () => {
    const output = createNoContextFallbackWidget();

    expect(output).toContain('<htmljs>');
    expect(output).toContain('Explore the range');
    expect(output).not.toMatch(/https?:\/\//i);
    expect(output).not.toMatch(/\b(?:shipping|delivery|guarantee|review|limited)\b/i);
  });

  it('uses destination-aware deterministic safe fallbacks', () => {
    const collectionOutput = createNoContextFallbackWidget('collection');
    const landingOutput = createNoContextFallbackWidget('landing-page');
    const homepageOutput = createNoContextFallbackWidget('widget');

    expect(homepageOutput).toContain('Homepage discovery widget');
    expect(collectionOutput).toContain('Compare the lineup');
    expect(collectionOutput).toContain('Collection comparison guide');
    expect(collectionOutput).not.toContain('Store discovery');
    expect(landingOutput).toContain('Start with the right pick');
    expect(landingOutput).toContain('Campaign landing section');
    expect(landingOutput).not.toContain('Homepage discovery widget');
    expect(collectionOutput).not.toMatch(/https?:\/\//i);
    expect(landingOutput).not.toMatch(/https?:\/\//i);
  });

  it('canonicalizes valid staged plans', () => {
    const text = normalizeStagedPlanText(
      JSON.stringify({
        totalSections: 2,
        compositionBrief: 'One continuous homepage widget',
        sharedDesignSystem: 'Shared dark palette and rounded product cards',
        spacingStrategy: 'Sections connect with gap 0 and internal padding',
        sectionDescriptions: ['Hero', 'Featured collection'],
        sectionContinuity: ['Open the shared style', 'Continue directly from the hero'],
        estimatedTokens: 1200,
      }),
    );

    expect(JSON.parse(text)).toEqual({
      totalSections: 2,
      compositionBrief: 'One continuous homepage widget',
      sharedDesignSystem: 'Shared dark palette and rounded product cards',
      spacingStrategy: 'Sections connect with gap 0 and internal padding',
      sectionDescriptions: ['Hero', 'Featured collection'],
      sectionContinuity: ['Open the shared style', 'Continue directly from the hero'],
      estimatedTokens: 1200,
    });
  });

  it('repairs staged plans with recoverable section mismatches', () => {
    const text = normalizeStagedPlanText(
      JSON.stringify({
        totalSections: 3,
        sectionDescriptions: ['Hero', 'Featured collection'],
      }),
    );

    expect(JSON.parse(text)).toEqual({
      totalSections: 3,
      compositionBrief:
        'One continuous storefront widget composition with a clear opening, supporting merchandising, and conversion close.',
      sharedDesignSystem:
        'Reuse one color palette, type scale, image treatment, card style, button language, and responsive spacing rhythm across every section.',
      spacingStrategy:
        'The final wrapper places sections with zero external gap; each section uses internal padding and intentional dividers or shared backgrounds to connect.',
      sectionDescriptions: ['Hero', 'Featured collection', 'Section 3'],
      sectionContinuity: [
        'Establish the shared visual system and hand off naturally to the next section.',
        'Continue the shared visual system from the previous section without external spacing.',
        'Continue the shared visual system from the previous section without external spacing.',
      ],
      estimatedTokens: 2100,
    });
  });

  it('repairs staged plans with recoverable continuity mismatches', () => {
    const text = normalizeStagedPlanText(
      JSON.stringify({
        totalSections: 2,
        compositionBrief: 'One widget',
        sharedDesignSystem: 'Shared cards',
        spacingStrategy: 'Gap zero',
        sectionDescriptions: ['Hero', 'Products'],
        sectionContinuity: ['Hero hands off'],
        estimatedTokens: 900,
      }),
    );

    expect(JSON.parse(text)).toEqual({
      totalSections: 2,
      compositionBrief: 'One widget',
      sharedDesignSystem: 'Shared cards',
      spacingStrategy: 'Gap zero',
      sectionDescriptions: ['Hero', 'Products'],
      sectionContinuity: [
        'Hero hands off',
        'Continue the shared visual system from the previous section without external spacing.',
      ],
      estimatedTokens: 900,
    });
  });

  it('normalizes structured staged plans when estimatedTokens is omitted', () => {
    const text = normalizeStagedPlanOutput({
      totalSections: 2,
      compositionBrief: 'One widget',
      sharedDesignSystem: 'Shared cards',
      spacingStrategy: 'Gap zero',
      sectionDescriptions: ['Hero', 'Products'],
      sectionContinuity: ['Open tightly', 'Continue tightly'],
    });

    expect(JSON.parse(text)).toEqual({
      totalSections: 2,
      compositionBrief: 'One widget',
      sharedDesignSystem: 'Shared cards',
      spacingStrategy: 'Gap zero',
      sectionDescriptions: ['Hero', 'Products'],
      sectionContinuity: ['Open tightly', 'Continue tightly'],
      estimatedTokens: 1400,
    });
  });

  it('rejects staged plans without JSON', () => {
    expect(() => normalizeStagedPlanText('Create a hero and products section.')).toThrow(ValidationError);
  });
});
