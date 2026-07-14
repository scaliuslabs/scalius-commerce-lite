function exactMap(rows, field, label) {
  const result = new Map();
  for (const row of rows ?? []) {
    if (result.has(row[field])) throw new Error(`${label} exact identity is ambiguous: ${row[field]}`);
    result.set(row[field], row);
  }
  return result;
}

function combinationKeys(product) {
  return product.variants.map((variant) => variant.optionValues.join("\u001f")).sort();
}

function currentCombinationKeys(detail) {
  return (detail.variants ?? [])
    .map((variant) => (variant.selectedOptions ?? []).slice().sort((a, b) => a.position - b.position).map((item) => item.value).join("\u001f"))
    .sort();
}

export function assertRetainedProductAuthority(manifest, snapshot, readiness) {
  const details = exactMap(snapshot.productDetails, "slug", "Product details");
  for (const product of manifest.products.filter((item) => item.retainedProductId)) {
    const detail = details.get(product.slug);
    if (!detail || detail.id !== product.retainedProductId) throw new Error(`Retained product identity is missing or changed for ${product.slug}.`);
    const intendedAxes = product.options.map((option) => option.name);
    const currentAxes = (detail.options ?? []).slice().sort((a, b) => a.position - b.position).map((option) => option.name);
    if (JSON.stringify(intendedAxes) !== JSON.stringify(currentAxes)) throw new Error(`Retained option axes changed for ${product.slug}.`);
    if (JSON.stringify(combinationKeys(product)) !== JSON.stringify(currentCombinationKeys(detail))) throw new Error(`Retained option topology changed for ${product.slug}.`);
    for (const variant of detail.variants ?? []) {
      if (![variant.stock, variant.reservedStock, variant.stockVersion].every(Number.isSafeInteger)) throw new Error(`Retained stock authority is incomplete for ${product.slug}.`);
    }
    const allowedMediaIds = new Set(product.media
      .filter((item) => item.role !== "poster")
      .flatMap((item) => {
        const asset = readiness.assets.get(item.logicalKey);
        return [asset?.mediaId, asset?.retainedReplacement?.mediaId].filter(Boolean);
      }));
    if ((detail.media ?? []).some((item) => item.status === "ready" && !allowedMediaIds.has(item.mediaId))) {
      throw new Error(`Retained media would be removed without exact replacement authority for ${product.slug}.`);
    }
  }
}
