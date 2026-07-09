import type { AssistantMessagePart } from "@scalius/shared/assistant-contracts";

import { AssistantProductCard } from "./AssistantProductCard";

type AssistantComparisonPart = Extract<
  AssistantMessagePart,
  { type: "comparison" }
>;

type AssistantComparisonProps = {
  comparison: AssistantComparisonPart;
  canNavigate: (path: string) => boolean;
  onNavigate: (path: string, label: string) => void;
};

export function AssistantComparison({
  comparison,
  canNavigate,
  onNavigate,
}: AssistantComparisonProps) {
  const productsById = new Map(
    comparison.products.map((product) => [product.id, product]),
  );

  return (
    <section aria-label={comparison.title} className="grid gap-3">
      <h3 className="text-sm font-semibold text-foreground">
        {comparison.title}
      </h3>
      <div className="overflow-x-auto pb-1">
        <div className="grid min-w-max grid-flow-col auto-cols-[13rem] gap-2">
          {comparison.products.map((product) => (
            <AssistantProductCard
              key={product.id}
              product={product}
              compact
              canNavigate={canNavigate}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/90">
        <table className="w-full min-w-[32rem] border-collapse text-left text-xs">
          <caption className="sr-only">{comparison.title} details</caption>
          <thead className="bg-muted/60 text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold">
                Detail
              </th>
              {comparison.products.map((product) => (
                <th
                  key={product.id}
                  scope="col"
                  className="max-w-44 px-3 py-2 font-semibold text-foreground"
                >
                  {product.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {comparison.rows.map((row) => (
              <tr key={row.label}>
                <th
                  scope="row"
                  className="bg-muted/25 px-3 py-2 font-medium text-foreground"
                >
                  {row.label}
                </th>
                {comparison.products.map((product) => {
                  const cell = row.cells.find(
                    (candidate) => candidate.productId === product.id,
                  );
                  return (
                    <td
                      key={product.id}
                      className="px-3 py-2 text-muted-foreground"
                    >
                      {cell?.status === "unknown"
                        ? "Not provided"
                        : cell?.status === "not_applicable"
                          ? "Not applicable"
                          : cell?.value ||
                            (productsById.has(product.id)
                              ? "Not provided"
                              : "Unavailable")}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
