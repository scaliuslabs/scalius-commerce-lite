// src/components/admin/ProductForm/variants/utils/skuGenerator.ts

/**
 * Generate a random alphanumeric string
 */
function generateRandomString(length: number = 4): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function normalizeSkuSegment(value?: string | null): string {
  return (value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Generate SKU from template and variant data
 *
 * Supported placeholders:
 * - {SLUG}: Product slug (uppercase)
 * - {OPTION1}: First option value (uppercase), such as size or weight
 * - {OPTION2}: Second option value (uppercase), such as color or style
 * - {SIZE}: Legacy alias for {OPTION1}
 * - {COLOR}: Legacy alias for {OPTION2}
 * - {RANDOM}: Random 4-char string
 * - {INDEX}: Sequential number (001, 002, etc.)
 */
export function generateSku(
  template: string,
  data: {
    slug?: string;
    size?: string | null;
    color?: string | null;
    index?: number;
  }
): string {
  let sku = template;

  // Replace placeholders
  sku = sku.replace(/{SLUG}/g, normalizeSkuSegment(data.slug || "PRODUCT"));
  sku = sku.replace(/{OPTION1}|{SIZE}/g, normalizeSkuSegment(data.size));
  sku = sku.replace(/{OPTION2}|{COLOR}/g, normalizeSkuSegment(data.color));
  sku = sku.replace(/{RANDOM}/g, generateRandomString());

  if (data.index !== undefined) {
    sku = sku.replace(/{INDEX}/g, String(data.index).padStart(3, "0"));
  }

  // Clean up any double dashes or trailing/leading dashes
  sku = sku.replace(/--+/g, "-").replace(/^-+|-+$/g, "");

  return sku;
}

/**
 * Generate SKUs for bulk variants using template
 */
export function generateBulkSkus(
  template: string,
  variants: Array<{ size: string | null; color: string | null }>,
  productSlug?: string
): string[] {
  return variants.map((variant, index) =>
    generateSku(template, {
      slug: productSlug,
      size: variant.size,
      color: variant.color,
      index: index + 1,
    })
  );
}

/**
 * Validate SKU template
 */
export function validateSkuTemplate(template: string): {
  valid: boolean;
  error?: string;
} {
  if (!template || template.trim().length === 0) {
    return { valid: false, error: "Template cannot be empty" };
  }

  if (template.length > 100) {
    return { valid: false, error: "Template is too long (max 100 characters)" };
  }

  // Check for invalid characters
  const invalidChars = /[^a-zA-Z0-9\-_{}]/;
  if (invalidChars.test(template)) {
    return {
      valid: false,
      error: "Template contains invalid characters. Use only letters, numbers, -, _, and {}",
    };
  }

  const allowedVariables = new Set([
    "SLUG",
    "OPTION1",
    "OPTION2",
    "SIZE",
    "COLOR",
    "RANDOM",
    "INDEX",
  ]);
  const unknownVariables = parseSkuTemplate(template).filter(
    (variable) => !allowedVariables.has(variable.toUpperCase()),
  );
  if (unknownVariables.length > 0) {
    return {
      valid: false,
      error: `Unknown SKU variable: ${unknownVariables[0]}`,
    };
  }

  return { valid: true };
}

/**
 * Get example SKU from template
 */
export function getSkuExample(template: string, productSlug?: string): string {
  return generateSku(template, {
    slug: productSlug || "product-name",
    size: "XL",
    color: "RED",
    index: 1,
  });
}

/**
 * Parse SKU template to extract variables
 */
export function parseSkuTemplate(template: string): string[] {
  const matches = template.match(/{([^}]+)}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}
