import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../utils/api-error';
import {
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

  it('rejects prose without usable widget markup', () => {
    expect(() => normalizeWidgetGenerationText('I can help you build that.')).toThrow(ValidationError);
  });

  it('rejects widget output without HTML tags', () => {
    expect(() => normalizeWidgetGenerationText('<htmljs>plain text</htmljs>')).toThrow(ValidationError);
  });

  it('rejects script tags', () => {
    expect(() => normalizeWidgetGenerationText('<htmljs><div>Deal</div><script>alert("x")</script></htmljs>')).toThrow(
      ValidationError,
    );
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
