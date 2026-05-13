import { describe, expect, it } from 'vitest';
import {
  normalizeGeneratedWidgetContent,
  parseGeneratedWidgetContent,
} from './widget-generation-content';

describe('widget generation content parsing', () => {
  it('rejects generated widgets that would preview without usable CSS', () => {
    expect(() =>
      parseGeneratedWidgetContent(`
        <htmljs><section class="promo"><h2>Deal</h2></section></htmljs>
        <css></css>
      `),
    ).toThrow('missing usable CSS');
  });

  it('rejects generated CSS that sanitizes away before preview', () => {
    expect(() =>
      parseGeneratedWidgetContent(`
        <htmljs><section class="promo"><h2>Deal</h2></section></htmljs>
        <css>.promo[ { color: red; }</css>
      `),
    ).toThrow(/CSS/i);
  });

  it('rejects generated HTML that sanitizes away before preview', () => {
    expect(() =>
      parseGeneratedWidgetContent(`
        <htmljs><script>alert(1)</script></htmljs>
        <css>.promo { color: red; }</css>
      `),
    ).toThrow(/HTML/i);
  });

  it('strips platform runtime wrappers before previewing generated content', () => {
    const content = normalizeGeneratedWidgetContent(
      parseGeneratedWidgetContent(`
        <htmljs>
          <div class="widget-container" data-scalius-widget-root="true">
            <section class="promo"><h2>Deal</h2></section>
          </div>
        </htmljs>
        <css>.promo { color: red; }</css>
      `),
    );

    expect(content.html).toContain('<section class="promo">');
    expect(content.html).not.toContain('widget-container');
    expect(content.css).toContain('.promo { color: red; }');
    expect(content.css).toContain('Scalius composition boundary guard');
  });

  it('preserves supported JSON aliases instead of dropping generated CSS', () => {
    const content = parseGeneratedWidgetContent(
      JSON.stringify({
        htmljs: '<section class="promo"><h2>Deal</h2></section>',
        cssContent: '.promo { color: red; }',
      }),
    );

    expect(content.html).toContain('class="promo"');
    expect(content.css).toContain('.promo { color: red; }');
  });
});
