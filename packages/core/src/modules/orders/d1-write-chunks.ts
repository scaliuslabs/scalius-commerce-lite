// D1 accepts at most 100 bound parameters per statement. Keep one slot in
// reserve for future surrounding predicates/expressions and size multi-row
// inserts from their conservative per-row parameter count.
const D1_SAFE_BOUND_PARAMETER_LIMIT = 99;

export function chunkRowsForD1<T>(
    rows: readonly T[],
    parametersPerRow: number,
): T[][] {
    if (!Number.isSafeInteger(parametersPerRow) || parametersPerRow < 1) {
        throw new RangeError("parametersPerRow must be a positive integer");
    }

    const rowsPerStatement = Math.max(
        1,
        Math.floor(D1_SAFE_BOUND_PARAMETER_LIMIT / parametersPerRow),
    );
    const chunks: T[][] = [];
    for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
        chunks.push(rows.slice(offset, offset + rowsPerStatement));
    }
    return chunks;
}
