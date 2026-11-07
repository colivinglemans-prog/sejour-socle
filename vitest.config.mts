/**
 * Tests unitaires du socle — des tests de **caractérisation** : ils figent le comportement
 * actuel des modules purs à fort enjeu (taxe de séjour, fiscal, sélection de séjour,
 * numérotation des factures), sans navigateur ni réseau.
 *
 * Ils vivent dans `tests/` et non à côté des modules : le motif d'export `./lib/*` rendrait
 * un `lib/x.test.ts` importable par les sites, et rien de ce dossier ne doit l'être. Le
 * protocole de bout en bout (`npm run protocole`) reste la vérification d'intégration ;
 * ceci est la couche du dessous.
 *
 * Le fuseau est fixé à Paris : `lib/dates.ts` travaille en heure locale, et un test qui
 * passe à Paris mais pas sur une machine en UTC serait un test qui ment.
 */
import { defineConfig } from "vitest/config";

process.env.TZ = "Europe/Paris";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
