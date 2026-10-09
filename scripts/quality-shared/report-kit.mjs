// Shared pieces of the quality reports (storefront and dashboard harnesses):
// HTML escaping, safe links, the report stylesheet and small helpers.
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** Only allow http(s) and relative URLs in href/src; anything else becomes "#". */
export const safeUrl = (value) => {
  const url = String(value ?? "").trim();
  if (!url) return "#";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:/i.test(url)) return "#";
  return url;
};

export const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
export const IMPACTS = ["critical", "serious", "moderate", "minor"];
export const impactClass = (impact) => (IMPACTS.includes(impact) ? impact : "minor");
// Entries are anchored by a sanitized id so summary links can jump to a card.
export const anchor = (id) => `e-${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}`;

export const table = (head, rows, empty) =>
  rows.length
    ? `<table><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`
    : `<p class="empty">${esc(empty)}</p>`;

export const REPORT_STYLE = `
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

export const IMPACT_WEIGHT = { critical: 10, serious: 5, moderate: 2, minor: 1 };

/** Findings by rule and family, and the worst entries, for either harness's results. */
export function summarizeResults(results, { ignoreRules = [] } = {}) {
  const byRule = {};
  const byFamily = {};
  let gatingFindings = 0;
  for (const entry of results) {
    const family = (byFamily[entry.family] ??= { entries: 0, failingEntries: 0, findings: 0 });
    family.entries += 1;
    if (entry.failing) family.failingEntries += 1;
    const rulesSeen = new Set();
    for (const width of Object.values(entry.widths)) {
      for (const finding of width.findings) {
        const rule = (byRule[finding.rule] ??= { findings: 0, entries: 0, impact: finding.impact, gating: false, source: finding.source });
        rule.findings += finding.count;
        if (IMPACT_WEIGHT[finding.impact] > IMPACT_WEIGHT[rule.impact]) rule.impact = finding.impact;
        if (finding.gating) {
          rule.gating = true;
          gatingFindings += 1;
        }
        if (!rulesSeen.has(finding.rule)) {
          rulesSeen.add(finding.rule);
          rule.entries += 1;
        }
        family.findings += finding.count;
      }
    }
  }
  const score = (entry) => Object.values(entry.widths).reduce((total, width) => total + width.findings
    .filter((finding) => !ignoreRules.includes(finding.rule))
    .reduce((sum, finding) => sum + (IMPACT_WEIGHT[finding.impact] ?? 1) * Math.min(finding.count, 10), 0), 0) + (entry.error ? 50 : 0);
  const worst = results
    .map((entry) => ({ id: entry.id, family: entry.family, score: score(entry), findings: Object.values(entry.widths).reduce((total, width) => total + width.findings.length, 0) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 15);
  return {
    entries: results.length,
    failingEntries: results.filter((entry) => entry.failing).length,
    gatingFindings,
    byRule: Object.fromEntries(Object.entries(byRule).sort((left, right) => right[1].findings - left[1].findings)),
    byFamily: Object.fromEntries(Object.entries(byFamily).sort((left, right) => right[1].findings - left[1].findings)),
    worst,
  };
}
