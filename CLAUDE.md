# `@sejour/socle` — socle partagé

Code commun aux sites de location saisonnière. Deux consommateurs aujourd'hui :

| Site | Chemin local | Bien |
|---|---|---|
| Albiez | `D:\Workspace Perso\Albiez` | appartement de montagne, SCI JUARISAL |
| Coliving Barbusse | `D:\Workspace Perso\ColivingBarbusse\coliving-barbusse` | maison au Mans, entreprise individuelle |

## Pourquoi ce dépôt existe

Le couplage entre les deux sites existait déjà, mais par copie manuelle — et le code le disait
lui-même : `lib/auth.ts` d'Albiez porte « reprise telle quelle de Barbusse », `lib/periodes.ts`
de Barbusse porte « Module copié depuis Albiez, pas partagé […] tenu identique […] pour que
toute correction se reporte sans réflexion », `lib/stats.ts` d'Albiez porte « ce qui permettra
à Barbusse de reprendre le composant sans le réécrire ».

Ce dépôt remplace la copie manuelle par une dépendance explicite. Il ne crée pas le couplage :
il le rend vérifiable.

## Comment il est consommé

Aucun build. Le socle expose du TS/TSX brut, compilé par Next dans l'application :

```jsonc
// package.json de l'app
"@sejour/socle": "github:colivinglemans-prog/sejour-socle#v0.3.0"
```
```ts
// next.config.ts de l'app
transpilePackages: ["@sejour/socle"],
```

Chaque site épingle son tag et peut rester sur le précédent : c'est le filet de sécurité du
chantier, il n'y a pas de big bang. Un rollback est une ligne de `package.json`.

Boucle de dev locale : `npm link ../../sejour-socle` dans l'app. Jamais commité.

## Règles

**1. Aucun module ne connaît le nom d'un site.** Pas de `if (site === "albiez")`, pas de
`PROPERTY_ID = 303771`, pas de nom d'entité dans un sujet d'e-mail. Ce qui varie est une donnée
injectée via `config/types.ts` (`PropertyConfig`).

**2. Un paramètre est une donnée, pas un drapeau.** `taxeSejour: { tauxPourcent, plafondEuros }`
est bon ; `modeTaxeLeMans: true` est refusé. Un `boolean` dans une signature est presque
toujours le signe d'une généralisation ratée.

**3. Imports internes relatifs, jamais aliasés.** L'alias `@/*` des applications ne résout pas
ici. À l'intérieur du socle, on écrit `./dates` et `../config/types`.

**4. Nommage — anglais technique, français réglementaire.** `Booking`, `getBookings`,
`normalizeChannel`, `RevenueMode`, `placeSegments`. Mais `lib/periodes.ts`, `lib/taxe-sejour/`
et `lib/fiscal/` gardent leur français : `BienFiscal`, `computeBICBien`,
`amortissementsReportes`, `Echeance`. Commentaires, JSDoc et messages d'erreur en français.

**5. En cas de divergence entre les deux sites, Albiez gagne — sauf motif écrit.** L'inventaire
comparatif a montré qu'Albiez est presque systématiquement en avance : `proxy.ts` (Next 16),
`locales.ts` sans import pour l'edge, `<html lang>` correct, imports paresseux du blog,
`lib/seo.ts` générique, moteur de lanes factorisé, `prefers-reduced-motion`, `sandbox` 3-D
Secure, fail-safe du rôle, jamais de `toISOString()`. Quand on retient Barbusse, on écrit
pourquoi dans l'en-tête du module.

**6. On n'extrait pas « au cas où ».** Un module qui n'a qu'un seul appelant réel reste chez
son site.

## Arbitrages tranchés

Décisions prises une fois, à ne pas rediscuter à chaque lot.

| Sujet | Décision | Date |
|---|---|---|
| Distribution | Dépendance git épinglée par tag, TS brut, `transpilePackages`. Pas de monorepo — les deux dépôts ont chacun leur identité git et leur entité juridique. | 2026-09-11 |
| Modèle de données | Type canonique `Booking` dans le socle ; chaque site y traduit Beds24 **et** son archive. Les types Beds24 bruts restent disponibles pour le code réellement API-adjacent. | 2026-09-11 |
| Rôle restreint | `viewer`. Albiez renomme son `menage`, **variables Vercel comprises** (`DASHBOARD_PASSWORD_MENAGE*` → `DASHBOARD_PASSWORD_VIEWER*`, prod et dev). | 2026-09-11 |
| Couleurs de canal | Celles d'Albiez : Abritel `#1668E3`, Direct `#0E9F6E`, Autre `#9ca3af`. Airbnb `#FF385C` et Booking `#003580` sont officielles et déjà communes. | 2026-09-11 |
| Design | Mêmes 7 tokens sémantiques et mêmes polices ; un fichier de valeurs par site. Albiez reste bleu alpin, Barbusse rose Airbnb. Trio d'accents optionnel pour la couche `[data-season]` d'Albiez. | 2026-09-11 |
| Périmètre | Noyau + dashboard + réglementaire français. Vitrine, i18n, blog et photos restent chez chaque site (Lot 5, non engagé). | 2026-09-11 |

## Ce qui n'entre jamais

Contenu d'articles de blog, dictionnaires i18n, `public/`, données propres à un bien, photos.
`heatzy.ts` / `cozytouch.ts` et les crons (Barbusse). `seasons.ts` et sa descendance, `AWARDS`,
`property.ts`, `legal.ts` (Albiez). Ce sont les **valeurs**, pas les mécanismes.

## Les agents

Définis dans `.claude/agents/`, recopiés dans les deux dépôts applicatifs.

| Agent | Rôle |
|---|---|
| 🛃 `le-douanier` | Qualité du socle. Rien n'entre sans son tampon. |
| 🔧 `tonton-tuyau` | Noyau technique : dates, canaux, périodes, thème, config. |
| 🐕 `cerbere` | Auth, rôles, proxy, cloisonnement serveur. |
| 🏺 `champollion` | Beds24, type canonique `Booking`, archive. |
| 🔮 `madame-soleil` | Stats, graphes, calendrier de dashboard. |
| 💰 `le-percepteur` | Factures, taxe de séjour, fiscal. |
| 🏔️ `le-dahu` | Responsable du site Albiez. Droit de veto. |
| 🏁 `chef-de-stand` | Responsable du site Barbusse. Droit de veto. |
| 🎪 `monsieur-loyal` | *(réserve)* Tunnel de réservation. |
| 🐟 `poisson-babel` | *(réserve)* i18n, SEO, blog. |

`le-dahu` et `chef-de-stand` sont **adverses par construction** : leur travail est de refuser
une généralisation qui abîmerait leur site, pas de la faciliter. Aucun tag ne sort sans leurs
deux validations.

## Feuille de route

| Lot | Contenu | Agent | Tag |
|---|---|---|---|
| 0 | Amorçage + les 5 modules à ≥ 85 % de recouvrement | `tonton-tuyau` | `v0.1` |
| 1 | Auth, rôles, cloisonnement — **ferme la fuite `NUKI_PIN`** | `cerbere` | `v0.2` |
| 2 | Beds24 + modèle canonique `Booking` | `champollion` | `v0.3` |
| 3 | Dashboard | `madame-soleil` | `v0.4` |
| 4 | Factures, taxe de séjour, fiscal | `le-percepteur` | `v0.5` |
| 5 | Vitrine — *proposé, non engagé* | `monsieur-loyal`, `poisson-babel` | — |

Plan détaillé : `C:\Users\alexa\.claude\plans\cheerful-toasting-rivest.md`.

## Modules

*(Cette section se remplit lot par lot. À chaque module extrait, la section correspondante des
`CLAUDE.md` applicatifs est remplacée par un renvoi d'une ligne vers ici.)*

### Lot 0 — noyau technique

| Chemin | Contenu | Vient de |
|---|---|---|
| `lib/periodes.ts` | Vacances scolaires par zone, semaines de fêtes, bandes de calendrier. Français réglementaire conservé. | Albiez (copie octet pour octet chez Barbusse) |
| `data/vacances-scolaires.json` | Données générées, versionnées : le site ne fait aucun appel réseau à l'exécution. | identique des deux côtés |
| `scripts/build-vacances.mjs` | Régénère le JSON depuis l'open data du ministère. À relancer chaque rentrée, **depuis le socle**. | identique à un mot de commentaire près |
| `lib/dates.ts` | Les 7 helpers de jour calendaire, en heure locale. Noms anglais. | identiques ligne pour ligne après renommage |
| `lib/channels.ts` | `Channel`, `CHANNELS`, `CHANNEL_COLORS`, `normalizeChannel`. | Albiez, palette arbitrée |
| `lib/time.ts` | `nowParis`, `currentHourParis`, `todayParis`, `tomorrowParis`. | Barbusse (Albiez ne l'a pas encore) |
| `lib/cron-auth.ts` | `verifyCronAuth` — pas de `CRON_SECRET`, pas d'accès. | Barbusse |
| `lib/ntfy.ts` | `sendNtfy`, encodage RFC 2047 des titres accentués. | Barbusse |
| `ui/theme.css` | `@theme inline`, `.prose-article`, `.hide-scrollbar`, `prefers-reduced-motion`. | structure commune |

Ce qui **n'est pas** monté avec eux, et pourquoi :

- `MONTH_NAMES_FR` / `DAY_NAMES_FR` (Barbusse) — les noms de mois viennent du dictionnaire
  i18n (`t.calendar.monthNames`). Ils étaient déjà morts dans le code : supprimés.
- Les **valeurs** de couleur des sept tokens — un fichier par site, c'est l'arbitrage Design.

### Comment une application s'y branche

```jsonc
// package.json
"@sejour/socle": "github:colivinglemans-prog/sejour-socle#v0.1.0"
```
```ts
// next.config.ts
transpilePackages: ["@sejour/socle"],
```
```css
/* app/globals.css — les @import restent en tête de fichier */
@import "tailwindcss";
@import "@sejour/socle/ui/theme.css";
:root { --site-background: …; /* les 7 valeurs, + le trio d'accents si le site en a un */ }
```

Les sous-chemins sont déclarés dans `exports` et pointent droit sur le `.ts` : sans cette
carte, Turbopack refuse d'ajouter l'extension aux imports venus de `node_modules`, et l'erreur
n'apparaît qu'au `next build`, pas au `tsc`.

**Boucle de dev, et sa limite.** `npm link @sejour/socle` pose un lien symbolique vers un
dossier situé **hors** de la racine du projet, et Turbopack refuse de résoudre au-delà de
cette racine : `tsc --noEmit` passe, `next build` échoue en `Module not found`. Le
contournement local, jamais commité, est `turbopack: { root: "<parent commun>" }` dans
`next.config.ts` — ou plus simplement travailler sur le paquet installé depuis son tag.
