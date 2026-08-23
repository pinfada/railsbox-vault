import eslint from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "playwright-report/**", "test-results/**"],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.worker,
      },
    },
  },
];
