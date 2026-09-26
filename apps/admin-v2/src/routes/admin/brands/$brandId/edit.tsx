import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { BrandForm, brandFormValues } from "~/components/admin/BrandForm";
import { brandQueryOptions } from "~/lib/api-query-options/brands";
import { RouteErrorComponent } from "~/lib/route-error";
import { nullForAdminApiNotFound } from "~/lib/admin-api-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/brands/$brandId/edit")({
  loader: async ({ params, context: { queryClient } }) => {
    const brand = await queryClient
      .ensureQueryData({ ...brandQueryOptions(params.brandId), staleTime: Infinity })
      .catch(nullForAdminApiNotFound);
    if (!brand) throw redirect({ to: "/admin/brands" });
    if (brand.deletedAt != null) throw redirect({ to: "/admin/brands", search: { trashed: true } as never });
  },
  head: () => pageHead("brand"),
  errorComponent: RouteErrorComponent,
  component: EditBrandPage,
});

function EditBrandPage() {
  const { brandId } = Route.useParams();
  const { data } = useSuspenseQuery(brandQueryOptions(brandId));
  return <BrandForm key={brandId} defaultValues={brandFormValues(data)} />;
}
