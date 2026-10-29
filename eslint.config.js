// ESLint flat config (`npm run lint`). Type errors are tsc's job (`npm run
// typecheck`); this catches what the compiler doesn't: the core and
// typescript-eslint recommended rules, and the Rules of Hooks in the React app.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "dist/",
    ".tenant-bundle/",
    ".wrangler/",
    "coverage/",
    "worker-configuration.d.ts",
    // The Android app's build output and its generated native project files.
    "apps/android/dist/",
    "apps/android/android/",
  ]),
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // `_name` marks a value that is deliberately unused, and an omitted
      // property in `const { secret: _removed, ...rest } = x` is the point.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // The React app (and its shared code): browser globals and the Rules of Hooks.
    files: ["src/client/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    // The Workers (OpenPing's and the Hosted platform's), and the service
    // worker the browser installs.
    files: ["src/worker/**/*.ts", "platform/src/**/*.ts", "platform/test/**/*.ts", "public/**/*.js", "scripts/region-probe/*.mjs"],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    // The Android app's own screens (apps/android, docs/ANDROID.md).
    files: ["apps/android/src/**/*.ts"],
    languageOptions: { globals: globals.browser },
  },
  {
    // Node tooling: scripts and configs.
    files: ["scripts/**/*.{mjs,ts}", "*.config.{js,ts}", "platform/*.config.ts", "apps/android/*.config.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    // Tests read untyped JSON responses and build loose fixtures.
    files: ["**/*.test.{ts,tsx,mjs}", "test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
]);
