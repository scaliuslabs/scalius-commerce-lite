/**
 * The host's net under a theme's private stylesheet, for honest mistakes.
 * The protection is the save: a rule that can reach a protected part may set
 * only presentational properties (private-css.ts), so a stylesheet the save
 * accepted cannot hide or fake one. This catches what the save cannot see:
 * a presentational choice that still loses a part (a colour equal to its
 * background is not caught). Inline and constant (its hash is in every page
 * policy, lib/inline-script-policy.ts); a page carries it only with a theme
 * stylesheet (`<style data-private-style data-guard="[selectors]">`, the
 * page's protected selectors, private-anatomy.ts).
 *
 * An element that is hidden, transparent, clipped, of no size or tiny text,
 * or off the page is looked at again with the stylesheet off. Hidden either
 * way, the host hid it (loading, an empty cart): fine. Visible without it:
 * the page drops the stylesheet for this view, marks the document
 * (`data-private-style="dropped"`, which the theme editor's canvas shows) and
 * says so in the console. It runs as the page settles, whenever the page's
 * content changes (the cart's lines draw later), when the root's state
 * changes (the dark scheme) and on resize, each time once the page is quiet.
 * About 1.5 KiB of HTML; no request, no module.
 */
export const PRIVATE_STYLE_GUARD_SCRIPT = `(function () {
  var style = document.querySelector("style[data-private-style]");
  if (!style || !style.sheet) return;
  var selectors;
  try { selectors = JSON.parse(style.getAttribute("data-guard") || "[]"); } catch (error) { return; }
  var hidden = function (element) {
    if (element.checkVisibility && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return true;
    var computed = getComputedStyle(element);
    if (computed.display === "none" || computed.visibility === "hidden" || Number(computed.opacity) === 0) return true;
    if (computed.clipPath && computed.clipPath !== "none") return true;
    if (/(?:^|\\s)opacity\\(0/.test(computed.filter || "")) return true;
    if (parseFloat(computed.fontSize) < 6 || /rgba\\([^)]*,\\s*0\\)|transparent/.test(computed.color)) return true;
    var box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return true;
    var width = Math.max(document.documentElement.scrollWidth, innerWidth);
    return box.right + scrollX <= 0 || box.left + scrollX >= width || box.bottom + scrollY <= 0;
  };
  var check = function () {
    if (!style.sheet || style.sheet.disabled) return;
    for (var i = 0; i < selectors.length; i++) {
      var found = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < found.length; j++) {
        if (!hidden(found[j])) continue;
        style.sheet.disabled = true;
        if (hidden(found[j])) { style.sheet.disabled = false; continue; }
        document.documentElement.setAttribute("data-private-style", "dropped");
        console.warn("[theme] The private pages' stylesheet hides " + selectors[i] + ", which a buyer must see: this page shows without it.");
        if (observer) observer.disconnect();
        return;
      }
    }
  };
  var timer = 0;
  var later = function () { clearTimeout(timer); timer = setTimeout(check, 150); };
  var observer = typeof MutationObserver === "function" ? new MutationObserver(later) : null;
  if (observer) {
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "data-cart-state"] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-scheme", "class"] });
  }
  check();
  addEventListener("load", check);
  addEventListener("resize", later);
})();`;
