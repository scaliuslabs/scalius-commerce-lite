// Dashboard list layout check, for a browser. Open a list (orders, products,
// customers) on a local dashboard, size the window (1024, 1280, 1440, 1920px,
// or a phone), then paste this file into the DevTools console. It prints one
// line per check and returns the failures:
// - the page never scrolls sideways, and the table fits its card;
// - the orders list shows Order and Date;
// - no cell text is cut without its whole value on hover;
// - every row is as tall as the others (cards on phones);
// - an order card shows its date and status.
// Load the largest and the smallest data you have (long English and Bangla
// names, every badge, a crore-sized total, empty cells) and repeat in Bangla.
(() => {
  const results = [];
  const check = (name, pass, detail = "") => results.push({ check: name, pass, detail });
  const main = document.getElementById("admin-main-scroll");
  check("page does not scroll sideways", !main || main.scrollWidth <= main.clientWidth + 1, main ? `${main.scrollWidth} > ${main.clientWidth}` : "");
  const table = document.querySelector("[data-data-table-results] table");
  if (table) {
    const wrapper = table.parentElement;
    check("table fits its card", !wrapper.hasAttribute("data-scrolls"), `${table.scrollWidth}px of ${wrapper.clientWidth}px`);
    const headings = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim()).filter(Boolean);
    if (/\/admin\/orders\/?$/.test(location.pathname)) {
      const has = (...names) => names.some((name) => headings.includes(name));
      check("Order and Date shown", has("Order", "অর্ডার") && has("Date", "তারিখ"), headings.join(" | "));
    }
    const cut = [];
    for (const element of table.querySelectorAll("tbody td *")) {
      if (element.children.length > 0 || !element.textContent.trim()) continue;
      if (element.scrollWidth <= element.clientWidth + 1) continue;
      if (!element.closest("[title]")) cut.push(element.textContent.trim().slice(0, 40));
    }
    check("no text cut without a hover value", cut.length === 0, cut.slice(0, 5).join(" | "));
    const heights = [...new Set([...table.querySelectorAll("tbody tr")].map((row) => Math.round(row.getBoundingClientRect().height)))];
    check("rows are one height", heights.length <= 1, heights.join(", "));
  } else {
    const cards = [...document.querySelectorAll("[data-data-table-results] .divide-y > div")];
    const heights = [...new Set(cards.map((card) => Math.round(card.getBoundingClientRect().height)))];
    check("cards are one height", heights.length <= 1, heights.join(", "));
    const orderCards = document.querySelectorAll("[data-part=order-card]");
    const missing = [...orderCards].filter((card) => !card.querySelector("span[title]") || !card.querySelector("[class*=rounded-lg]"));
    if (orderCards.length) check("order cards show date and status", missing.length === 0, `${missing.length} of ${orderCards.length} without`);
  }
  console.table(results);
  return results.filter((result) => !result.pass);
})();
