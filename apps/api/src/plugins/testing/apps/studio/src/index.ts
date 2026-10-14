// acme.studio: a complete theme as an app. Its storefront module
// (storefront.tsx) skins the header, footer and product card and draws
// four component sections; one island adds carousel buttons; one stylesheet
// styles it all with the store's own colour and type tokens. The template
// applies the whole look in one click and keeps the merchant's content.
// The reference for docs/STOREFRONT-COMPONENTS.md.

import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";


export const manifest = {
  id: "acme.studio",
  name: "Studio theme",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "A calm, editorial theme: a slim header, a photo-led hero, featured products, a features row and FAQs.",
  author: { name: "Acme" },
  categories: ["store-design"],
  storefront: {
    sections: [
      { type: "hero", name: "Studio hero", description: "A large photo with a heading, text and a button.", settings: [
  { key: "heading", label: "Heading", type: "text", default: "New season, new studio", maxLength: 120 },
  { key: "text", label: "Text", type: "textarea", default: "Pieces made to last, delivered in two days.", maxLength: 400 },
  { key: "image", label: "Image", type: "image" },
  { key: "cta_label", label: "Button text", type: "text", default: "Shop the collection", maxLength: 40 },
  { key: "cta_link", label: "Button link", type: "link", default: "/search" },
  {
    key: "align", label: "Text position", type: "select", default: "start",
    options: [{ value: "start", label: "Left" }, { value: "center", label: "Centre" }],
  },
] },
      {
        type: "featured", name: "Featured products", description: "A scrolling row of product cards.",
        settings: [
          { key: "heading", label: "Heading", type: "text", default: "Featured", maxLength: 80 },
          { key: "products", label: "Products", type: "products", default: "newest", limit: 12 },
        ],
      },
      {
        type: "features", name: "Features", description: "Up to six short promises with an icon.",
        settings: [
          { key: "heading", label: "Heading", type: "text", maxLength: 80 },
          {
            key: "items", label: "Features", type: "list", itemLabel: "Feature", max: 6,
            fields: [
              { key: "title", label: "Title", type: "text", required: true, maxLength: 60 },
              { key: "text", label: "Text", type: "textarea", maxLength: 200 },
              { key: "icon", label: "Icon", type: "image" },
            ],
          },
        ],
      },
      {
        type: "faq", name: "Questions", description: "Questions that open to their answers.",
        settings: [
          { key: "heading", label: "Heading", type: "text", default: "Questions", maxLength: 80 },
          {
            key: "questions", label: "Questions", type: "list", itemLabel: "Question", max: 12,
            fields: [
              { key: "question", label: "Question", type: "text", required: true, maxLength: 160 },
              { key: "answer", label: "Answer", type: "textarea", required: true, maxLength: 1000 },
            ],
          },
        ],
      },
    ],
    skins: [
      {
        id: "studio-header", target: "header", name: "Studio header",
        settings: [
          { key: "sticky", label: "Stay on screen while scrolling", type: "boolean", default: true },
          { key: "show_search", label: "Show search", type: "boolean", default: true },
        ],
      },
      {
        id: "studio-footer", target: "footer", name: "Studio footer",
        settings: [{ key: "tagline", label: "Tagline", type: "text", default: "Made with care.", maxLength: 120 }],
      },
      {
        id: "studio-card", target: "product-card", name: "Studio card",
        settings: [
          {
            key: "ratio", label: "Photo shape", type: "select", default: "portrait",
            options: [{ value: "portrait", label: "Portrait" }, { value: "square", label: "Square" }],
          },
          { key: "show_rating", label: "Show rating", type: "boolean", default: true },
        ],
      },
    ],
    templates: [{
      id: "studio",
      name: "Studio",
      description: "The Studio header, footer and card, with a hero, featured products and questions on the homepage.",
      theme: {
        apps: {
          skins: {
            header: { app: "acme.studio/studio-header", values: {} },
            footer: { app: "acme.studio/studio-footer", values: {} },
            "product-card": { app: "acme.studio/studio-card", values: {} },
          },
        },
        sections: [
          { id: "app-studio-hero", type: "app", version: 1, settings: { app: "acme.studio/hero", values: {} } },
          { id: "app-studio-featured", type: "app", version: 1, settings: { app: "acme.studio/featured", values: {} } },
          { id: "app-studio-faq", type: "app", version: 1, settings: { app: "acme.studio/faq", values: {} } },
        ],
      },
    }],
    islands: [{ name: "carousel", description: "Previous and next buttons for scrolling rows." }],
    stylesheet: true,
  },
} satisfies PluginManifestInput;

export default definePlugin({ manifest });
