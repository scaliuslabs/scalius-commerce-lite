type ProductNavigationWindow = Window & {
  __productEditNavigate?: (url: string) => Promise<void>;
  navigateToProductEdit?: (url: string) => Promise<void>;
  handleProductSubmit?: (values: unknown) => Promise<void>;
};

export function initProductNewPage(): void {
  const win = window as ProductNavigationWindow;

  // Navigation helper — cached across client-side navigations
  win.__productEditNavigate ??= async (url: string) => {
    const { navigateTo } = await import("@/lib/client/navigate");
    await navigateTo(url);
  };
  win.navigateToProductEdit = win.__productEditNavigate;

  // Submit handler — defined as a normal function (no eval)
  win.handleProductSubmit = async (values: unknown) => {
    try {
      const response = await fetch("/api/v1/admin/products", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(values),
      });

      if (!response.ok) {
        throw new Error("Failed to create product");
      }

      const json = await response.json();
      const data = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
      const destination = `/admin/products/${data.id}/edit`;
      if (typeof win.navigateToProductEdit !== "function") {
        throw new Error("Product navigation helper is unavailable");
      }

      await win.navigateToProductEdit(destination);
    } catch (error: unknown) {
      console.error("Error creating product:", error);
      alert("Failed to create product. Please try again.");
    }
  };
}
