# Merchant Builder UX Patterns

Date: 2026-05-13

Scope: research patterns from leading merchant, page-builder, and AI-builder systems, then translate them into UX and prompt-flow improvements for the Scalius admin widget create/edit flow. This document is advisory only; no source code changes are included.

## Executive Summary

Scalius should present widget generation as a commerce-aware section builder, not as a generic AI HTML box. The strongest external pattern is a three-part loop:

1. Choose a destination and intent before generation.
2. Generate an editable section/page structure using real store context.
3. Preview, refine, and apply changes progressively with merchant-safe controls.

The key product distinction for Scalius is destination. A homepage widget should feel like a reusable merchandising section placed into homepage zones. A landing-page request should feel like a campaign funnel with multiple sections, even if the current save target is still a widget or page-scoped placement. A collection section should feel like merchandising assistance around a collection grid, with product/category constraints and buying intent prioritized over decorative storytelling.

## Source Patterns

### Shopify: Templates, Sections, Blocks

Sources:

- [Shopify Help: Sections and blocks](https://help.shopify.com/en/manual/online-store/themes/theme-structure/sections-and-blocks)
- [Shopify Help: Theme editor features overview](https://help.shopify.com/en/manual/online-store/themes/customizing-themes/theme-editor/features-overview)
- [Shopify Dev: Building with sections and blocks](https://shopify.dev/docs/storefronts/themes/best-practices/templates-sections-blocks)

Relevant patterns:

- Shopify anchors merchant editing around templates, sections, and blocks. The homepage loads by default, but merchants can switch templates for products, collections, pages, and blogs.
- The editor sidebar is a tree of current template content. Merchants can add, edit, duplicate, hide, delete, reorder, and rename sections or blocks.
- Section and block availability is contextual. Some blocks are restricted to certain section types, and required/conditional blocks can appear automatically.
- Preview is not secondary. Shopify updates the preview as edits happen and gives explicit desktop/mobile preview controls.
- Settings are scoped. Global theme settings are separate from section/block settings, and conditional settings appear only when relevant.
- Shopify recommends grouping settings into blocks to declutter the editor sidebar and using sections when merchants need to add, remove, reorder, or control a whole section layout.

Scalius implication:

- The widget form should ask "where is this going?" before "what should AI make?" Destination should control prompt defaults, available context pickers, placement controls, preview frame, and generated structure.
- Generated output should become normal editable widget structure with section/block-level controls, not an opaque blob that can only be regenerated.

### Webflow: Prompt To Site, Then Structure And Style

Source:

- [Webflow AI Site Builder](https://webflow.com/ai-site-builder)

Relevant patterns:

- Webflow positions AI as a fast start, not the final act: describe the vision, get a ready-to-edit draft, add/remove/reorder sections and pages, customize site-wide style, then refine in the full editor.
- The product promise includes a foundational design system, not merely a layout.
- The prompt flow asks what the user is building and who it is for.
- Webflow emphasizes a multi-page foundation and reusable design system as markers of a strong AI site builder.
- AI can continue helping after initial generation: new pages, CMS collection items, SEO/AEO optimization, and editor assistance.

Scalius implication:

- Staged generation should expose progress as outline -> section drafts -> final composition, with merchant checkpoints for broad requests.
- Widget AI should inherit store design tokens and site settings, then report what it used: products, categories, tone, colors, images, offer, CTA, and destination.

### Builder.io: Page Models Versus Section Models

Sources:

- [Builder.io Page Models](https://www.builder.io/c/docs/models-pages)
- [Builder.io Section Models](https://www.builder.io/c/docs/models-sections)
- [Builder.io Editing and Previewing Your Site](https://www.builder.io/c/docs/guides/preview-url)
- [Builder.io Input Types](https://www.builder.io/c/docs/input-types)
- [Builder.io AI](https://site.builder.io/ai)
- [Builder.io: How Builder Uses AI](https://www.builder.io/c/docs/ai-use)

Relevant patterns:

- Builder separates Page models from Section models. Pages require URLs and commonly represent homepage, content pages, marketing pages, and landing pages. Sections represent a portion of a page such as announcement bars, collection-page marketing sections, heroes, or blog content.
- Sections are useful for targeting, scheduling, testing, and inserting content in the right place at the right time.
- Preview URLs work across Page, Section, and Data models, including local, temporary, and persistent preview modes.
- Builder exposes structured input types for fields, including booleans, colors, dates, enums, file pickers, lists, objects, references, rich text, URLs, JSON, and advanced fields.
- Builder's AI messaging stresses alignment with existing frameworks, design tokens, and components.
- Builder documents what prompt/content data is sent during AI generation and editing, which helps set user expectations and privacy boundaries.

Scalius implication:

- The admin should stop treating homepage widgets, landing-page sections, and collection sections as the same job with different prompt text.
- If saving as a full page is not ready, label landing generation honestly as "campaign section set" or "landing page draft sections" and show where it will be placed.
- Collection sections should support targeting/query-like controls: collection, category, product subset, placement slot, schedule/status, and preview URL/context.

### v0: Prompt For Structure, Design Mode For Visual Tweaks

Sources:

- [v0 Docs: What is v0?](https://v0.app/docs)
- [Vercel Blog: How to prompt v0](https://vercel.com/blog/how-to-prompt-v0)

Relevant patterns:

- v0 lets users describe ideas in natural language and generate UIs, prototypes, landing pages, dashboards, ecommerce stores, and full-stack apps.
- v0's iteration guidance separates prompt changes from direct design changes: prompts are better for logic, features, and structure; design mode is better for colors, spacing, typography, and quick visual tweaks.
- v0 supports generating from preferred language, wireframes, or mockups, then refining and deploying/reviewing.

Scalius implication:

- The widget editor needs two refinement modes after generation:
  - Prompt refinement for structure, content, product selection, CTA, and funnel changes.
  - Direct controls for visual tweaks such as density, spacing, color treatment, image shape, alignment, and mobile stacking.

## Destination-Specific Expectations

### Homepage Widget

Merchant expectation:

- "Add something useful to my home page" rather than "build a whole page."
- Should use broad discovery, seasonal offer, trust, best sellers, categories, or new arrivals.
- Should fit around existing homepage sections and not assume it owns the whole page.

Recommended controls:

- Destination: Homepage.
- Slot: top, content, bottom, or future named homepage zone.
- Intent preset: hero offer, featured categories, best sellers, new arrivals, trust/social proof, promo banner, editorial/product story.
- Context chips: selected products, categories, media, current discount, brand tone.
- CTA mode: shop collection, view product, buy now, learn more.
- Density: compact, balanced, rich.
- Preview: homepage frame with surrounding sections or at least homepage-width context, plus mobile.

Prompt-flow changes:

- System prompt should instruct: generate one reusable homepage section, not a full page; avoid duplicating header/footer; use selected products if provided; keep vertical rhythm compact; include one clear primary action.
- If the merchant asks for a "homepage", clarify whether they want a single homepage section or a multi-section homepage refresh. Default to single section unless staged generation is selected.

### Landing Page / Campaign Section

Merchant expectation:

- "Create a campaign page/funnel" with narrative flow, not just one decorative block.
- Should include offer framing, product evidence, benefits, social proof/trust, urgency, FAQ, and conversion actions where relevant.
- Needs a page URL eventually. If Scalius cannot yet save full pages from the widget flow, the UI should not imply it can.

Recommended controls:

- Destination: Landing/campaign.
- Save target: page-scoped placement, shortcode/manual, or future "new page" flow.
- Campaign goal: product launch, sale, lead capture, bundle, seasonal event, brand story.
- Funnel outline: hero, proof, featured products, benefits, offer/urgency, FAQ, final CTA.
- Conversion action: buy now, shop collection, sign up, contact, claim offer.
- Offer fields: discount, deadline, coupon code, free shipping threshold.
- Audience/tone: new customers, returning customers, premium, budget, gift, local.
- Preview: stitched section set with visible boundaries and mobile review.

Prompt-flow changes:

- Staged generation should first return an editable outline. The merchant can remove/reorder sections before spending generation time on each section.
- Each generated section should receive previous-section context and the whole outline to avoid repetition.
- The final merge should preserve section identity so the merchant can refine "benefits section only" or "FAQ copy only."

### Collection Section

Merchant expectation:

- "Improve merchandising around this collection" without breaking the product grid.
- Should be practical: explain the category, highlight filters/use cases, promote best sellers, show trust/returns/shipping, compare product types, or surface bundles.
- Must respect the selected collection/category and should not invent products.

Recommended controls:

- Destination: Collection section.
- Collection/category selector is required.
- Slot: above grid, below intro, between product rows, below grid, sidebar/filter-adjacent if supported later.
- Product source: use collection products, selected products, best sellers, sale items, new arrivals, in-stock only.
- Intent preset: collection intro, buying guide, comparison, bundle promo, trust strip, seasonal offer, FAQ.
- Constraints: max products shown, price visibility, inventory/availability language, avoid out-of-stock, currency/locale.
- Preview: collection page frame with product grid placeholder or real collection products.

Prompt-flow changes:

- The prompt should identify the collection as the primary context and selected products as a constrained subset, not generic inspiration.
- The model should be told not to create fake SKUs, prices, discounts, reviews, availability, shipping promises, or category claims.
- Generated CTAs should link only to allowed collection/product URLs from the server-owned commerce manifest.

## Recommended Admin Flow

### 1. Start With Destination

Replace a single open-ended AI card with a compact flow:

1. Destination: Homepage, Landing/campaign, Collection, Reusable shortcode.
2. Intent preset: destination-specific.
3. Store context: products, categories, collection, media, offer, brand tone.
4. Generation mode: quick section, variants, staged section set.
5. Preview and refine.
6. Save placement/status.

This reduces prompt burden and gives the server a clean request contract.

### 2. Use Progressive Generation

Recommended generation levels:

- Quick generate: one section from selected destination/context.
- Generate variants: 2-4 alternatives for broad homepage or campaign requests.
- Staged generate: outline first, then section-by-section generation with progress.
- Improve selected: targeted rewrite of one section, element, copy block, CTA, product list, or mobile layout.

Merchant-facing progress labels:

- Reading store context.
- Drafting section outline.
- Generating hero/intro.
- Generating product proof.
- Checking links and images.
- Preparing preview.

Avoid showing raw model text as the primary progress surface.

### 3. Split AI Prompting From Merchant Controls

Prompt input should be optional and contextual, not the main UI. Controls should capture the common constraints:

- Destination.
- Business goal.
- Audience.
- Tone.
- Products/categories/collection/media.
- Offer/deadline.
- CTA.
- Layout density.
- Color treatment.
- Image style.
- Mobile priority.

The freeform prompt becomes "Additional instructions", with examples that match the destination.

### 4. Make Preview Real

Preview should answer "what will shoppers see here?"

Minimum:

- Desktop/tablet/mobile toggles.
- Destination frame label: Homepage, Landing draft, Collection.
- Placement slot label.
- Selected commerce context chips.
- Warnings for missing products, missing images, unsafe links removed, unsupported forms/scripts removed.
- Before/after preview when improving existing content.

Better:

- Homepage preview with nearby zones.
- Collection preview with real product grid context.
- Landing preview as a stitched multi-section draft with section navigator.

### 5. Keep Generated Content Editable

After generation, the editor should expose:

- Section outline/tree.
- Per-section rename, duplicate, hide, delete, reorder.
- Per-section settings: layout, spacing, background, media ratio, product count, CTA.
- Copy fields for headline, eyebrow, body, CTA label.
- Product/media pickers for generated references.
- Advanced fields collapsed by default.

This mirrors Shopify/Builder patterns and reduces the need to regenerate for small edits.

## Prompt Contract Improvements

Move toward a server-owned request shape:

```json
{
  "operation": "generate_section | generate_variants | generate_staged | improve_selected",
  "destination": "homepage | landing | collection | reusable",
  "intent": "best_sellers | campaign_offer | buying_guide | hero | trust_strip",
  "placement": {
    "scope": "homepage | page | collection",
    "slot": "top | content | bottom | above_grid | below_grid"
  },
  "merchantBrief": "Additional instructions from the merchant",
  "contextIds": {
    "productIds": [],
    "categoryIds": [],
    "collectionIds": [],
    "imageIds": []
  },
  "controls": {
    "tone": "premium | friendly | urgent | minimal",
    "density": "compact | balanced | rich",
    "ctaMode": "shop_collection | view_product | buy_now | learn_more",
    "sections": 1
  }
}
```

Server prompt assembly should then:

- Resolve commerce context server-side.
- Serialize untrusted catalog facts inside bounded data blocks.
- Add destination-specific rules.
- Add allowed URL/media manifest.
- Require structured output or tag-format fallback.
- Validate and sanitize before returning preview content.

## Concrete UX Backlog

Priority 1:

- Add destination-first generation tabs: Homepage, Landing/campaign, Collection, Reusable.
- Make destination change the intent presets, required fields, and default system prompt.
- Label landing output honestly as "landing section set" until full page creation exists.
- Require collection/category context for collection-section generation.
- Add preview device toggles and destination/slot labels to the generation result.

Priority 2:

- Add an outline step for staged generation with reorder/remove before section generation.
- Add variant tray for broad homepage and landing prompts.
- Add selected-section improvement actions: rewrite copy, change CTA, swap products, tighten spacing, make more premium, simplify mobile.
- Show generation warnings and sanitizer changes in a compact "AI checks" panel.

Priority 3:

- Convert saved AI output toward structured section/block data with editable fields.
- Add section tree controls: reorder, duplicate, hide, delete, rename.
- Add collection-page preview with real product grid context.
- Add version history/diff for AI generations and improvements.
- Add scheduling/targeting controls for campaign and collection sections.

## Prompt Examples For The UI

Homepage:

```text
Promote our best-selling Eid gift items with a compact premium section, using the selected products and one clear Shop gifts CTA.
```

Landing/campaign:

```text
Create a 5-section launch funnel for this skincare bundle: hero, benefits, product proof, offer urgency, and FAQ. Keep it warm, premium, and conversion-focused.
```

Collection:

```text
Add a buying-guide section above this collection grid. Explain how to choose between the selected products, avoid fake claims, and send shoppers back to the collection CTA.
```

Reusable:

```text
Create a compact trust strip for delivery, returns, secure payment, and customer support. It should work anywhere as a shortcode.
```

## Risks To Avoid

- Treating "landing page" as a single widget without telling the merchant where it will live.
- Generating fake products, prices, discounts, ratings, shipping promises, or inventory claims.
- Making merchants regenerate whole widgets for copy or spacing tweaks.
- Previewing a collection section without collection context.
- Letting broad prompts skip structure, resulting in generic AI-looking pages.
- Saving partial, loading, failed, or raw model output as widget content.
- Overloading shortcode/manual use as the primary placement model.

## Success Criteria

- Merchants can create a homepage section without learning prompt engineering.
- Landing/campaign generation produces a reviewable outline before a full staged draft.
- Collection generation cannot proceed without collection context and never invents catalog facts.
- Every generated result shows where it will appear, which context was used, and what can be safely edited next.
- Small edits use direct controls or selected-section improvement, not full regeneration.
- Preview makes mobile and placement issues visible before publish.
