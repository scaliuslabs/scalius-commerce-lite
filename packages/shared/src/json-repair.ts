/**
 * JSON Repair Utility - Enhanced Version
 * Attempts to fix common JSON formatting issues from LLM responses
 */

/**
 * Attempts to extract and parse JSON from a string that might contain markdown or extra text
 */
export function extractAndParseJSON(text: string): any {
  // Remove markdown code blocks
  let cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "");

  // Try to find JSON object boundaries
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  return JSON.parse(cleaned);
}

/**
 * Repairs common JSON formatting issues - IMPROVED VERSION
 */
export function repairJSON(jsonString: string): string {
  let repaired = jsonString.trim();

  // Remove markdown code blocks
  repaired = repaired.replace(/```json\s*/g, "").replace(/```\s*/g, "");

  // Fix unescaped newlines CAREFULLY - only in string values
  repaired = repaired.replace(
    /"([^"]*)\n([^"]*)"/g,
    (_match, before, after) => {
      return `"${before}\\n${after}"`;
    },
  );

  // Remove trailing commas
  repaired = repaired.replace(/,(\s*[}\]])/g, "$1");

  // Balance braces and brackets
  const openBraces = (repaired.match(/\{/g) || []).length;
  const closeBraces = (repaired.match(/\}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;

  if (openBraces > closeBraces) {
    repaired += "}".repeat(openBraces - closeBraces);
  }
  if (openBrackets > closeBrackets) {
    repaired += "]".repeat(openBrackets - closeBrackets);
  }

  return repaired;
}

/**
 * NEW: More aggressive repair for badly broken JSON
 */
export function aggressiveRepairJSON(jsonString: string): string {
  let repaired = jsonString.trim();

  // Try to extract just the JSON part if there's preamble/postamble
  const jsonStart = repaired.indexOf("{");
  const jsonEnd = repaired.lastIndexOf("}");

  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    repaired = repaired.substring(jsonStart, jsonEnd + 1);
  }

  // More aggressive escape fixes
  repaired = repaired.replace(/\n/g, "\\n");
  repaired = repaired.replace(/\r/g, "\\r");
  repaired = repaired.replace(/\t/g, "\\t");

  // Fix common AI response issues
  repaired = repaired.replace(/\\n\\n/g, "\\n"); // Reduce double newlines

  return repairJSON(repaired);
}

/**
 * Attempts multiple strategies to parse JSON from LLM response - ENHANCED
 */
export function parseJSONSafely(text: string): {
  success: boolean;
  data?: any;
  error?: string;
} {
  // Strategy 1: Direct parse
  try {
    const data = JSON.parse(text);
    return { success: true, data };
  } catch (e1) {
    // Strategy 2: Extract and parse
    try {
      const data = extractAndParseJSON(text);
      return { success: true, data };
    } catch (e2) {
      // Strategy 3: Repair and parse
      try {
        const repaired = repairJSON(text);
        const data = JSON.parse(repaired);
        return { success: true, data };
      } catch (e3) {
        // Strategy 4: Aggressive repair
        try {
          const repaired = aggressiveRepairJSON(text);
          const data = JSON.parse(repaired);
          return { success: true, data };
        } catch (e4) {
          return {
            success: false,
            error: `Failed to parse JSON after all repair attempts: ${e4}`,
          };
        }
      }
    }
  }
}

/**
 * Validates if a JSON object has the required structure for widget content - ENHANCED
 * Supports both "html" and "htmljs" fields for compatibility with tag-based format
 */
export function validateWidgetJSON(data: any): {
  valid: boolean;
  error?: string;
} {
  if (typeof data !== "object" || data === null) {
    return { valid: false, error: "Response is not an object" };
  }

  // Accept either "html" or "htmljs" field (tag-based format uses "htmljs")
  const htmlContent = data.html || data.htmljs;

  if (!htmlContent || typeof htmlContent !== "string") {
    return {
      valid: false,
      error: 'Missing or invalid "html" or "htmljs" field',
    };
  }

  // NEW: Check HTML is not empty
  if (htmlContent.trim().length === 0) {
    return { valid: false, error: "HTML field is empty" };
  }

  // NEW: Basic HTML validation - should have at least one tag
  if (!/<[^>]+>/.test(htmlContent)) {
    return {
      valid: false,
      error: "HTML field does not contain valid HTML tags",
    };
  }

  // Normalize the data object to always have "html" field
  if (data.htmljs && !data.html) {
    data.html = data.htmljs;
  }

  if (data.css !== undefined && typeof data.css !== "string") {
    return { valid: false, error: 'Invalid "css" field type' };
  }

  return { valid: true };
}
