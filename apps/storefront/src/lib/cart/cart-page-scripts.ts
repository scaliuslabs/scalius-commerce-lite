// The cart page's inline scripts: they run while the page is parsed, before
// any module loads. Constant code, so the page policy names each by its hash
// (lib/inline-script-policy.ts); what they read comes from the DOM and this
// browser's storage.

/** Before first paint: with nothing saved the empty state shows at once (PERF-01); a cart with nothing physical hides the delivery section, and a buyer who chose pickup sees no address fields. */
export const CART_FIRST_PAINT_SCRIPT = `(function () {
  try {
    var root = document.getElementById("cartPageRoot");
    var cart = JSON.parse(localStorage.getItem("cart:v3") || "null");
    var lines = cart && cart.items && typeof cart.items === "object" ? cart.items : {};
    var items = Object.keys(lines);
    var recovery = "scalius_hosted_payment_recovery";
    if (items.length === 0 && !sessionStorage.getItem("quickBuyData")
      && !localStorage.getItem(recovery) && !sessionStorage.getItem(recovery)) {
      root.dataset.cartState = "empty";
    }
    // Lines are saved: the form shows from first paint, and the lines'
    // names paint below (the script after the skeleton), long before
    // the cart script has loaded and checked them.
    if (items.length > 0) root.dataset.cartPrepaint = "items";
    var physical = items.length === 0 || !!sessionStorage.getItem("quickBuyData") || items.some(function (key) {
      var kind = lines[key] && lines[key].fulfillmentKind;
      return !kind || kind === "physical";
    });
    if (!physical) root.dataset.deliveryNeed = "none";
    if (root.dataset.modeSwitch === "true") {
      var draft = JSON.parse(localStorage.getItem("scalius_checkout_form_draft") || "null");
      if (draft && draft.values && Date.now() - draft.updatedAt <= 7200000 && draft.values.deliveryMode === "pickup") root.dataset.deliveryMode = "pickup";
    }
  } catch (error) {}
})();`;

/** Shows the notice when the quick-buy handoff could not use session storage. */
export const CART_QUICK_BUY_NOTICE_SCRIPT = `(function () {
  try {
    if (new URLSearchParams(location.search).get("quickBuyStorage") === "blocked") {
      document.getElementById("quickBuyStorageNotice").hidden = false;
    }
  } catch {
    // An unreadable URL keeps the notice hidden.
  }
})();`;

/** The saved lines at their size, named, before the cart script loads (this browser's storage only). */
export const CART_LOADING_LINES_SCRIPT = `(function () {
  try {
    var box = document.querySelector("[data-cart-loading]");
    var line = box && box.querySelector("[data-cart-loading-line]");
    var cart = JSON.parse(localStorage.getItem("cart:v3") || "null");
    var lines = cart && cart.items && typeof cart.items === "object" ? cart.items : {};
    var keys = Object.keys(lines).slice(0, 8);
    if (!line || keys.length === 0) return;
    keys.forEach(function (key, index) {
      var row = index === 0 ? line : line.cloneNode(true);
      var name = row.querySelector("[data-cart-loading-name]");
      var text = lines[key] && typeof lines[key].name === "string" ? lines[key].name.slice(0, 200) : "";
      if (name && text) {
        name.className = "line-clamp-2 text-sm font-medium text-foreground sm:text-base";
        name.textContent = text;
      }
      if (index > 0) box.appendChild(row);
    });
  } catch (error) {}
})();`;

/** Checks the pickup choice the first-paint script restored. */
export const CART_PICKUP_CHOICE_SCRIPT = `(function () {
  var root = document.getElementById("cartPageRoot");
  var pickup = document.querySelector('input[name="deliveryMode"][value="pickup"]');
  if (root && pickup && root.dataset.deliveryMode === "pickup") pickup.checked = true;
})();`;

/** Places the cart column where it shows (after the form on wide screens) and folds the phone summary. */
export const CART_COLUMN_PLACE_SCRIPT = `(function () {
  var root = document.getElementById("cartPageRoot");
  var grid = root && root.querySelector("[data-cart-grid]");
  var cart = document.getElementById("cartColumn");
  var form = document.getElementById("checkoutPanel");
  if (!grid || !cart || !form) return;
  var wide = window.matchMedia("(min-width: 64rem)");
  var place = function () {
    var after = cart.previousElementSibling === form;
    if (wide.matches === after) return;
    var focused = document.activeElement;
    if (wide.matches) grid.appendChild(cart);
    else grid.insertBefore(cart, form);
    if (focused && focused !== document.activeElement && cart.contains(focused)) focused.focus({ preventScroll: true });
  };
  place();
  if (wide.addEventListener) wide.addEventListener("change", place);
  root.dataset.summary = "closed";
  var toggle = document.getElementById("orderSummaryToggle");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
})();`;

/** Folds the phone summary when the cart sits on top. */
export const CART_SUMMARY_FOLD_SCRIPT = `(function () {
  var root = document.getElementById("cartPageRoot");
  if (!root) return;
  root.dataset.summary = "closed";
  var toggle = document.getElementById("orderSummaryToggle");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
})();`;

/**
 * The controls that work before the page scripts load: the phone summary's
 * "Show order summary" bar and the delivery or pickup choice. One delegated
 * listener each, installed as the page root opens.
 */
export const CART_EARLY_CONTROLS_SCRIPT = `(function () {
  document.addEventListener("click", function (event) {
    var toggle = event.target instanceof Element ? event.target.closest("#orderSummaryToggle") : null;
    var root = document.getElementById("cartPageRoot");
    if (!toggle || !root) return;
    var open = root.dataset.summary !== "open";
    root.dataset.summary = open ? "open" : "closed";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  document.addEventListener("change", function (event) {
    var input = event.target;
    var root = document.getElementById("cartPageRoot");
    if (root && input instanceof HTMLInputElement && input.name === "deliveryMode" && input.type === "radio") root.dataset.deliveryMode = input.value;
  });
})();`;
