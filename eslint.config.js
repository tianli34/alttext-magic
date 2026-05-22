import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import jsxA11yPlugin from "eslint-plugin-jsx-a11y";
import importPlugin from "eslint-plugin-import";
import globals from "globals";

export default [
  {
    ignores: [
      "build",
      "public/build",
      "dist-worker",
      ".react-router",
      "**/*.yml",
      ".shopify",
      "!**/.server/**",
      "!**/.client/**",
    ],
  },

  js.configs.recommended,

  ...tseslint.configs.recommended,

  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
      "jsx-a11y": jsxA11yPlugin,
      import: importPlugin,
    },
    rules: {
      ...reactPlugin.configs.flat.recommended.rules,
      ...reactPlugin.configs.flat["jsx-runtime"].rules,
      ...reactHooksPlugin.configs.flat.recommended.rules,
      ...jsxA11yPlugin.flatConfigs.recommended.rules,
      ...importPlugin.flatConfigs.recommended.rules,
      "react/no-unknown-property": ["error", { ignore: ["variant"] }],
    },
    settings: {
      react: { version: "detect" },
      formComponents: ["Form"],
      linkComponents: [
        { name: "Link", linkAttribute: "to" },
        { name: "NavLink", linkAttribute: "to" },
      ],
      "import/internal-regex": "^~/",
      "import/resolver": {
        node: { extensions: [".ts", ".tsx"] },
        typescript: { alwaysTryTypes: true },
      },
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        shopify: "readonly",
      },
    },
  },

  {
    files: ["**/*.{ts,tsx}"],
    rules: importPlugin.flatConfigs.typescript.rules,
    settings: importPlugin.flatConfigs.typescript.settings,
  },

  {
    files: [
      "eslint.config.js",
      "**/vite.config.{js,ts}",
      "**/.graphqlrc.{js,ts}",
      "**/shopify.server.{js,ts}",
      "**/*.server.{js,ts}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
