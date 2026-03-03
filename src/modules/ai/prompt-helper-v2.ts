/**
 * Prompt Helper V2 - Structured Messages with Caching Support
 *
 * This version returns properly structured message arrays instead of concatenated strings,
 * enabling proper prompt caching with OpenRouter/Anthropic/OpenAI.
 *
 * Key improvements:
 * - Returns structured messages array, not single string
 * - Separates static content (cacheable) from dynamic content
 * - Applies cache_control to appropriate message parts
 * - Supports multimodal vision models properly
 * - Better error handling for image dimension fetching
 */

import {
  PROMPT_INSTRUCTIONS,
  getMaxImages,
  MODEL_CAPABILITIES,
} from './ai-config';

// ============================================================================
// TYPES
// ============================================================================

interface MediaFile {
  id: string;
  url: string;
  filename: string;
  size: number;
  createdAt: Date;
}

interface ImageWithDimensions {
  filename: string;
  url: string;
  width: number;
  height: number;
  aspectRatio: string;
}

interface ProductContextData {
  id: string;
  name: string;
  description: string | null;
  price: number;
  discountType: "percentage" | "flat" | null;
  discountAmount: number | null;
  discountPercentage: number | null;
  finalPrice: number;
  slug: string;
  url: string;
  buyNowUrl: string;
  freeDelivery: boolean;
  category: { name: string; url: string } | null;
  images: { url: string; isPrimary: boolean; alt: string | null }[];
  variants: {
    id: string;
    sku: string;
    size: string | null;
    color: string | null;
    stock: number;
    price: number;
    discountType: "percentage" | "flat" | null;
    discountAmount: number | null;
    discountPercentage: number | null;
    finalPrice: number;
    buyNowUrl: string;
  }[];
  attributes: { name: string; value: string }[];
}

interface CategoryContextData {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  url: string;
  imageUrl: string | null;
}

interface MessageContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
  cache_control?: { type: "ephemeral" };
}

interface Message {
  role: "system" | "user" | "assistant";
  content: string | MessageContent[];
}

export interface StructuredPromptResult {
  messages: Message[];
  metadata: {
    hasImages: boolean;
    imageCount: number;
    productCount: number;
    categoryCount: number;
    isImprovement: boolean;
    estimatedTokens: number;
  };
}

// ============================================================================
// CACHING HELPERS
// ============================================================================

/**
 * Determines if manual cache_control breakpoints should be applied
 *
 * According to OpenRouter docs:
 * - Anthropic Claude: Requires manual cache_control breakpoints
 * - All others (OpenAI, Grok, Gemini, DeepSeek, etc.): Automatic caching, NO cache_control needed
 *
 * Adding cache_control to auto-caching models can BREAK their caching!
 */
function shouldApplyCache(content: string, modelId: string): boolean {
  // Only apply manual cache_control for Anthropic models
  const isAnthropic = modelId.includes('anthropic') || modelId.includes('claude');

  if (!isAnthropic) {
    return false; // Auto-caching models don't need cache_control
  }

  // For Anthropic: Check minimum token threshold (1024 tokens minimum)
  const estimatedTokens = Math.ceil(content.length / 4);
  return estimatedTokens >= MODEL_CAPABILITIES.minTokensForCache.anthropic;
}

// ============================================================================
// IMAGE PROCESSING (with improvements)
// ============================================================================

export async function getImageDimensions(
  url: string,
  timeoutMs = 5000
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timeout = setTimeout(() => {
      reject(new Error(`Image load timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    img.onload = function () {
      clearTimeout(timeout);
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    };

    img.onerror = function () {
      clearTimeout(timeout);
      reject(new Error("Failed to load image"));
    };

    img.src = url;
  });
}

function calculateAspectRatio(width: number, height: number): string {
  if (width === 0 || height === 0) return "Unknown";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  const ratioWidth = width / divisor;
  const ratioHeight = height / divisor;

  // Common aspect ratios
  const ratios: Record<string, string> = {
    "16:9": "16:9 (Widescreen)",
    "4:3": "4:3 (Standard)",
    "1:1": "1:1 (Square)",
    "3:2": "3:2 (Photo)",
    "21:9": "21:9 (Ultrawide)",
    "9:16": "9:16 (Portrait)",
  };

  const key = `${ratioWidth}:${ratioHeight}`;
  return ratios[key] || key;
}

export async function processImagesWithDimensions(
  images: MediaFile[],
  timeoutMs = 5000
): Promise<ImageWithDimensions[]> {
  const imagePromises = images.map(async (img) => {
    try {
      const dimensions = await getImageDimensions(img.url, timeoutMs);
      const aspectRatio = calculateAspectRatio(dimensions.width, dimensions.height);
      return {
        filename: img.filename,
        url: img.url,
        width: dimensions.width,
        height: dimensions.height,
        aspectRatio,
      };
    } catch (error) {
      console.warn(`Failed to get dimensions for ${img.filename}:`, error);
      // Return fallback instead of failing completely
      return {
        filename: img.filename,
        url: img.url,
        width: 0,
        height: 0,
        aspectRatio: "Unknown",
      };
    }
  });

  return Promise.all(imagePromises);
}

// ============================================================================
// CONTEXT FORMATTERS
// ============================================================================

function generateImageContext(imagesWithDimensions: ImageWithDimensions[]): string {
  if (imagesWithDimensions.length === 0) return "";

  const imageDescriptions = imagesWithDimensions
    .filter((img) => img.width > 0 && img.height > 0) // Skip failed dimensions
    .map((img, index) => {
      return `${index + 1}. ${img.filename}: ${img.url}\n   - Dimensions: ${img.width}×${img.height}px (${img.aspectRatio})`;
    });

  if (imageDescriptions.length === 0) {
    // All images failed dimension fetch, still include URLs
    return `\n\nIMAGES TO USE:\n${imagesWithDimensions.map((img, i) => `${i + 1}. ${img.filename}: ${img.url}`).join("\n")}\n\nPlease use these specific image URLs in your HTML code where appropriate.`;
  }

  return `\n\nIMAGES TO USE:\n${imageDescriptions.join("\n\n")}\n\nPlease use these specific image URLs in your HTML code where appropriate.`;
}

function generateProductContext(products: ProductContextData[]): string {
  if (products.length === 0) return "";

  const productDescriptions = products.map((p, index) => {
    let context = `${index + 1}. Product: ${p.name}
   - Product ID: ${p.id}
   - URL: ${p.url}
   - Buy Now URL: ${p.buyNowUrl}
   - Description: ${p.description || "Not provided."}
   - Base Price: ${p.price}`;

    // Add discount information if present
    if (p.discountType && (p.discountAmount || p.discountPercentage)) {
      if (p.discountType === "percentage" && p.discountPercentage) {
        context += `\n   - Discount: ${p.discountPercentage}% off`;
      } else if (p.discountType === "flat" && p.discountAmount) {
        context += `\n   - Discount: ${p.discountAmount} flat discount`;
      }
      context += `\n   - Final Price: ${p.finalPrice}`;
    } else {
      context += `\n   - Final Price: ${p.finalPrice} (No discount)`;
    }

    if (p.freeDelivery) {
      context += `\n   - Free Delivery: Yes`;
    }

    if (p.category) {
      context += `\n   - Category: ${p.category.name} (${p.category.url})`;
    }

    if (p.images && p.images.length > 0) {
      context += `\n   - Images:\n` + p.images.map((img) => `     - ${img.url} ${img.isPrimary ? "(Primary)" : ""}`).join("\n");
    }

    if (p.variants && p.variants.length > 0) {
      context += `\n   - Variants:\n` + p.variants.map((v) => {
        let variantLine = `     - SKU: ${v.sku}, Size: ${v.size || "N/A"}, Color: ${v.color || "N/A"}, Stock: ${v.stock}, Base Price: ${v.price}`;
        if (v.discountType && (v.discountAmount || v.discountPercentage)) {
          if (v.discountType === "percentage" && v.discountPercentage) {
            variantLine += `, Discount: ${v.discountPercentage}% off`;
          } else if (v.discountType === "flat" && v.discountAmount) {
            variantLine += `, Discount: ${v.discountAmount} flat`;
          }
          variantLine += `, Final Price: ${v.finalPrice}`;
        } else {
          variantLine += `, Final Price: ${v.finalPrice}`;
        }
        variantLine += `, Buy Now URL: ${v.buyNowUrl}`;
        return variantLine;
      }).join("\n");
    }

    if (p.attributes && p.attributes.length > 0) {
      context += `\n   - Attributes:\n` + p.attributes.map((attr) => `     - ${attr.name}: ${attr.value}`).join("\n");
    }

    return context;
  }).join("\n\n");

  return `\n\nPRODUCT CONTEXT:\nHere are the details for the products to be used:\n${productDescriptions}`;
}

function generateCategoryContext(
  categories: CategoryContextData[],
  allCategories: boolean
): string {
  if (categories.length === 0) return "";

  const header = allCategories
    ? "ALL CATEGORIES CONTEXT:\nBelow are all the available product categories in the store:"
    : "CATEGORY CONTEXT:\nHere are the details for the categories to be used:";

  const categoryDescriptions = categories.map((c) => {
    let details = `- Name: ${c.name}\n  - URL: ${c.url}`;
    if (c.description) {
      details += `\n  - Description: ${c.description}`;
    }
    if (c.imageUrl) {
      details += `\n  - Image: ${c.imageUrl}`;
    }
    return details;
  }).join("\n");

  return `\n\n${header}\n${categoryDescriptions}`;
}

// ============================================================================
// MULTIMODAL SUPPORT
// ============================================================================

/**
 * Prepare images for multimodal models
 * Returns an array of image content objects compatible with OpenRouter's vision API
 */
export function prepareImagesForMultimodal(
  images: MediaFile[],
  modelId: string
): Array<{ type: "image_url"; image_url: { url: string } }> {
  const maxImages = getMaxImages(modelId);
  const imagesToUse = images.slice(0, maxImages);

  if (images.length > maxImages) {
    console.warn(`Model ${modelId} supports max ${maxImages} images. Using first ${maxImages} of ${images.length}.`);
  }

  return imagesToUse.map(img => ({
    type: "image_url" as const,
    image_url: {
      url: img.url
    }
  }));
}

// ============================================================================
// MAIN FUNCTION: Generate Structured Prompt Messages
// ============================================================================

export async function generateStructuredPrompt({
  systemPrompt,
  userPrompt,
  improvementPrompt,
  existingHtml,
  existingCss,
  selectedImages,
  selectedProducts,
  selectedCategories,
  allCategoriesSelected,
  modelId,
  supportsVision,
  sectionIndex,
  totalSections,
}: {
  systemPrompt: string;
  userPrompt?: string;
  improvementPrompt?: string;
  existingHtml?: string | null;
  existingCss?: string | null;
  selectedImages: MediaFile[];
  selectedProducts: ProductContextData[];
  selectedCategories: CategoryContextData[];
  allCategoriesSelected: boolean;
  modelId: string;
  supportsVision: boolean;
  sectionIndex?: number;
  totalSections?: number;
}): Promise<StructuredPromptResult> {
  // Collect ALL images from selected, products, and categories
  const allImageUrls: string[] = [];

  // 1. Selected images
  selectedImages.forEach(img => allImageUrls.push(img.url));

  // 2. Product images
  selectedProducts.forEach(product => {
    if (product.images && product.images.length > 0) {
      product.images.forEach(img => allImageUrls.push(img.url));
    }
  });

  // 3. Category images
  selectedCategories.forEach(category => {
    if (category.imageUrl) {
      allImageUrls.push(category.imageUrl);
    }
  });

  // Process ALL images for dimensions (for text context)
  let imageContext = "";
  const multimodalImages: MessageContent[] = [];

  if (allImageUrls.length > 0) {
    // Convert URLs to MediaFile format for dimension processing
    const allImageFiles: MediaFile[] = allImageUrls.map((url, index) => ({
      id: `img-${index}`,
      filename: `image-${index + 1}.jpg`,
      url: url,
      size: 0, // Size not needed for dimension fetching
      createdAt: new Date()
    }));

    const imagesWithDimensions = await processImagesWithDimensions(allImageFiles);
    imageContext = generateImageContext(imagesWithDimensions);
  }

  // If model supports vision, send ALL images as native multimodal
  if (supportsVision && allImageUrls.length > 0) {
    const maxImages = getMaxImages(modelId);
    const imagesToSend = allImageUrls.slice(0, maxImages);

    if (allImageUrls.length > maxImages) {
      console.warn(`Model ${modelId} supports max ${maxImages} images. Sending first ${maxImages} of ${allImageUrls.length} total images.`);
    }

    imagesToSend.forEach(url => {
      multimodalImages.push({
        type: "image_url" as const,
        image_url: { url }
      });
    });
  }

  // Generate product and category context (includes text descriptions + URLs)
  const productContext = generateProductContext(selectedProducts);
  const categoryContext = generateCategoryContext(selectedCategories, allCategoriesSelected);

  // Build static context (cacheable)
  let staticContext = systemPrompt;
  staticContext += `\n\n${PROMPT_INSTRUCTIONS.json}`;
  staticContext += `\n${PROMPT_INSTRUCTIONS.buyNow}`;

  if (improvementPrompt) {
    staticContext += `\n${PROMPT_INSTRUCTIONS.improvement}`;
  }

  if (sectionIndex !== undefined && totalSections !== undefined) {
    staticContext += `\n${PROMPT_INSTRUCTIONS.sectionSpecific(sectionIndex, totalSections)}`;
  }

  // Add context data (also static/cacheable)
  if (productContext) staticContext += productContext;
  if (categoryContext) staticContext += categoryContext;
  if (imageContext) staticContext += imageContext;

  // Build dynamic user request (NOT cacheable)
  let dynamicRequest = "";

  if (improvementPrompt && (existingHtml || existingCss)) {
    // Improvement flow
    dynamicRequest = "\n\nEXISTING CODE TO IMPROVE:\nThis is the current code that you need to modify based on my request.";
    if (existingHtml) {
      dynamicRequest += `\n\n\`\`\`html\n${existingHtml}\n\`\`\``;
    }
    if (existingCss) {
      dynamicRequest += `\n\n\`\`\`css\n${existingCss}\n\`\`\``;
    }
    dynamicRequest += `\n\nIMPROVEMENT REQUEST:\n${improvementPrompt.trim()}`;
  } else if (userPrompt) {
    // Creation flow
    dynamicRequest = `\n\nUSER REQUEST:\n${userPrompt.trim()}`;
  }

  // Construct messages array with proper caching
  const messages: Message[] = [];

  // Determine if caching should be applied based on content size and provider
  const shouldCache = shouldApplyCache(staticContext, modelId);

  if (supportsVision && multimodalImages.length > 0) {
    // Multimodal mode: user message with mixed content
    const userContent: MessageContent[] = [
      {
        type: "text",
        text: staticContext,
        ...(shouldCache ? { cache_control: { type: "ephemeral" as const } } : {}) // Conditionally cache
      },
      ...multimodalImages, // Add images
      {
        type: "text",
        text: dynamicRequest // Dynamic request at the end
      }
    ];

    messages.push({
      role: "user",
      content: userContent
    });
  } else {
    // Text-only mode: simple message structure
    const userContent: MessageContent[] = [
      {
        type: "text",
        text: staticContext,
        ...(shouldCache ? { cache_control: { type: "ephemeral" as const } } : {}) // Conditionally cache
      },
      {
        type: "text",
        text: dynamicRequest // Dynamic request
      }
    ];

    messages.push({
      role: "user",
      content: userContent
    });
  }

  // Calculate metadata
  const estimatedTokens = Math.ceil((staticContext.length + dynamicRequest.length) / 4); // Rough estimate: 4 chars = 1 token

  return {
    messages,
    metadata: {
      hasImages: selectedImages.length > 0,
      imageCount: selectedImages.length,
      productCount: selectedProducts.length,
      categoryCount: selectedCategories.length,
      isImprovement: !!improvementPrompt,
      estimatedTokens,
    }
  };
}

// ============================================================================
// BACKWARD COMPATIBILITY: Legacy String-Based Prompt
// ============================================================================

/**
 * Legacy function that returns a single string prompt (for backward compatibility)
 * New code should use generateStructuredPrompt instead
 */
export async function generateCompletePrompt({
  systemPrompt,
  userPrompt,
  improvementPrompt,
  existingHtml,
  existingCss,
  selectedImages,
  selectedProducts,
  selectedCategories,
  allCategoriesSelected,
}: {
  systemPrompt: string;
  userPrompt?: string;
  improvementPrompt?: string;
  existingHtml?: string | null;
  existingCss?: string | null;
  selectedImages: MediaFile[];
  selectedProducts: ProductContextData[];
  selectedCategories: CategoryContextData[];
  allCategoriesSelected: boolean;
}): Promise<string> {
  const result = await generateStructuredPrompt({
    systemPrompt,
    userPrompt,
    improvementPrompt,
    existingHtml,
    existingCss,
    selectedImages,
    selectedProducts,
    selectedCategories,
    allCategoriesSelected,
    modelId: "default",
    supportsVision: false,
    sectionIndex: undefined,
    totalSections: undefined,
  });

  // Flatten messages to single string
  return result.messages.map(msg => {
    if (typeof msg.content === 'string') {
      return msg.content;
    } else {
      return msg.content.map(c => c.type === 'text' ? c.text : `[Image: ${c.image_url?.url}]`).join('\n');
    }
  }).join('\n\n');
}
