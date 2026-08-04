import { createRoot } from "react-dom/client";
import AuthModal from "@/components/AuthModal";

let mounted = false;

export function mountAuthModal(): void {
  if (mounted) return;
  mounted = true;
  const root = document.createElement("div");
  root.dataset.lazyUi = "auth-modal";
  document.body.append(root);
  createRoot(root).render(<AuthModal />);
}
