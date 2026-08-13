import { getBarcodeValidationError } from "@scalius/shared/barcode-identity";

export const INVENTORY_LABEL_ARTIFACT_MAX_COPIES = 1_000;
export const INVENTORY_LABEL_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

export type InventoryLabelArtifactVariant = {
  id: string;
  productName: string;
  sku: string;
  optionLabel: string | null;
  effectivePrice: number;
  barcode: string | null;
  barcodeType: string | null;
};

export type InventoryLabelArtifactJob = {
  format: "csv" | "html" | "pdf";
  mode: "job" | "test";
  quantities: Record<string, number>;
  order: "selected" | "product" | "sku";
  preset: {
    pageWidthMm: number;
    pageHeightMm: number;
    columns: number;
    rows: number;
    marginXmm: number;
    marginYmm: number;
    gapXmm: number;
    gapYmm: number;
    cropMarks: boolean;
  };
  startOffset: number;
  alignment: { xMm: number; yMm: number };
  content: {
    showProduct: boolean;
    showVariant: boolean;
    showSku: boolean;
    showPrice: boolean;
  };
};

export type InventoryLabelArtifact = {
  body: string | Uint8Array<ArrayBuffer>;
  contentType: string;
  extension: "csv" | "html" | "pdf";
  copyCount: number;
  pageCount: number;
  byteLength: number;
};

type LabelCopy = InventoryLabelArtifactVariant & { copyIndex: number };
type EncodedBarcode = { bits: string; displayValue: string };

const MM_TO_PT = 72 / 25.4;
const CODE128_PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212",
  "112232","122132","122231","113222","123122","123221","223211","221132","221231","213212","223112","312131",
  "311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321",
  "112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121",
  "313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114",
  "122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212",
  "124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113",
  "114311","411113","411311","113141","114131","311141","411131","211412","211214","211232","2331112",
] as const;
const EAN_L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const EAN_G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const EAN_R = EAN_L.map((pattern) => [...pattern].map((bit) => bit === "0" ? "1" : "0").join(""));
const EAN13_PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];
const ITF = ["nnwwn","wnnnw","nwnnw","wwnnn","nnwnw","wnwnn","nwwnn","nnnww","wnnwn","nwnwn"];

function barcodeBits(value: string, type: string): EncodedBarcode {
  const compact = value.replaceAll("-", "").trim();
  const validationError = getBarcodeValidationError(value, type);
  if (validationError) throw new Error(validationError);
  if ((type === "custom" || type === "code128") && !/^[\x20-\x7E]+$/.test(compact)) {
    throw new Error("Code 128 label values must contain printable ASCII characters only.");
  }

  if (type === "isbn" && compact.length === 10) {
    const base = `978${compact.slice(0, 9)}`;
    const sum = [...base].reduce(
      (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
      0,
    );
    const booklandEan = `${base}${(10 - (sum % 10)) % 10}`;
    const encoded = barcodeBits(booklandEan, "ean13");
    return { ...encoded, displayValue: value };
  }

  const normalizedType = type;

  if (normalizedType === "ean13" || (normalizedType === "isbn" && compact.length === 13)) {
    const parity = EAN13_PARITY[Number(compact[0])]!;
    let bits = "101";
    for (let index = 1; index <= 6; index += 1) {
      bits += parity[index - 1] === "L" ? EAN_L[Number(compact[index])] : EAN_G[Number(compact[index])];
    }
    bits += "01010";
    for (let index = 7; index < 13; index += 1) bits += EAN_R[Number(compact[index])];
    return { bits: `00000000000${bits}0000000`, displayValue: value };
  }
  if (normalizedType === "upc" || (normalizedType === "gtin" && compact.length === 12)) {
    const encoded = barcodeBits(`0${compact}`, "ean13");
    return { ...encoded, displayValue: value };
  }
  if (normalizedType === "gtin" && compact.length === 8) {
    let bits = "101";
    for (let index = 0; index < 4; index += 1) bits += EAN_L[Number(compact[index])];
    bits += "01010";
    for (let index = 4; index < 8; index += 1) bits += EAN_R[Number(compact[index])];
    return { bits: `0000000${bits}0000000`, displayValue: value };
  }
  if (normalizedType === "gtin" && compact.length === 14) {
    let bits = "0000000000";
    const pairs = compact.match(/../g) ?? [];
    bits += "1010";
    for (const pair of pairs) {
      const bars = ITF[Number(pair[0])]!;
      const spaces = ITF[Number(pair[1])]!;
      for (let index = 0; index < 5; index += 1) {
        bits += "1".repeat(bars[index] === "w" ? 3 : 1);
        bits += "0".repeat(spaces[index] === "w" ? 3 : 1);
      }
    }
    bits += "11101";
    return { bits: `${bits}0000000000`, displayValue: value };
  }

  const useCodeSetC = /^\d+$/.test(compact) && compact.length % 2 === 0;
  const start = useCodeSetC ? 105 : 104;
  const values = useCodeSetC
    ? (compact.match(/../g) ?? []).map(Number)
    : [...compact].map((character) => character.charCodeAt(0) - 32);
  const checksum = (start + values.reduce((sum, item, index) => sum + item * (index + 1), 0)) % 103;
  const codes = [start, ...values, checksum, 106];
  let bits = "0000000000";
  for (const code of codes) {
    let bar = true;
    for (const width of CODE128_PATTERNS[code]!) {
      bits += (bar ? "1" : "0").repeat(Number(width));
      bar = !bar;
    }
  }
  return { bits: `${bits}0000000000`, displayValue: value };
}

function compareText(left: string | null, right: string | null): number {
  return (left ?? "").localeCompare(right ?? "", "en", { numeric: true, sensitivity: "base" });
}

function buildCopies(variants: readonly InventoryLabelArtifactVariant[], job: InventoryLabelArtifactJob): LabelCopy[] {
  const ordered = [...variants];
  if (job.order !== "selected") {
    ordered.sort((left, right) => {
      const primary = compareText(
        job.order === "product" ? left.productName : left.sku,
        job.order === "product" ? right.productName : right.sku,
      );
      return primary || compareText(left.optionLabel, right.optionLabel) || compareText(left.id, right.id);
    });
  }
  const copies = ordered.flatMap((variant) => Array.from(
    { length: Math.max(0, Math.trunc(job.quantities[variant.id] ?? 0)) },
    (_, copyIndex) => ({ ...variant, copyIndex }),
  ));
  if (copies.length === 0) throw new Error("Select at least one label copy.");
  if (copies.length > INVENTORY_LABEL_ARTIFACT_MAX_COPIES) {
    throw new Error(`A label artifact can contain at most ${INVENTORY_LABEL_ARTIFACT_MAX_COPIES} copies.`);
  }
  for (const copy of copies) {
    if (!copy.barcode || !copy.barcodeType) throw new Error(`SKU ${copy.sku} has no printable barcode.`);
    barcodeBits(copy.barcode, copy.barcodeType);
  }
  return copies;
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function formatPrice(value: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).format(value);
  } catch {
    return `${currencyCode} ${value.toFixed(2)}`;
  }
}

function renderCsv(copies: readonly LabelCopy[], currencyCode: string): string {
  return [
    ["Product", "Variant", "SKU", "Barcode", "Barcode type", "Price", "Copy"].map(csvCell).join(","),
    ...copies.map((copy) => [
      copy.productName,
      copy.optionLabel,
      copy.sku,
      copy.barcode,
      copy.barcodeType,
      formatPrice(copy.effectivePrice, currencyCode),
      copy.copyIndex + 1,
    ].map(csvCell).join(",")),
  ].join("\n") + "\n";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function barcodeSvg(copy: LabelCopy): string {
  const { bits, displayValue } = barcodeBits(copy.barcode!, copy.barcodeType!);
  const bars = [...bits].flatMap((bit, index) => bit === "1"
    ? [`<rect x="${index}" y="0" width="1" height="50"/>`]
    : []);
  return `<svg viewBox="0 0 ${bits.length} 50" preserveAspectRatio="none" aria-label="Barcode ${escapeHtml(displayValue)}">${bars.join("")}</svg>`;
}

function renderHtml(copies: readonly LabelCopy[], job: InventoryLabelArtifactJob, currencyCode: string): string {
  const preset = job.preset;
  const capacity = preset.columns * preset.rows;
  const cells = [...Array.from({ length: job.startOffset }, () => null), ...copies];
  while (cells.length % capacity !== 0) cells.push(null);
  const pageCount = Math.ceil(cells.length / capacity);
  const labelWidth = (preset.pageWidthMm - preset.marginXmm * 2 - preset.gapXmm * (preset.columns - 1)) / preset.columns;
  const labelHeight = (preset.pageHeightMm - preset.marginYmm * 2 - preset.gapYmm * (preset.rows - 1)) / preset.rows;
  const pages = Array.from({ length: pageCount }, (_, pageIndex) => {
    const labels = cells.slice(pageIndex * capacity, (pageIndex + 1) * capacity).map((copy) => copy ? `<div class="label">
      ${barcodeSvg(copy)}<div class="code">${escapeHtml(copy.barcode)}</div>
      ${job.content.showProduct ? `<div class="product">${escapeHtml(copy.productName)}</div>` : ""}
      ${job.content.showVariant && copy.optionLabel ? `<div>${escapeHtml(copy.optionLabel)}</div>` : ""}
      <div>${job.content.showSku ? escapeHtml(copy.sku) : ""}${job.content.showSku && job.content.showPrice ? " · " : ""}${job.content.showPrice ? escapeHtml(formatPrice(copy.effectivePrice, currencyCode)) : ""}</div>
    </div>` : "<div></div>").join("");
    return `<section class="page"><div class="grid">${labels}</div></section>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Barcode labels</title><style>
    @page{size:${preset.pageWidthMm}mm ${preset.pageHeightMm}mm;margin:0}*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#09090b;font-family:Arial,sans-serif}.page{position:relative;width:${preset.pageWidthMm}mm;height:${preset.pageHeightMm}mm;break-after:page}.page:last-child{break-after:auto}.grid{position:absolute;left:${preset.marginXmm + job.alignment.xMm}mm;top:${preset.marginYmm + job.alignment.yMm}mm;display:grid;grid-template-columns:repeat(${preset.columns},${labelWidth}mm);grid-template-rows:repeat(${preset.rows},${labelHeight}mm);gap:${preset.gapYmm}mm ${preset.gapXmm}mm}.label{overflow:hidden;padding:1mm;text-align:center;font-size:7pt;line-height:1.15;${preset.cropMarks ? "border:.15mm dashed #aaa" : ""}}.label svg{display:block;width:100%;height:10mm}.code{font:6.5pt monospace}.product{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  </style></head><body>${pages}<script>addEventListener("load",()=>print())</script></body></html>`;
}

function pdfText(value: string): string {
  return [...value].map((character) => {
    if (/\s/u.test(character)) return " ";
    const code = character.charCodeAt(0);
    if (code < 32 || code > 126) return "?";
    return character === "(" || character === ")" || character === "\\" ? `\\${character}` : character;
  }).join("");
}

function renderPdf(
  copies: readonly LabelCopy[],
  job: InventoryLabelArtifactJob,
  currencyCode: string,
): Uint8Array<ArrayBuffer> {
  const preset = job.preset;
  const capacity = preset.columns * preset.rows;
  const cells = [...Array.from({ length: job.startOffset }, () => null), ...copies];
  while (cells.length % capacity !== 0) cells.push(null);
  const pageCount = Math.ceil(cells.length / capacity);
  const pageWidth = preset.pageWidthMm * MM_TO_PT;
  const pageHeight = preset.pageHeightMm * MM_TO_PT;
  const labelWidthMm = (preset.pageWidthMm - preset.marginXmm * 2 - preset.gapXmm * (preset.columns - 1)) / preset.columns;
  const labelHeightMm = (preset.pageHeightMm - preset.marginYmm * 2 - preset.gapYmm * (preset.rows - 1)) / preset.rows;
  const objects: string[] = [];
  const pageObjectIds = Array.from({ length: pageCount }, (_, index) => 4 + index * 2);
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Count ${pageCount} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const commands: string[] = ["0 g"];
    for (let cellIndex = 0; cellIndex < capacity; cellIndex += 1) {
      const copy = cells[pageIndex * capacity + cellIndex];
      if (!copy) continue;
      const column = cellIndex % preset.columns;
      const row = Math.floor(cellIndex / preset.columns);
      const leftMm = preset.marginXmm + job.alignment.xMm + column * (labelWidthMm + preset.gapXmm);
      const topMm = preset.marginYmm + job.alignment.yMm + row * (labelHeightMm + preset.gapYmm);
      const left = leftMm * MM_TO_PT;
      const top = pageHeight - topMm * MM_TO_PT;
      const width = labelWidthMm * MM_TO_PT;
      const height = labelHeightMm * MM_TO_PT;
      if (preset.cropMarks) commands.push(`0.7 G 0.3 w ${left.toFixed(2)} ${(top - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re S 0 g`);
      const encoded = barcodeBits(copy.barcode!, copy.barcodeType!);
      const barcodeLeft = left + 5;
      const barcodeWidth = Math.max(1, width - 10);
      const moduleWidth = barcodeWidth / encoded.bits.length;
      const barcodeHeight = Math.min(28, Math.max(16, height * 0.45));
      const barcodeBottom = top - 5 - barcodeHeight;
      let runStart = -1;
      for (let index = 0; index <= encoded.bits.length; index += 1) {
        if (encoded.bits[index] === "1" && runStart < 0) runStart = index;
        if (encoded.bits[index] !== "1" && runStart >= 0) {
          commands.push(`${(barcodeLeft + runStart * moduleWidth).toFixed(2)} ${barcodeBottom.toFixed(2)} ${((index - runStart) * moduleWidth).toFixed(2)} ${barcodeHeight.toFixed(2)} re f`);
          runStart = -1;
        }
      }
      const lines = [
        copy.barcode,
        job.content.showProduct ? copy.productName : "",
        job.content.showVariant ? copy.optionLabel ?? "" : "",
        [job.content.showSku ? copy.sku : "", job.content.showPrice ? formatPrice(copy.effectivePrice, currencyCode) : ""].filter(Boolean).join("  "),
      ].filter(Boolean).slice(0, Math.max(1, Math.floor((height - barcodeHeight - 8) / 8)));
      lines.forEach((line, index) => {
        commands.push(`BT /F1 ${index === 0 ? 6 : 7} Tf ${(left + 4).toFixed(2)} ${(barcodeBottom - 8 - index * 8).toFixed(2)} Td (${pdfText(line!)}) Tj ET`);
      });
    }
    const stream = commands.join("\n");
    const pageObjectId = pageObjectIds[pageIndex]!;
    objects[pageObjectId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObjectId + 1} 0 R >>`;
    objects[pageObjectId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

export function buildInventoryLabelArtifact(
  variants: readonly InventoryLabelArtifactVariant[],
  job: InventoryLabelArtifactJob,
  currencyCode: string,
): InventoryLabelArtifact {
  const allCopies = buildCopies(variants, job);
  const copies = job.mode === "test" ? allCopies.slice(0, 1) : allCopies;
  const pageCount = Math.ceil((job.startOffset + copies.length) / (job.preset.columns * job.preset.rows));
  let artifact: Omit<InventoryLabelArtifact, "byteLength">;
  if (job.format === "csv") {
    artifact = { body: renderCsv(copies, currencyCode), contentType: "text/csv; charset=utf-8", extension: "csv", copyCount: copies.length, pageCount };
  } else if (job.format === "html") {
    artifact = { body: renderHtml(copies, job, currencyCode), contentType: "text/html; charset=utf-8", extension: "html", copyCount: copies.length, pageCount };
  } else {
    artifact = { body: renderPdf(copies, job, currencyCode), contentType: "application/pdf", extension: "pdf", copyCount: copies.length, pageCount };
  }
  const byteLength = typeof artifact.body === "string"
    ? new TextEncoder().encode(artifact.body).byteLength
    : artifact.body.byteLength;
  if (byteLength > INVENTORY_LABEL_ARTIFACT_MAX_BYTES) {
    throw new Error(`The generated label artifact exceeds ${INVENTORY_LABEL_ARTIFACT_MAX_BYTES} bytes. Reduce the label count or text length.`);
  }
  return { ...artifact, byteLength };
}
