// src/scripts/hydrateProductShortcodes.ts
import { createRoot } from "react-dom/client";
import ProductShortcode from "@/components/ProductShortcode";
import React from "react";

interface RootElement extends HTMLElement {
  _reactRoot?: any;
}

function hydrate() {
  document
    .querySelectorAll<RootElement>(".product-shortcode-container")
    .forEach((el) => {
      // Prevent re-hydration on SPA navigation
      if (el._reactRoot) return;

      try {
        const propsString = el.dataset.props;
        if (!propsString) {
          console.error("Product shortcode is missing data-props attribute.", el);
          return;
        }
        
        const props = JSON.parse(propsString);
        const root = createRoot(el);
        
        root.render(
          React.createElement(ProductShortcode, { productData: props })
        );
        
        // Mark element as hydrated
        el._reactRoot = root;

      } catch (e) {
        console.error("Failed to hydrate product shortcode:", e, el);
        el.innerHTML = `<div class="shortcode-error">Error loading product.</div>`;
      }
    });
}

// Run on initial load and after Astro's view transitions
document.addEventListener("DOMContentLoaded", hydrate);
document.addEventListener("astro:page-load", hydrate);