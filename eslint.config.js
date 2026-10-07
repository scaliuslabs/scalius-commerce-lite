import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import astroPlugin from "eslint-plugin-astro";
import globals from "globals";

/**
 * ESLint covers only what Oxlint cannot: `.astro` templates (here) and the
 * dashboard design rules (apps/admin-v2/eslint.config.js). Every TypeScript
 * and JavaScript rule lives in `.oxlintrc.json` (`pnpm lint:oxlint`).
 */
export const ignores = [
  "node_modules/**",
  "**/node_modules/**",
  "dist/**",
  "**/dist/**",
  ".astro/**",
  "**/.astro/**",
  ".wrangler/**",
  "**/.wrangler/**",
  "**/migrations/**",
  "**/*.gen.ts",
  "**/*.gen.js",
];

const ASTRO_FILES = ["**/*.astro", "**/*.astro/*.js", "**/*.astro/*.ts"];
const onlyAstro = (configs) => configs.map((config) => ({ ...config, files: ASTRO_FILES }));

export default tseslint.config(
  { ignores },
  ...onlyAstro([eslint.configs.recommended, ...tseslint.configs.recommended]),
  ...astroPlugin.configs["flat/recommended"],
  {
    files: ASTRO_FILES,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    // Lenient, as for the rest of the codebase (.oxlintrc.json).
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/ban-ts-comment": "off",
      "no-console": "off",
      "preserve-caught-error": "off",
      "prefer-const": "warn",
      "no-useless-assignment": "warn",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/triple-slash-reference": "off",
      "no-undef": "off",
      "no-var": "warn",
      "no-empty": "warn",
      "no-useless-escape": "warn",
      "prefer-rest-params": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "no-empty-pattern": "warn",
      "no-case-declarations": "warn",
    },
  },
);
