import { plugin as shadcn } from "@shadcn/lint";
import rootConfig from "../../eslint.config.js";

/**
 * Dashboard design-system lint. The rules and every approved exception are
 * explained in DESIGN.md; keep the two in step.
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
];

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
  ...rootConfig,
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
];
