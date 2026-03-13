/**
 * Category mapping utilities for Google and Facebook product taxonomies
 *
 * Google Product Category Taxonomy: https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt
 * Facebook Product Category Taxonomy: https://www.facebook.com/products/categories/en_US.txt
 */

interface CategoryMapping {
  googleCategory?: string;
  googleCategoryId?: number;
  facebookCategory?: string;
  facebookCategoryId?: number;
}

/**
 * Default category mappings for common medicine/pharmacy products
 * Add your category slugs/names as keys and map them to standard taxonomies
 */
const CATEGORY_MAPPINGS: Record<string, CategoryMapping> = {
  // Health & Beauty categories
  'medicine': {
    googleCategory: 'Health & Beauty > Health Care',
    googleCategoryId: 491,
    facebookCategory: 'Health & Beauty > Health Care',
    facebookCategoryId: 5307,
  },
  'vitamins-supplements': {
    googleCategory: 'Health & Beauty > Health Care > Vitamins & Supplements',
    googleCategoryId: 5662,
    facebookCategory: 'Health & Beauty > Vitamins & Supplements',
    facebookCategoryId: 5306,
  },
  'personal-care': {
    googleCategory: 'Health & Beauty > Personal Care',
    googleCategoryId: 567,
    facebookCategory: 'Health & Beauty > Personal Care',
    facebookCategoryId: 5293,
  },
  'skin-care': {
    googleCategory: 'Health & Beauty > Personal Care > Cosmetics > Skin Care',
    googleCategoryId: 567,
    facebookCategory: 'Health & Beauty > Skin Care',
    facebookCategoryId: 5308,
  },
  'hair-care': {
    googleCategory: 'Health & Beauty > Personal Care > Hair Care',
    googleCategoryId: 2441,
    facebookCategory: 'Health & Beauty > Hair Care',
    facebookCategoryId: 5309,
  },
  'baby-care': {
    googleCategory: 'Baby & Toddler > Baby Health',
    googleCategoryId: 537,
    facebookCategory: 'Baby Products',
    facebookCategoryId: 561,
  },
  'first-aid': {
    googleCategory: 'Health & Beauty > Health Care > First Aid',
    googleCategoryId: 491,
    facebookCategory: 'Health & Beauty > Health Care',
    facebookCategoryId: 5307,
  },
  'medical-supplies': {
    googleCategory: 'Health & Beauty > Health Care > Medical Supplies',
    googleCategoryId: 491,
    facebookCategory: 'Health & Beauty > Health Care',
    facebookCategoryId: 5307,
  },
  'nutrition': {
    googleCategory: 'Food, Beverages & Tobacco > Food Items > Nutrition Bars & Drinks',
    googleCategoryId: 5742,
    facebookCategory: 'Health & Beauty > Vitamins & Supplements',
    facebookCategoryId: 5306,
  },
  'beauty-products': {
    googleCategory: 'Health & Beauty > Personal Care > Cosmetics',
    googleCategoryId: 567,
    facebookCategory: 'Health & Beauty > Beauty',
    facebookCategoryId: 5310,
  },
  'electronics': {
    googleCategory: 'Electronics',
    googleCategoryId: 222,
    facebookCategory: 'Electronics & Accessories',
    facebookCategoryId: 205,
  },
  'fitness-equipment': {
    googleCategory: 'Sporting Goods > Exercise & Fitness',
    googleCategoryId: 499713,
    facebookCategory: 'Sporting Goods > Fitness & Exercise',
    facebookCategoryId: 499,
  },
};

/**
 * Default fallback for unmapped categories
 */
const DEFAULT_CATEGORY: CategoryMapping = {
  googleCategory: 'Health & Beauty > Health Care',
  googleCategoryId: 491,
  facebookCategory: 'Health & Beauty > Health Care',
  facebookCategoryId: 5307,
};

/**
 * Get category mapping for a given category slug or name
 * Returns mappings for both Google and Facebook taxonomies
 */
export function getCategoryMapping(categorySlug: string): CategoryMapping {
  const normalized = categorySlug.toLowerCase().trim();
  return CATEGORY_MAPPINGS[normalized] || DEFAULT_CATEGORY;
}

/**
 * Get Google product category (name format)
 */
export function getGoogleCategory(categorySlug: string): string {
  const mapping = getCategoryMapping(categorySlug);
  return mapping.googleCategory || DEFAULT_CATEGORY.googleCategory!;
}

/**
 * Get Google product category (ID format)
 */
export function getGoogleCategoryId(categorySlug: string): number {
  const mapping = getCategoryMapping(categorySlug);
  return mapping.googleCategoryId || DEFAULT_CATEGORY.googleCategoryId!;
}

/**
 * Get Facebook product category (name format)
 */
export function getFacebookCategory(categorySlug: string): string {
  const mapping = getCategoryMapping(categorySlug);
  return mapping.facebookCategory || DEFAULT_CATEGORY.facebookCategory!;
}

/**
 * Get Facebook product category (ID format)
 */
export function getFacebookCategoryId(categorySlug: string): number {
  const mapping = getCategoryMapping(categorySlug);
  return mapping.facebookCategoryId || DEFAULT_CATEGORY.facebookCategoryId!;
}

/**
 * Add or update a category mapping
 * Useful for dynamically extending the mappings
 */
export function addCategoryMapping(
  categorySlug: string,
  mapping: CategoryMapping
): void {
  const normalized = categorySlug.toLowerCase().trim();
  CATEGORY_MAPPINGS[normalized] = mapping;
}

/**
 * Escape XML special characters in category names
 */
export function escapeXmlCategory(category: string): string {
  return category
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
