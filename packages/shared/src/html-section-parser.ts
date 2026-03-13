/**
 * HTML Section Parser - Extract logical sections from HTML for targeted improvements
 *
 * This utility allows non-staged widgets to be improved section-by-section by
 * intelligently parsing the HTML into logical blocks.
 *
 * Strategy:
 * 1. Look for top-level <div> elements
 * 2. Extract sections based on semantic HTML tags (section, article, header, footer, etc.)
 * 3. Fall back to class-based detection (common patterns like hero, content, cta, etc.)
 */

interface ParsedSection {
  index: number;
  html: string;
  css: string;
  description: string;
  id: string;
  timestamp: number;
}

/**
 * Extract sections from non-staged widget HTML
 *
 * Note: This function requires a DOM environment (browser or DOM polyfill).
 * It should only be called client-side in React components.
 */
export function parseHtmlIntoSections(
  html: string,
  css: string
): ParsedSection[] {
  // Check if DOMParser is available (browser environment)
  if (typeof DOMParser === 'undefined') {
    console.warn('DOMParser is not available (server-side rendering). Returning HTML as single section.');
    // Fallback: Return entire HTML as a single section
    return [{
      index: 0,
      html,
      css,
      description: 'Complete Widget',
      id: `parsed-section-0-${Date.now()}`,
      timestamp: Date.now(),
    }];
  }

  // Create a temporary DOM element to parse HTML
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const sections: ParsedSection[] = [];

  // Strategy 1: Check if already wrapped in widget-container (staged widget)
  const widgetContainer = doc.querySelector('.widget-container');
  if (widgetContainer) {
    const widgetSections = widgetContainer.querySelectorAll('.widget-section');
    widgetSections.forEach((section, idx) => {
      sections.push({
        index: idx,
        html: section.innerHTML,
        css: extractCssForSection(css, idx + 1),
        description: `Section ${idx + 1}`,
        id: `parsed-section-${idx}-${Date.now()}`,
        timestamp: Date.now(),
      });
    });
    if (sections.length > 0) return sections;
  }

  // Strategy 2: Look for semantic HTML5 sections
  const semanticTags = ['header', 'nav', 'section', 'article', 'aside', 'footer'];
  const semanticElements: Element[] = [];

  semanticTags.forEach(tag => {
    const elements = doc.body.querySelectorAll(tag);
    elements.forEach(el => {
      if (!isNested(el, semanticElements)) {
        semanticElements.push(el);
      }
    });
  });

  if (semanticElements.length > 0) {
    semanticElements.forEach((el, idx) => {
      sections.push({
        index: idx,
        html: el.outerHTML,
        css: extractCssForElement(css, el),
        description: generateDescription(el),
        id: `parsed-section-${idx}-${Date.now()}`,
        timestamp: Date.now(),
      });
    });
    return sections;
  }

  // Strategy 3: Look for common class patterns
  const commonPatterns = [
    { pattern: /hero|banner|jumbotron/i, name: 'Hero Section' },
    { pattern: /header|top|navbar/i, name: 'Header' },
    { pattern: /content|main|body/i, name: 'Content' },
    { pattern: /feature|service|product/i, name: 'Features' },
    { pattern: /cta|call-to-action|action/i, name: 'Call to Action' },
    { pattern: /testimonial|review/i, name: 'Testimonials' },
    { pattern: /footer|bottom/i, name: 'Footer' },
  ];

  const topLevelDivs = Array.from(doc.body.children).filter(
    el => el.tagName.toLowerCase() === 'div'
  );

  topLevelDivs.forEach((el, idx) => {
    const className = el.className || '';
    const id = el.id || '';
    let description = `Section ${idx + 1}`;

    // Try to match common patterns
    for (const { pattern, name } of commonPatterns) {
      if (pattern.test(className) || pattern.test(id)) {
        description = name;
        break;
      }
    }

    sections.push({
      index: idx,
      html: el.outerHTML,
      css: extractCssForElement(css, el),
      description,
      id: `parsed-section-${idx}-${Date.now()}`,
      timestamp: Date.now(),
    });
  });

  if (sections.length > 0) return sections;

  // Strategy 4: Fallback - split by top-level elements
  const allTopLevel = Array.from(doc.body.children);
  allTopLevel.forEach((el, idx) => {
    sections.push({
      index: idx,
      html: el.outerHTML,
      css: '', // Can't reliably extract CSS for arbitrary elements
      description: `${el.tagName.toLowerCase()} element ${idx + 1}`,
      id: `parsed-section-${idx}-${Date.now()}`,
      timestamp: Date.now(),
    });
  });

  // If still no sections, treat entire HTML as single section
  if (sections.length === 0) {
    sections.push({
      index: 0,
      html,
      css,
      description: 'Complete Widget',
      id: `parsed-section-0-${Date.now()}`,
      timestamp: Date.now(),
    });
  }

  return sections;
}

/**
 * Check if element is nested within any of the given elements
 */
function isNested(element: Element, containers: Element[]): boolean {
  return containers.some(container => container.contains(element) && container !== element);
}

/**
 * Generate a human-readable description for an element
 */
function generateDescription(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const className = element.className || '';
  const id = element.id || '';

  // Prioritize ID
  if (id) return `${tag} (#${id})`;

  // Then class names
  if (className) {
    const firstClass = className.split(' ')[0];
    return `${tag} (.${firstClass})`;
  }

  // Fallback to tag name
  const tagDescriptions: Record<string, string> = {
    'header': 'Header',
    'nav': 'Navigation',
    'section': 'Section',
    'article': 'Article',
    'aside': 'Sidebar',
    'footer': 'Footer',
  };

  return tagDescriptions[tag] || tag;
}

/**
 * Extract CSS rules that apply to a specific element
 */
function extractCssForElement(css: string, element: Element): string {
  const className = element.className;
  const id = element.id;

  if (!className && !id) return '';

  const cssLines = css.split('\n');
  const relevantCss: string[] = [];
  let currentRule = '';
  let isRelevant = false;
  let braceCount = 0;

  for (const line of cssLines) {
    currentRule += line + '\n';

    // Count braces
    braceCount += (line.match(/{/g) || []).length;
    braceCount -= (line.match(/}/g) || []).length;

    // Check if this rule is relevant
    if (braceCount === 0 && currentRule.trim()) {
      const selector = currentRule.split('{')[0].trim();

      // Check if selector matches element
      if (className) {
        const classes = className.split(' ');
        if (classes.some(cls => selector.includes(`.${cls}`))) {
          isRelevant = true;
        }
      }

      if (id && selector.includes(`#${id}`)) {
        isRelevant = true;
      }

      if (isRelevant) {
        relevantCss.push(currentRule.trim());
      }

      currentRule = '';
      isRelevant = false;
    }
  }

  return relevantCss.join('\n\n');
}

/**
 * Extract CSS for a specific section number (for staged widgets)
 */
function extractCssForSection(css: string, sectionNumber: number): string {
  const sectionClass = `widget-section-${sectionNumber}`;
  const sectionComment = `Section ${sectionNumber} styles`;

  const cssLines = css.split('\n');
  const relevantCss: string[] = [];
  let isInSectionBlock = false;
  let currentBlock = '';

  for (const line of cssLines) {
    if (line.includes(sectionComment)) {
      isInSectionBlock = true;
      continue;
    }

    // Check for next section comment
    if (isInSectionBlock && line.includes('Section ') && line.includes('styles')) {
      break;
    }

    if (isInSectionBlock) {
      currentBlock += line + '\n';
    }

    // Also check for class-based rules
    if (line.includes(`.${sectionClass}`)) {
      relevantCss.push(line);
    }
  }

  if (currentBlock) {
    relevantCss.push(currentBlock.trim());
  }

  return relevantCss.join('\n\n');
}

/**
 * Reconstruct full widget from sections
 */
export function reconstructWidgetFromSections(sections: ParsedSection[]): { html: string; css: string } {
  const combinedHtml = `<div class="widget-container">\n${sections
    .map((s, idx) => {
      const sectionHtml = s.html.split('\n').map(line => '    ' + line).join('\n');
      return `  <div class="widget-section widget-section-${idx + 1}" data-section="${idx + 1}">\n${sectionHtml}\n  </div>`;
    }).join('\n')}\n</div>`;

  const combinedCss = `
/* Widget Container Spacing */
.widget-container {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  width: 100%;
}

.widget-section {
  width: 100%;
}

/* Mobile Responsive Spacing */
@media (max-width: 768px) {
  .widget-container { gap: 1.5rem; }
}

@media (max-width: 480px) {
  .widget-container { gap: 1rem; }
}

/* Section-specific styles */
${sections.map((s, idx) => s.css ? `/* Section ${idx + 1} styles */\n${s.css}` : '').filter(Boolean).join('\n\n')}
`;

  return {
    html: combinedHtml,
    css: combinedCss,
  };
}
