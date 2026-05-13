import { describe, expect, it } from 'vitest';
import { reconstructWidgetFromSections } from './html-section-parser';

describe('html section reconstruction', () => {
  it('reconstructs staged widgets with a zero-gap composition wrapper', () => {
    const widget = reconstructWidgetFromSections([
      {
        index: 0,
        html: '<section class="hero">Hero</section>',
        css: '.hero { padding: 2rem; }',
        description: 'Hero',
        id: 'section-1',
        timestamp: 1,
      },
      {
        index: 1,
        html: '<section class="products">Products</section>',
        css: '.products { padding: 2rem; }',
        description: 'Products',
        id: 'section-2',
        timestamp: 2,
      },
    ]);

    expect(widget.html).toContain('class="widget-container"');
    expect(widget.html).toContain('data-section="1"');
    expect(widget.html).toContain('data-section="2"');
    expect(widget.css).toContain('gap: 0;');
    expect(widget.css).not.toContain('gap: 2rem');
    expect(widget.css).not.toContain('Mobile Responsive Spacing');
  });
});
