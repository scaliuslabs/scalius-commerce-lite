import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import astroPlugin from "eslint-plugin-astro";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
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
    ],
  },

  // Base recommended rules
  eslint.configs.recommended,

  // TypeScript recommended (NOT strict — keep noise low for existing codebase)
  ...tseslint.configs.recommended,

  // Astro flat config
  ...astroPlugin.configs["flat/recommended"],

  // Global settings
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },

  // TypeScript overrides — lenient for existing codebase
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.astro"],
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

  // React hooks rules for TS/TSX files. Several hook helpers live in .ts files.
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // Sanitizer helpers intentionally match control characters and bidi ranges.
  {
    files: [
      "packages/shared/src/css-sanitize.ts",
      "packages/shared/src/css-scope.ts",
      "packages/shared/src/html-sanitize.ts",
    ],
    rules: {
      "no-control-regex": "off",
      "no-misleading-character-class": "off",
    },
  },
);
