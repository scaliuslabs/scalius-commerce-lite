/**
 * The built-in staff roles by their stored key, and their names in each
 * dashboard language: the one source for the role picker, the approval page,
 * an agent's approval summary and the names a new store is seeded with.
 * Custom roles keep the name the merchant typed.
 */
export const BUILT_IN_ROLE_NAMES = {
  en: {
    super_admin: "Super admin",
    manager: "Manager",
    sales_rep: "Sales representative",
    content_editor: "Content editor",
    product_specialist: "Product specialist",
  },
  bn: {
    super_admin: "সুপার অ্যাডমিন",
    manager: "ম্যানেজার",
    sales_rep: "সেলস রিপ্রেজেন্টেটিভ",
    content_editor: "কনটেন্ট এডিটর",
    product_specialist: "প্রোডাক্ট স্পেশালিস্ট",
  },
} as const satisfies Record<"en" | "bn", Record<string, string>>;

export type BuiltInRoleKey = keyof typeof BUILT_IN_ROLE_NAMES.en;
export const BUILT_IN_ROLE_KEYS = Object.keys(BUILT_IN_ROLE_NAMES.en) as [BuiltInRoleKey, ...BuiltInRoleKey[]];

/** The built-in role a stored role name is, or null for a custom role. */
export function builtInRoleKey(name: string): BuiltInRoleKey | null {
  return Object.hasOwn(BUILT_IN_ROLE_NAMES.en, name) ? (name as BuiltInRoleKey) : null;
}
