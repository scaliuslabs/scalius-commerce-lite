import { createRoot } from "react-dom/client";
import CommandPalette from "@/components/search/CommandPalette";

let mounted = false;

export function mountCommandPalette(): void {
  if (mounted) return;
  mounted = true;
  const root = document.createElement("div");
  root.dataset.lazyUi = "command-palette";
  document.body.append(root);
  createRoot(root).render(<CommandPalette />);
}
