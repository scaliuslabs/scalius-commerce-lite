export interface AttributeAssignmentIdentity {
  attributeId: string;
  value: string;
}

export function attributeAssignmentSignature(
  attributes: AttributeAssignmentIdentity[],
): string {
  return attributes
    .map((attribute) => `${attribute.attributeId.trim()}\u0000${attribute.value.trim()}`)
    .join("\u0001");
}

export function mergeAttributeValuePages<T extends { value: string }>(
  current: T[],
  incoming: T[],
): T[] {
  const values = new Map(current.map((item) => [item.value.trim().toLowerCase(), item]));
  for (const item of incoming) values.set(item.value.trim().toLowerCase(), item);
  return [...values.values()];
}
