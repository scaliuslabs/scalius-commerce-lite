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

/**
 * Generate SKU from template and variant data
 *
 * Supported placeholders:
 * - {SLUG}: Product slug (uppercase)
 * - {SIZE}: Variant size (uppercase)
 * - {COLOR}: Variant color (uppercase)
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
  sku = sku.replace(/{SLUG}/g, (data.slug || "PRODUCT").toUpperCase());
  sku = sku.replace(/{SIZE}/g, (data.size || "").toUpperCase());
  sku = sku.replace(/{COLOR}/g, (data.color || "").toUpperCase());
  sku = sku.replace(/{RANDOM}/g, generateRandomString());

  if (data.index !== undefined) {
    sku = sku.replace(/{INDEX}/g, String(data.index).padStart(3, "0"));
  }

  // Clean up any double dashes or trailing/leading dashes
  sku = sku.replace(/--+/g, "-").replace(/^-|-$/g, "");

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
