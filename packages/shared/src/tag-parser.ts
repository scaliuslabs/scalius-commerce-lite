/**
 * Tag-Based Parser for LLM Responses
 *
 * Replaces fragile JSON parsing with robust tag-based extraction.
 * LLMs can more reliably generate content within XML-like tags than perfect JSON.
 *
 * Supported formats:
 * 1. Full widget: <htmljs>...</htmljs> <css>...</css>
 * 2. Sectioned widget: <part1><htmljs>...</htmljs><css>...</css></part1>
 * 3. Legacy JSON: {"html": "...", "css": "..."}
 */

export interface ParsedWidget {
  html: string;
  css: string;
  raw?: string; // Original response for debugging
}

export interface ParsedSection {
  partNumber: number;
  html: string;
  css: string;
}

export interface ParseResult {
  success: boolean;
  data?: ParsedWidget;
  sections?: ParsedSection[];
  error?: string;
  raw?: string;
}

/**
 * Extract content between XML-like tags
 */
function extractTag(content: string, tagName: string): string | null {
  // Try with self-closing or full tags
  const patterns = [
    new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'),
    new RegExp(`<${tagName}/>`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1]?.trim() || '';
    }
  }

  return null;
}

/**
 * Extract all sections (for multi-part generation)
 */
function extractSections(content: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  const partPattern = /<part(\d+)>([\s\S]*?)<\/part\1>/gi;

  let match;
  while ((match = partPattern.exec(content)) !== null) {
    const partNumber = parseInt(match[1], 10);
    const partContent = match[2];

    const html = extractTag(partContent, 'htmljs') || extractTag(partContent, 'html') || '';
    const css = extractTag(partContent, 'css') || '';

    if (html || css) {
      sections.push({
        partNumber,
        html,
        css,
      });
    }
  }

  return sections;
}

/**
 * Parse tag-based LLM response
 */
export function parseTagBasedResponse(response: string): ParseResult {
  const trimmed = response.trim();

  // Strategy 1: Try extracting sections first (multi-part generation)
  const sections = extractSections(trimmed);
  if (sections.length > 0) {
    // Combine sections into a single widget
    const combinedHtml = sections.map(s => s.html).join('\n');
    const combinedCss = sections.map(s => s.css).filter(Boolean).join('\n\n');

    return {
      success: true,
      data: {
        html: combinedHtml,
        css: combinedCss,
        raw: trimmed,
      },
      sections,
    };
  }

  // Strategy 2: Try extracting single widget tags
  const htmljs = extractTag(trimmed, 'htmljs');
  const html = extractTag(trimmed, 'html');
  const css = extractTag(trimmed, 'css');

  const extractedHtml = htmljs || html;

  if (extractedHtml !== null || css !== null) {
    return {
      success: true,
      data: {
        html: extractedHtml || '',
        css: css || '',
        raw: trimmed,
      },
    };
  }

  // Strategy 3: Try JSON parsing as fallback
  try {
    // Remove markdown code blocks if present
    let jsonString = trimmed;
    if (jsonString.startsWith('```json')) {
      jsonString = jsonString.replace(/^```json\s*/, '').replace(/```\s*$/, '');
    } else if (jsonString.startsWith('```')) {
      jsonString = jsonString.replace(/^```\s*/, '').replace(/```\s*$/, '');
    }

    const parsed = JSON.parse(jsonString);

    if (parsed.html || parsed.htmlContent) {
      return {
        success: true,
        data: {
          html: parsed.html || parsed.htmlContent || '',
          css: parsed.css || parsed.cssContent || '',
          raw: trimmed,
        },
      };
    }
  } catch (e) {
    // JSON parsing failed, continue to next strategy
  }

  // Strategy 4: Try to extract code blocks
  const htmlCodeBlock = trimmed.match(/```html\s*([\s\S]*?)```/i);
  const cssCodeBlock = trimmed.match(/```css\s*([\s\S]*?)```/i);

  if (htmlCodeBlock || cssCodeBlock) {
    return {
      success: true,
      data: {
        html: htmlCodeBlock?.[1]?.trim() || '',
        css: cssCodeBlock?.[1]?.trim() || '',
        raw: trimmed,
      },
    };
  }

  // All strategies failed
  return {
    success: false,
    error: 'Could not parse response. No recognized format found.',
    raw: trimmed,
  };
}

/**
 * Validate parsed widget has minimum required content
 */
export function validateParsedWidget(widget: ParsedWidget): { valid: boolean; error?: string } {
  if (!widget.html || widget.html.trim().length === 0) {
    return {
      valid: false,
      error: 'HTML content is empty or missing',
    };
  }

  // Check for suspicious content that might indicate parsing failure
  if (widget.html.includes('```') && widget.html.length < 200) {
    return {
      valid: false,
      error: 'HTML appears to contain unparsed markdown',
    };
  }

  return { valid: true };
}

/**
 * Parse streaming response chunks
 * Accumulates partial content and attempts parsing when tags are complete
 */
export class StreamingTagParser {
  private buffer: string = '';
  private lastSuccessfulParse: ParseResult | null = null;

  append(chunk: string): void {
    this.buffer += chunk;
  }

  /**
   * Try to parse current buffer
   * Returns parsed result if tags are complete, null if waiting for more data
   */
  tryParse(): ParseResult | null {
    const result = parseTagBasedResponse(this.buffer);

    if (result.success) {
      this.lastSuccessfulParse = result;
      return result;
    }

    // If we have previous successful parse, return it (for progressive updates)
    return this.lastSuccessfulParse;
  }

  getBuffer(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = '';
    this.lastSuccessfulParse = null;
  }
}

/**
 * Generate example response format for LLM prompts
 */
export function getTagBasedExampleFormat(): string {
  return `
RESPONSE FORMAT:
Please respond with your code wrapped in the following tags:

<htmljs>
<!-- Your HTML code here. Include JavaScript within <script> tags if needed. -->
</htmljs>

<css>
/* Your CSS code here */
</css>

For multi-section widgets, use:
<part1>
<htmljs>
<!-- Section 1 HTML -->
</htmljs>
<css>
/* Section 1 CSS */
</css>
</part1>

<part2>
<htmljs>
<!-- Section 2 HTML -->
</htmljs>
<css>
/* Section 2 CSS */
</css>
</part2>

IMPORTANT:
- Do NOT wrap in markdown code blocks (\`\`\`json or \`\`\`html)
- Do NOT use JSON format
- Just use the simple tags shown above
- Make sure to close all tags properly
`;
}
