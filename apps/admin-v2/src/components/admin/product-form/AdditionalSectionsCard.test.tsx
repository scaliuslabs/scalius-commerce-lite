// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Form } from "@/components/ui/form";
import { translate } from "~/i18n";
import { productMerchandisingMessages } from "~/i18n/product-merchandising";
import { AdditionalSectionsCard } from "./TitleDescriptionSection";
import type { ProductFormValues } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = (key: keyof typeof productMerchandisingMessages.en, vars?: Record<string, number>) =>
  translate(productMerchandisingMessages, key, vars);

function Harness({ sections }: { sections: ProductFormValues["additionalInfo"] }) {
  const form = useForm<ProductFormValues>({ defaultValues: { additionalInfo: sections } as ProductFormValues });
  return <Form {...form}><AdditionalSectionsCard form={form} readOnly={false} /></Form>;
}

describe("a new product's page content card", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("has the saved editor's title and help, and says it is empty while closed", async () => {
    await act(async () => root.render(<Harness sections={[]} />));
    expect(host.textContent).toContain(m("content"));
    expect(host.textContent).toContain(m("contentHelp"));
    expect(host.textContent).toContain(m("noBlocks"));
    expect(host.textContent).not.toContain("Extra sections");
  });
});
