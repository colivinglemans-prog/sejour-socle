import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Les articles du guide sont de la prose française écrite directement en JSX.
    // `react/no-unescaped-entities` vise les `>` et `}` tapés par accident ; sur du
    // texte suivi, il ne signale que des apostrophes parfaitement légitimes. Écrire
    // « l&apos;appartement » partout rendrait les articles illisibles à la rédaction,
    // pour un rendu strictement identique. La règle reste active partout ailleurs.
    files: ["**/content/**/*.tsx"],
    rules: { "react/no-unescaped-entities": "off" },
  },
]);

export default eslintConfig;
