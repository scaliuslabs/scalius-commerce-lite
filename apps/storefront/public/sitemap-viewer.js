// The sitemap viewer's "Copy URL" button (src/pages/sitemap.xsl.ts). A file
// from the store's origin, not an inline script or handler: the page's
// Content-Security-Policy runs neither.
document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest(".btn-copy") : null;
  if (!button) return;
  const original = Array.from(button.childNodes);
  const done = () => {
    const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({ width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "#059669", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" })) mark.setAttribute(name, value);
    const tick = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    tick.setAttribute("points", "20 6 9 17 4 12");
    mark.append(tick);
    const label = document.createElement("span");
    label.style.color = "#059669";
    label.textContent = "Copied!";
    button.replaceChildren(mark, " ", label);
    button.style.borderColor = "#059669";
    setTimeout(() => {
      button.replaceChildren(...original);
      button.style.borderColor = "";
    }, 2000);
  };
  if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, () => undefined);
});
