// Debounce utility

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic debounce requires any for flexible function signatures
export function debounce<F extends (...args: any[]) => any>(
  func: F,
  waitFor: number,
) {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: Parameters<F>) => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    timeout = setTimeout(() => func(...args), waitFor);
  };

  return debounced as (...args: Parameters<F>) => ReturnType<F>;
}
