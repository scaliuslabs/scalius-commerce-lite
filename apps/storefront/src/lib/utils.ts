// src/lib/utils.ts
//
// cn() has been removed — use `import { cn } from "@scalius/shared/utils"` instead.
// This file retains storefront-specific utilities only.

/**
 * A utility function to debounce function calls.
 * @param func The function to debounce.
 * @param wait The delay in milliseconds.
 * @returns A debounced version of the function.
 */
export function debounce<T extends (...args: Parameters<T>) => void>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  return function executedFunction(...args: Parameters<T>): void {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };

    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
