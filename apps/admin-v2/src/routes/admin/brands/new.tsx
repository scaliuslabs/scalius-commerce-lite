import { createFileRoute } from "@tanstack/react-router";
import { BrandForm } from "~/components/admin/BrandForm";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/brands/new")({
  head: () => pageHead("addBrand"),
  component: NewBrandPage,
});

function NewBrandPage() {
  return <BrandForm />;
}
