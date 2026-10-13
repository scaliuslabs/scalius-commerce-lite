import { plugin as shadcn } from "@shadcn/lint";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { ignores } from "../../eslint.config.js";

/**
 * Dashboard design-system lint. The rules and every approved exception are
 * explained in DESIGN.md; keep the two in step. Oxlint runs every other rule.
 */

// String literals that end up as classes: className props, class helpers and
// `…ClassName` constants.
const CLASS_SITES =
  ":matches(JSXAttribute[name.name=/[cC]lassName$/], CallExpression[callee.name=/^(cn|cva|clsx|cx)$/], VariableDeclarator[id.name=/[cC]lass(Name|es)?$/])";
const variant = "(?:[\\w\\-\\[\\]=&>:.*/]+:)*";
const classRule = (pattern, message) => [
  { selector: `${CLASS_SITES} Literal[value=/${pattern}/]`, message },
  { selector: `${CLASS_SITES} TemplateElement[value.raw=/${pattern}/]`, message },
];

const designRules = [
  ...classRule(`(^|\\s)container(\\s|$)`, "Use explicit w-full max-w-* sizing instead of container; dashboard widths have one authority."),
  {
    selector: ":matches(Identifier, JSXIdentifier)[name='NativeSelect']",
    message: "NativeSelect was removed: use SearchableSelect.",
  },
  ...classRule(`(^|\\s)${variant}text-(xs|sm|base|lg|xl|[2-9]xl)(\\s|$)`, "Use the type scale: text-caption, text-body, text-body-lg or text-heading-sm/md/lg/xl (DESIGN.md)."),
  ...classRule(`(^|\\s)${variant}font-(bold|extrabold|black)(\\s|$)`, "Never bold: headings are font-semibold, inline emphasis font-medium."),
  ...classRule(`(^|\\s)${variant}tracking-`, "Never change the font's tracking."),
  ...classRule(`(^|\\s)${variant}uppercase(\\s|$)`, "Sentence case: never uppercase text."),
  ...classRule(`(^|\\s)${variant}transition(-colors|-all)?(\\s|$)`, "Hover colour changes are instant: animate only transform, opacity or size (transition-transform, transition-opacity, transition-[height])."),
  ...classRule(`(^|\\s)dark:`, "No dark: overrides; colour tokens already switch with the theme."),
  ...classRule(`^(?=.*(^|\\s)border(\\s|$))(?=.*(^|\\s)shadow-(?!none)).*$`, "Never a border and a drop shadow together: use a shadow token (it carries its own ring edge) or a ring."),
  ...classRule(`^(?=.*(^|\\s)${variant}sticky(\\s|$))(?!.*(^|\\s)${variant}border(-[trblxy])?(\\s|$)).*$`, "Sticky bars need a border separating them from the content."),
  {
    selector: ":matches(LogicalExpression[operator='&&'], ConditionalExpression) > JSXElement[openingElement.name.name=/^(Dialog|AlertDialog|Sheet)$/]",
    message: "Never conditionally render dialogs; keep them mounted and control them with `open`.",
  },
  {
    selector: "JSXElement[openingElement.name.name='Card'] JSXElement[openingElement.name.name='Card']",
    message: "Never stack a Card inside a Card; use sections, dividers or a Table inside one card.",
  },
  {
    selector: "JSXOpeningElement[name.name='select']",
    message: "Use SearchableSelect for fixed choices and options from data (DESIGN.md).",
  },
];

// Screens use Field, FieldSet and ChoiceField from components/ui/field (F1).
const fieldRules = [
  {
    selector: ":matches(FunctionDeclaration[id.name=/Field$/], VariableDeclarator[id.name=/Field$/]):has(JSXOpeningElement[name.name='Label']):has(JSXOpeningElement[name.name=/^(Input|Textarea|SearchableSelect|NumberInput|MoneyInput|PercentInput|CostInput|DateInput)$/])",
    message: "A local field copy: use Field, FieldSet or ChoiceField from components/ui/field (DESIGN.md F1).",
  },
  {
    // A Label right inside an element whose className (one of its first four attributes) uses space-y.
    selector: `:matches(${[0, 1, 2, 3].map((index) => `JSXElement[openingElement.attributes.${index}.value.value=/(^|\\s)space-y-/]`).join(", ")}) > JSXElement[openingElement.name.name='Label']`,
    message: "A label stacked with space-y: use Field from components/ui/field (DESIGN.md F1, S2).",
  },
  {
    selector: "JSXElement[openingElement.name.name='Label'] ~ JSXElement[openingElement.name.name=/^(Input|Textarea|SearchableSelect|NumberInput|MoneyInput|PercentInput|CostInput|DateInput)$/]",
    message: "A bare Label beside a control: use Field from components/ui/field (DESIGN.md F1).",
  },
];

// Icon-only buttons are named (C7): an icon size needs aria-label (or asChild with a named child).
const buttonRules = [
  {
    selector: "JSXOpeningElement[name.name='Button']:has(JSXAttribute[name.name='size'] > Literal[value=/^icon/]):not(:has(JSXAttribute[name.name=/^(aria-label|aria-labelledby|asChild)$/]))",
    message: "An icon-only Button needs an aria-label naming its action (DESIGN.md C7).",
  },
];

// All dashboard choices use the viewport-aware SearchableSelect; screens toast
// through ~/lib/toast, so sonner loads after a page's first render.
const restrictedImports = (extraPaths = [], extraPatterns = []) => ({
  "no-restricted-imports": [
    "error",
    {
      paths: [{ name: "@radix-ui/react-select", message: "Use SearchableSelect from components/ui." }, ...extraPaths],
      patterns: [
        {
          group: ["**/components/ui/select", "~/components/ui/select", "@/components/ui/select", "./select", "**/native-select", "**/native-select.*", "**/components/ui/select.*"],
          message: "Legacy selects were removed: use SearchableSelect.",
        },
        ...extraPatterns,
      ],
    },
  ],
});

// Polish bar T1: every list of records is the index-table kit. The raw table
// is the kit's, plus line editors and read-only summaries inside one record
// (order lines, a report, a delivery log) on this allowlist.
const TABLE_OWNERS = [
  "src/components/ui/**",
  "src/components/admin/data-table/**",
  "src/components/admin/analytics/ReportTable.tsx",
  "src/components/admin/apps/AppActivity.tsx",
  "src/components/admin/apps/ui/PluginUiRenderer.tsx",
  "src/components/admin/attributes-manager/components/AttributeValueEditor.tsx",
  "src/components/admin/price-lists/PriceListPrices.tsx",
  "src/components/admin/purchasing/PurchaseOrderDetail.tsx",
  "src/components/admin/purchasing/PurchaseOrderEditor.tsx",
  "src/components/admin/purchasing/ReceiveLines.tsx",
  "src/components/admin/purchasing/TransferDetail.tsx",
  "src/components/admin/purchasing/TransferEditor.tsx",
  "src/components/admin/settings/languages/LanguagesSettings.tsx",
  "src/components/admin/settings/markets/MarketsList.tsx",
  "src/components/admin/settings/webhooks/WebhookDeliveriesSheet.tsx",
  "src/components/admin/taxes/TaxesSettings.tsx",
];
const rawTable = {
  group: ["**/components/ui/table", "~/components/ui/table", "@/components/ui/table", "**/ui/table"],
  message: "Lists of records use the index-table kit (components/admin/data-table, DESIGN.md Tables, T1).",
};
const sonnerToast = { name: "sonner", importNames: ["toast"], message: "Import toast from ~/lib/toast: sonner loads after a page's first render." };

const designSystem = (level) => ({
  "shadcn/no-restyle": [
    level,
    {
      allow: ["layout"],
      contracts: [
        // Titles may pick a step of the type scale.
        { pattern: "^(CardTitle|DialogTitle|SheetTitle|AlertDialogTitle)$", allow: ["layout", "typography"] },
        // Containers whose padding and gap belong to the page.
        {
          pattern: "^(Card|CardContent|CardHeader|CardFooter|DialogContent|SheetContent|PopoverContent|TableCell|TableHead|TabsContent)$",
          allow: ["layout", "spacing"],
        },
      ],
    },
  ],
  "shadcn/no-raw-colors": level,
  // Layout values (widths, offsets, grid templates, icon alignment margins) and
  // property-specific transitions may be arbitrary.
  "shadcn/no-arbitrary-values": [level, { allow: ["layout", "transition-[*]"] }],
  // Runtime values (merchant colours, image widths, progress) only as custom properties.
  "shadcn/no-inline-styles": [level, { allow: ["--*"] }],
  // Classes owned by the rich-content stylesheet rather than by Tailwind.
  "shadcn/no-unknown-classes": [level, { allow: ["rich-content", "ProseMirror"] }],
  "shadcn/require-static-classes": level,
  "no-restricted-syntax": [level, ...designRules],
});

export default [
  { ignores },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    // Oxlint owns every generic rule (.oxlintrc.json); these plugins stay
    // registered, with no rule on, so their disable comments still resolve.
    plugins: { "@typescript-eslint": tseslint.plugin, "react-hooks": reactHooks },
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    files: ["src/**/*.tsx"],
    ignores: ["src/**/*.test.tsx"],
    plugins: { shadcn },
    settings: {
      shadcn: {
        ui: ["~/components/ui", "@/components/ui"],
        note: "See apps/admin-v2/DESIGN.md.",
      },
    },
    // Feature screens warn until the post-integration sweep; then switch to "error".
    rules: designSystem("error"),
  },
  {
    files: ["src/components/ui/**/*.tsx"],
    ignores: ["src/**/*.test.tsx"],
    rules: designSystem("error"),
  },
  {
    // One Field family (DESIGN.md F1): screens never hand-build a label stack.
    files: ["src/**/*.tsx"],
    ignores: ["src/**/*.test.tsx", "src/components/ui/**"],
    rules: {
      "no-restricted-syntax": ["error", ...designRules, ...fieldRules, ...buttonRules],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: restrictedImports(),
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/lib/toast.ts"],
    rules: restrictedImports([sonnerToast]),
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/lib/toast.ts", ...TABLE_OWNERS],
    rules: restrictedImports([sonnerToast], [rawTable]),
  },
];
