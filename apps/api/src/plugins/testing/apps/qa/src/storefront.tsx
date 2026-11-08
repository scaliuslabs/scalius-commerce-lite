/** @jsxImportSource @scalius/plugin-sdk/storefront */
// Product Q&A's storefront module: the answered questions of the product on
// the page, from the component's declared read (`objects`), which the host
// reads for that product with the page's template part.

import { defineStorefront, type ProductSlotComponentProps } from "@scalius/plugin-sdk/storefront";

function Questions(props: ProductSlotComponentProps<{ heading: string }>) {
  const records = props.objects?.["acme.qa.questions"]?.records ?? [];
  if (records.length === 0) return null;
  return (
    <section class="qa" data-product={props.data.product.id}>
      <h2>{props.settings.heading}</h2>
      <dl>
        {records.map((record) => (
          <div class="qa-item" data-question={record.handle ?? record.id}>
            <dt>{String(record.data.question ?? "")}</dt>
            <dd>{String(record.data.answer ?? "")}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default defineStorefront({ components: { questions: Questions } });
