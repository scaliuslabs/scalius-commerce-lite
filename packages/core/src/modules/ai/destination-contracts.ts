import type { AiPromptType } from "./default-prompts";

export interface WidgetCompositionPlan {
  totalSections: number;
  sectionDescriptions: string[];
  compositionBrief: string;
  sharedDesignSystem: string;
  spacingStrategy: string;
  sectionContinuity: string[];
  estimatedTokens?: number;
}

const DESTINATION_COMPOSITION_BLUEPRINTS: Record<
  AiPromptType,
  {
    totalSections: number;
    compositionBrief: string;
    sections: string[];
    designSystem: string;
    spacing: string;
  }
> = {
  widget: {
    totalSections: 2,
    compositionBrief:
      "One fast homepage merchandising module that opens with a clear store/category signal and closes with compact discovery/action support.",
    sections: [
      "Compact opening band with the strongest merchandising signal, one primary CTA, and restrained visual weight",
      "Discovery/support band for selected products, categories, collections, trust cues, or a final action without landing-page length",
    ],
    designSystem:
      "Reusable homepage rhythm: medium density, strong hierarchy, compact cards, consistent CTA style, and lightweight visual transitions.",
    spacing:
      "Keep the root compact; bands share background tokens or tight dividers and use internal padding instead of external margins.",
  },
  "landing-page": {
    totalSections: 5,
    compositionBrief:
      "One continuous campaign section set that sells a specific offer, audience promise, product line, or collection inside the existing storefront shell.",
    sections: [
      "Campaign hero/offer with a specific promise and primary CTA",
      "Product or collection showcase that makes the offer concrete",
      "Benefits, proof, or use-case explanation that supports the choice without invented claims",
      "Objection handling, urgency, trust, or comparison content tied to provided facts",
      "Final conversion CTA that closes the campaign stronger than the opening",
    ],
    designSystem:
      "Campaign art direction: stronger narrative hierarchy, repeated but restrained CTA language, cohesive product/media treatment, and a clear conversion progression.",
    spacing:
      "Make sections read as one page story with connected backgrounds/dividers; no disconnected cards, spacer bands, or full-viewport gaps.",
  },
  collection: {
    totalSections: 3,
    compositionBrief:
      "One practical collection merchandising flow that introduces the collection, helps shoppers compare products, and ends with a tight trust/action strip.",
    sections: [
      "Collection intro with the shopper promise and compact navigation/filter-like cues",
      "Product grid, comparison, buying guide, or shop-by-need layout using provided product facts prominently",
      "Tight trust/action strip that supports selection without broad campaign storytelling",
    ],
    designSystem:
      "Commerce-first system: dense scan layout, prominent price/link hierarchy, stable product cards, restrained copy, and practical comparison affordances.",
    spacing:
      "Keep vertical rhythm tight for collection browsing; product content should dominate and adjacent blocks should connect without whitespace gaps.",
  },
};

export const WIDGET_DESTINATION_RUNTIME_CONTRACTS: Record<AiPromptType, string> = {
  widget: `SERVER DESTINATION CONTRACT: Homepage Widget
- Generate a compact insertable homepage module, usually 1-2 connected bands inside one root wrapper.
- Prioritize store/category signal, featured picks/categories, simple discovery paths, trust cues, and a light action close.
- If the merchant asks for a "homepage collection section", produce a homepage collection-feature module using selected products/categories, not a full collection-page merchandising flow.
- Use homepage density: strong scanning and medium visual weight, not a full-page campaign.
- Avoid full campaign funnels, long proof stacks, FAQ blocks, oversized heroes, dense comparison tables, and large external gaps.`,
  "landing-page": `SERVER DESTINATION CONTRACT: Landing Section
- Generate one connected campaign section set inside the existing storefront shell and one root wrapper.
- Use a deliberate conversion flow: promise/offer, product/collection support, proof or benefits, objection handling, trust/urgency, and final CTA.
- Use landing-page density: more narrative and persuasive than a homepage widget, with repeated CTAs only where they advance conversion.
- Do not collapse into a generic product grid or homepage discovery banner unless the merchant explicitly asks.`,
  collection: `SERVER DESTINATION CONTRACT: Collection Section
- Generate practical collection merchandising inside one root wrapper, not a generic homepage banner or campaign microsite.
- Use this only for collection-page placements or the explicit Collection Section goal; do not override Homepage Widget just because the merchant used the word "collection" in a homepage request.
- Product comparison, product cards, buying-guide cues, prices/links supplied in context, and scan-first density are the priority.
- At least half of the meaningful content should help shoppers compare or choose products.
- Keep hero treatment restrained and make product facts more prominent than decorative copy.`,
};

export function createWidgetCompositionPlan(promptType: AiPromptType): WidgetCompositionPlan {
  const blueprint = DESTINATION_COMPOSITION_BLUEPRINTS[promptType];

  return {
    totalSections: blueprint.totalSections,
    sectionDescriptions: blueprint.sections,
    compositionBrief: blueprint.compositionBrief,
    sharedDesignSystem: blueprint.designSystem,
    spacingStrategy: blueprint.spacing,
    sectionContinuity: blueprint.sections.map((section, index) =>
      index === 0
        ? `${section}; establish the shared design system and hand off naturally to the next band.`
        : `${section}; continue the prior band's palette, typography, spacing rhythm, and CTA treatment without outer gaps.`,
    ),
  };
}

export function describeWidgetCompositionPlan(plan: WidgetCompositionPlan): string {
  return [
    `Complete composition: ${plan.compositionBrief}`,
    `Shared design system: ${plan.sharedDesignSystem}`,
    `Spacing strategy: ${plan.spacingStrategy}`,
    "Expected flow:",
    ...plan.sectionDescriptions.map(
      (description, index) =>
        `${index + 1}. ${description} Continuity: ${plan.sectionContinuity[index]}`,
    ),
  ].join("\n");
}

export function createWidgetCompositionContract(promptType: AiPromptType): string {
  const plan = createWidgetCompositionPlan(promptType);

  return `SERVER COMPOSITION BLUEPRINT:
${describeWidgetCompositionPlan(plan)}

SINGLE-PASS COMPOSITION RULES:
- Think through the full composition internally, then return one complete <htmljs> and <css> artifact.
- Return content markup only. The platform adds the runtime wrapper, so do not use widget-container, cms-widget-frame, widget-placement-zone, data-scalius-widget-root, or data-widget-id in HTML.
- Use one destination-specific top-level composition element or section with your own classes.
- If the output has multiple visual bands, they must be children of the same root and must look like one connected composition, not separate widgets.
- Keep generated CSS compact, scoped, and purposeful. Avoid repeated card systems, giant min-heights, viewport-height filler, spacer divs, oversized margins, and dead vertical gaps.
- Product/media imagery must live inside bounded cards or bounded media columns with explicit aspect-ratio/max-height and object-fit: contain or cover. Never create a large empty white media panel, never crop a product off-canvas, and never rely on absolute-positioned product images for core layout.
- Every generated visual band must contain meaningful visible content above the fold at desktop and mobile widths; no blank columns, blank rows, decorative whitespace blocks, or image-only voids.
- Homepage widgets should remain compact; landing sections should be campaign-like; collection sections should be product-comparison led.`;
}
