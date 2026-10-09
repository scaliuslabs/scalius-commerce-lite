// Static HTML report for the storefront quality harness (scripts/storefront-quality.mjs).
// Self-contained page: inline CSS and JS, no network, works from file://.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPORT_STYLE as STYLE, anchor, esc, impactClass, num, safeUrl, table } from "../quality-shared/report-kit.mjs";

// A plain number is a viewport width; the dashboard harness keys "390 en".
const widthLabel = (key) => (/^\d+$/.test(String(key)) ? `${key} px` : String(key));

function entryStatus(entry) {
  if (entry.error) return "ERROR";
  if (entry.failing) return entry.allowlisted ? "ALLOWLISTED" : "FAIL";
  return entry.allowlisted ? "ALLOWLISTED" : "PASS";
}

function renderFinding(f) {
  const nodes = Array.isArray(f.nodes) ? f.nodes : [];
  const help = f.help
    ? ` <a href="${esc(safeUrl(f.help))}" target="_blank" rel="noopener noreferrer">docs</a>`
    : "";
  return `<li class="finding${f.gating ? " gating" : ""}" data-rule="${esc(f.rule)}">
    <span class="chip ${impactClass(f.impact)}">${esc(f.impact || "minor")}</span>
    <strong>${esc(f.rule)}</strong> <span class="count">x${num(f.count) || 1}</span>${f.gating ? ' <span class="gate">gating</span>' : ""}
    <span class="msg">${esc(f.message)}${help}</span>
    ${nodes.length ? `<details><summary>${nodes.length} node${nodes.length === 1 ? "" : "s"}</summary><ul class="nodes">${nodes.map((n) => `<li><code>${esc(n)}</code></li>`).join("")}</ul></details>` : ""}
  </li>`;
}

function renderWidth(entry, width) {
  const data = (entry.widths ?? {})[width] ?? {};
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const shot = data.screenshot
    ? `<a href="${esc(safeUrl(data.screenshot))}" target="_blank" rel="noopener noreferrer"><img loading="lazy" src="${esc(safeUrl(data.screenshot))}" alt="${esc(entry.title || entry.id)} at ${esc(width)} pixels wide"></a>`
    : `<div class="noshot">No screenshot</div>`;
  const diff = data.diff
    ? `<p class="diff">diff ${(num(data.diff.ratio) * 100).toFixed(1)}%${data.diff.image ? ` <a href="${esc(safeUrl(data.diff.image))}" target="_blank" rel="noopener noreferrer">diff image</a>` : ""}${data.diff.baseline ? ` <a href="${esc(safeUrl(data.diff.baseline))}" target="_blank" rel="noopener noreferrer">baseline</a>` : ""}</p>`
    : "";
  const m = data.metrics;
  const metrics = m
    ? `<p class="metrics">CLS ${num(m.cls).toFixed(3)}, scroll ${num(m.scrollWidth)}/${num(m.clientWidth)} px${m.settledMs !== undefined && m.settledMs !== null ? `, first paint ${num(m.fcpMs)} ms, settled ${num(m.settledMs)} ms` : ""}</p>`
    : "";
  return `<section class="w" data-width="${esc(width)}" aria-label="${esc(widthLabel(width))}">
    <h4>${esc(widthLabel(width))} <span class="n">${findings.length ? `${findings.length} finding${findings.length === 1 ? "" : "s"}` : "clean"}</span></h4>
    ${shot}${diff}${metrics}
    ${findings.length ? `<ul class="findings">${findings.map(renderFinding).join("")}</ul>` : ""}
  </section>`;
}

function renderEntry(entry, widths) {
  const status = entryStatus(entry);
  const keys = [...new Set([...widths.map(String), ...Object.keys(entry.widths ?? {})])];
  return `<article class="card ${status.toLowerCase()}" id="${esc(anchor(entry.id))}" data-id="${esc(entry.id)}">
    <header>
      <h3>${esc(entry.title || entry.id)}</h3>
      <span class="badge ${status.toLowerCase()}">${status}</span>
      <p class="meta"><code>${esc(entry.id)}</code> <span>${esc(entry.family)}</span> <span>page: ${esc(entry.page)}</span> <span>${esc(entry.locale)} / ${esc(entry.dir)}</span>
      ${entry.url ? `<a href="${esc(safeUrl(entry.url))}" target="_blank" rel="noopener noreferrer">open live</a>` : ""}</p>
      ${entry.allowlisted && entry.allowReason ? `<p class="note">Allowlisted: ${esc(entry.allowReason)}</p>` : ""}
    </header>
    ${entry.error ? `<pre class="error">${esc(entry.error)}</pre>` : ""}
    <div class="widths">${keys.map((w) => renderWidth(entry, w)).join("")}</div>
  </article>`;
}


const SCRIPT = `
(function(){
  var data = JSON.parse(document.getElementById("report-data").textContent);
  var $ = function(id){ return document.getElementById(id); };
  var q = $("f-q"), fam = $("f-family"), rule = $("f-rule"), fail = $("f-fail"), wid = $("f-width");
  var cards = Array.prototype.slice.call(document.querySelectorAll(".card"));
  var byId = {};
  data.entries.forEach(function(e){ byId[e.id] = e; });
  function apply(){
    var text = q.value.trim().toLowerCase(), shown = 0;
    cards.forEach(function(card){
      var e = byId[card.getAttribute("data-id")];
      var ok = true;
      if (text && (e.id + " " + e.title).toLowerCase().indexOf(text) < 0) ok = false;
      if (ok && fam.value && e.family !== fam.value) ok = false;
      if (ok && fail.checked && !(e.failing && !e.allowlisted) && !e.error) ok = false;
      if (ok && rule.value) {
        ok = Object.keys(e.widths || {}).some(function(w){
          if (wid.value && w !== wid.value) return false;
          return (e.widths[w].findings || []).some(function(f){ return f.rule === rule.value; });
        });
      }
      card.hidden = !ok;
      if (ok) {
        shown++;
        Array.prototype.forEach.call(card.querySelectorAll(".w"), function(col){
          var w = col.getAttribute("data-width");
          col.hidden = !!wid.value && w !== wid.value;
          Array.prototype.forEach.call(col.querySelectorAll(".finding"), function(li){
            li.hidden = !!rule.value && li.getAttribute("data-rule") !== rule.value;
          });
        });
      }
    });
    $("count").textContent = shown + " of " + cards.length + " entries shown";
  }
  [q, fam, rule, fail, wid].forEach(function(el){ el.addEventListener("input", apply); el.addEventListener("change", apply); });
  apply();
})();
`;

export function renderQualityReport(results) {
  const r = results ?? {};
  const summary = r.summary ?? {};
  const entries = Array.isArray(r.entries) ? r.entries : [];
  const widths = Array.isArray(r.widths) ? r.widths : [];
  const byRule = Object.entries(summary.byRule ?? {}).sort(
    ([, a], [, b]) => num(b.findings) - num(a.findings),
  );
  const byFamily = Object.entries(summary.byFamily ?? {}).sort(
    ([, a], [, b]) => num(b.findings) - num(a.findings),
  );
  const worst = Array.isArray(summary.worst) ? summary.worst : [];
  const families = [...new Set(entries.map((e) => e.family).filter(Boolean))].sort();
  const rules = [
    ...new Set(
      entries.flatMap((e) =>
        Object.values(e.widths ?? {}).flatMap((w) => (w.findings ?? []).map((f) => f.rule)),
      ),
    ),
  ].sort();
  const option = (v) => `<option value="${esc(v)}">${esc(v)}</option>`;
  // "<" is escaped so the JSON can never close the script element.
  const json = JSON.stringify({
    entries: entries.map((e) => ({
      id: e.id,
      title: e.title ?? "",
      family: e.family ?? "",
      failing: Boolean(e.failing),
      allowlisted: Boolean(e.allowlisted),
      error: e.error ? true : false,
      widths: Object.fromEntries(
        Object.entries(e.widths ?? {}).map(([w, d]) => [
          w,
          { findings: (d.findings ?? []).map((f) => ({ rule: f.rule })) },
        ]),
      ),
    })),
  })
    .replace(/[<\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

  const ruleRows = byRule.map(
    ([name, s]) =>
      `<tr><td><code>${esc(name)}</code></td><td>${esc(s.impact ?? "")}</td><td>${s.gating ? "yes" : "no"}</td><td class="r">${num(s.findings)}</td><td class="r">${num(s.entries)}</td></tr>`,
  );
  const familyRows = byFamily.map(
    ([name, s]) =>
      `<tr><td>${esc(name)}</td><td class="r">${num(s.entries)}</td><td class="r">${num(s.failingEntries)}</td><td class="r">${num(s.findings)}</td></tr>`,
  );
  const known = new Set(entries.map((e) => e.id));
  const worstRows = worst.map(
    (w, i) =>
      `<tr><td class="r">${i + 1}</td><td>${known.has(w.id) ? `<a href="#${esc(anchor(w.id))}">${esc(w.id)}</a>` : esc(w.id)}</td><td>${esc(w.family)}</td><td class="r">${num(w.score)}</td><td class="r">${num(w.findings)}</td></tr>`,
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.title ?? "Storefront quality report")}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${esc(r.title ?? "Storefront quality report")}</h1>
<p class="sub"><span>Generated <time datetime="${esc(r.generatedAt)}">${esc(r.generatedAt)}</time></span><span>Base URL <code>${esc(r.baseUrl)}</code></span><span>Mode ${esc(r.mode)}</span><span>Widths ${esc(widths.map(widthLabel).join(", "))}</span></p>
<div class="strip" role="group" aria-label="Summary">
  <div class="stat"><b>${num(summary.entries ?? entries.length)}</b>entries audited</div>
  <div class="stat${num(summary.failingEntries) ? " bad" : ""}"><b>${num(summary.failingEntries)}</b>failing entries</div>
  <div class="stat${num(summary.gatingFindings) ? " bad" : ""}"><b>${num(summary.gatingFindings)}</b>gating findings</div>
</div>
<div class="tables">
  <div><h2>Findings by rule</h2>${table(["Rule", "Impact", "Gating", "Findings", "Entries"], ruleRows, "No findings.")}</div>
  <div><h2>Findings by family</h2>${table(["Family", "Entries", "Failing entries", "Findings"], familyRows, "No families.")}</div>
  <div><h2>Worst sections</h2>${table(["Rank", "Entry", "Family", "Score", "Findings"], worstRows, "Nothing to rank.")}</div>
</div>
<h2>Entries</h2>
<form class="filters" role="search" aria-label="Filter entries" onsubmit="return false">
  <label>Search id or title<input id="f-q" type="search" autocomplete="off"></label>
  <label>Family<select id="f-family"><option value="">All families</option>${families.map(option).join("")}</select></label>
  <label>Rule<select id="f-rule"><option value="">All rules</option>${rules.map(option).join("")}</select></label>
  <label>Width<select id="f-width"><option value="">All widths</option>${widths.map((w) => `<option value="${esc(w)}">${esc(widthLabel(w))}</option>`).join("")}</select></label>
  <label class="inline"><input id="f-fail" type="checkbox">Failing only</label>
  <span id="count" role="status" aria-live="polite"></span>
</form>
<div id="entries">
${entries.map((e) => renderEntry(e, widths)).join("\n")}
</div>
</main>
<script type="application/json" id="report-data">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

export function writeQualityReport(outDir, results) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "index.html");
  writeFileSync(file, renderQualityReport(results));
  return file;
}
