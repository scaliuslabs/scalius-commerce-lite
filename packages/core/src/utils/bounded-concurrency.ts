export async function mapWithBoundedConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new RangeError("concurrency must be a positive integer");
    }

    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        async () => {
            while (nextIndex < items.length) {
                const index = nextIndex;
                nextIndex += 1;
                results[index] = await mapper(items[index]!, index);
            }
        },
    );
    await Promise.all(workers);
    return results;
}
