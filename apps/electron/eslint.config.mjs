import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { configs, config } = require("@electron-toolkit/eslint-config-ts");
const reactHooks = require("eslint-plugin-react-hooks");

export default config(
  ...configs.recommended,
  {
    // React Hooks correctness. rules-of-hooks=error (real bugs); exhaustive-deps=warn
    // (React-recommended advisory default — adding deps can change runtime behavior).
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    ignores: [
      "node_modules/**",
      "out/**",
      "dist/**",
      "coverage/**",
      "*.tsbuildinfo",
      "postcss.config.js",
      "tailwind.config.js",
    ],
  },
);
