import type { UseFormReturn } from "react-hook-form";
import {
  FormField,
  FormMessage,
} from "../../../ui/form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../ui/card";
import { ProductSelector } from "../ProductSelector";
import { CollectionSelector } from "../CollectionSelector";
import type { FormValues, Product, Collection } from "./types";

interface AppliesToSectionProps {
  form: UseFormReturn<FormValues>;
  selectedProducts: Product[];
  selectedCollections: Collection[];
  onProductsChange: (products: Product[]) => void;
  onCollectionsChange: (collections: Collection[]) => void;
}

export function AppliesToSection({
  form,
  selectedProducts,
  selectedCollections,
  onProductsChange,
  onCollectionsChange,
}: AppliesToSectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Applies To</CardTitle>
        <CardDescription>
          Select the specific products or collections this discount will
          apply to.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <ProductSelector
          selectedProducts={selectedProducts}
          onChange={onProductsChange}
          buttonLabel="Browse Products"
        />
        <CollectionSelector
          selectedCollections={selectedCollections}
          onChange={onCollectionsChange}
          buttonLabel="Browse Collections"
        />

        <FormField
          control={form.control}
          name="appliesTo"
          render={({ fieldState }) => (
            <div>
              {fieldState.error ? (
                <FormMessage>{fieldState.error.message}</FormMessage>
              ) : null}
            </div>
          )}
        />
      </CardContent>
    </Card>
  );
}
