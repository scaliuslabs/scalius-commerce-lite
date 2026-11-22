/**
 * The host's guard over a theme's private stylesheet: the one script the
 * private-page model adds, inline and constant (its hash is in every page
 * policy, lib/inline-script-policy.ts). A page carries it only with a theme
 * stylesheet (`<style data-private-style data-guard="[selectors]">`).
 *
 * It checks what a buyer must see (each mandatory part's guard selectors,
 * private-anatomy.ts): an element hidden, transparent, of no size or moved
 * off the page is looked at again with the theme's stylesheet off. Hidden
 * either way, the host hid it (a loading state, an empty cart): fine.
 * Visible without it, the theme hid it: the page drops the stylesheet for
 * this view, marks the document (`data-private-style="dropped"`, which the
 * theme editor's canvas shows) and says so in the console. It runs as the
 * page settles, again once the cart's lines have drawn, and on resize.
 * About 0.9 KiB of HTML; no request, no module.
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
    var box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return true;
    var width = document.documentElement.scrollWidth;
    return box.right + scrollX <= 0 || box.left + scrollX >= width || box.bottom + scrollY <= 0;
  };
  var check = function () {
    if (style.sheet.disabled) return;
    for (var i = 0; i < selectors.length; i++) {
      var found = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < found.length; j++) {
        if (!hidden(found[j])) continue;
        style.sheet.disabled = true;
        if (hidden(found[j])) { style.sheet.disabled = false; continue; }
        document.documentElement.setAttribute("data-private-style", "dropped");
        console.warn("[theme] The private pages' stylesheet hides " + selectors[i] + ", which a buyer must see: this page shows without it.");
        return;
      }
    }
  };
  var timer = 0;
  var later = function () { clearTimeout(timer); timer = setTimeout(check, 200); };
  check();
  addEventListener("load", check);
  addEventListener("resize", later);
  setTimeout(check, 1500);
  setTimeout(check, 4000);
})();`;
