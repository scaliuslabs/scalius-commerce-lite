// Static HTML report for the storefront quality harness (scripts/storefront-quality.mjs).
// Self-contained page: inline CSS and JS, no network, works from file://.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** Only allow http(s) and relative URLs in href/src; anything else becomes "#". */
const safeUrl = (value) => {
  const url = String(value ?? "").trim();
  if (!url) return "#";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:/i.test(url)) return "#";
  return url;
};

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const IMPACTS = ["critical", "serious", "moderate", "minor"];
const impactClass = (impact) => (IMPACTS.includes(impact) ? impact : "minor");
// Entries are anchored by a sanitized id so summary links can jump to a card.
const anchor = (id) => `e-${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}`;

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
    ? `<p class="metrics">CLS ${num(m.cls).toFixed(3)}, scroll ${num(m.scrollWidth)}/${num(m.clientWidth)} px</p>`
    : "";
  return `<section class="w" data-width="${esc(width)}" aria-label="${esc(width)} pixels">
    <h4>${esc(width)} px <span class="n">${findings.length ? `${findings.length} finding${findings.length === 1 ? "" : "s"}` : "clean"}</span></h4>
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

const table = (head, rows, empty) =>
  rows.length
    ? `<table><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`
    : `<p class="empty">${esc(empty)}</p>`;

const STYLE = `
:root{--bg:#f6f7f9;--fg:#15181d;--muted:#566070;--card:#fff;--line:#d5dae1;--accent:#1d4ed8;--fail:#b42318;--pass:#146c43;--warn:#92400e;--code:#eef1f5}
@media(prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e8ebef;--muted:#a3adba;--card:#171b21;--line:#2c333d;--accent:#8ab4ff;--fail:#ff8a80;--pass:#6fd5a0;--warn:#f5b971;--code:#222831}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1800px;margin:0 auto;padding:16px}
a{color:var(--accent)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
h1{margin:0 0 4px;font-size:1.6rem}h2{font-size:1.15rem;margin:28px 0 8px}h3{margin:0;font-size:1.05rem}h4{margin:0 0 6px;font-size:.9rem}
code,pre{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
code{background:var(--code);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
.sub{color:var(--muted);margin:0}.sub span{margin-right:14px}
.strip{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 16px;min-width:150px}
.stat b{display:block;font-size:1.7rem;line-height:1.2}.stat.bad b{color:var(--fail)}
.tables{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}
.tables>div{overflow-x:auto}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);font-size:13.5px}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--code)}td.r,th.r{text-align:right}
.filters{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:end;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line)}
.filters label{display:flex;flex-direction:column;font-size:12.5px;color:var(--muted);gap:2px}
.filters label.inline{flex-direction:row;align-items:center;gap:6px;font-size:14px;color:var(--fg)}
input[type=search],select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);min-width:150px;max-width:100%}
input[type=checkbox]{width:18px;height:18px}
#count{margin-left:auto;color:var(--muted);font-size:13.5px}
.card{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--pass);border-radius:8px;margin:16px 0;padding:12px}
.card.fail{border-left-color:var(--fail)}.card.error{border-left-color:var(--fail)}.card.allowlisted{border-left-color:var(--warn)}
.card header{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}
.meta{flex-basis:100%;margin:2px 0;color:var(--muted);font-size:13px}.meta>*{margin-right:12px}
.note{flex-basis:100%;margin:0;color:var(--warn);font-size:13px}
.badge{font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:999px;border:1.5px solid currentColor}
.badge.fail,.badge.error{color:var(--fail)}.badge.pass{color:var(--pass)}.badge.allowlisted{color:var(--warn)}
pre.error{background:var(--code);color:var(--fail);padding:8px;border-radius:6px;overflow:auto;white-space:pre-wrap;margin:8px 0}
.widths{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin-top:10px}
.w{min-width:0}
.w img{display:block;width:100%;max-height:420px;object-fit:contain;object-position:top;background:var(--code);border:1px solid var(--line);border-radius:4px}
.noshot{padding:30px 8px;text-align:center;color:var(--muted);background:var(--code);border-radius:4px;font-size:13px}
.n{font-weight:400;color:var(--muted);margin-left:6px}
.diff,.metrics{margin:4px 0;font-size:12.5px;color:var(--muted)}.diff a{margin-left:6px}
.findings{list-style:none;margin:6px 0 0;padding:0;font-size:12.5px}
.finding{border-top:1px solid var(--line);padding:5px 0}
.msg{display:block;color:var(--muted)}.count{color:var(--muted)}
.gate{font-size:11px;color:var(--fail);font-weight:700}
.chip{display:inline-block;font-size:11px;font-weight:700;padding:0 6px;border-radius:4px;border:1px solid currentColor}
.chip.critical{color:var(--fail)}.chip.serious{color:#c2410c}.chip.moderate{color:var(--warn)}.chip.minor{color:var(--muted)}
@media(prefers-color-scheme:dark){.chip.serious{color:#fdba74}}
.nodes{margin:4px 0 0;padding-left:16px}.nodes li{margin:2px 0}
details summary{cursor:pointer;color:var(--accent)}
.empty{color:var(--muted)}
[hidden]{display:none!important}
`;

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
<title>Storefront quality report</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Storefront quality report</h1>
<p class="sub"><span>Generated <time datetime="${esc(r.generatedAt)}">${esc(r.generatedAt)}</time></span><span>Base URL <code>${esc(r.baseUrl)}</code></span><span>Mode ${esc(r.mode)}</span><span>Widths ${esc(widths.join(", "))} px</span></p>
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
  <label>Width<select id="f-width"><option value="">All widths</option>${widths.map((w) => `<option value="${esc(w)}">${esc(w)} px</option>`).join("")}</select></label>
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
