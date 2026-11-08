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
| Périmètre | Noyau + dashboard + réglementaire français. **Élargi au Lot 5** : événements, calendrier public de réservation, blocs de réservation d'article. Le contenu — dictionnaires, articles, photos, catalogues d'événements — reste chez chaque site. | 2026-09-12 |
| Régime d'Albiez | **La SCI JUARISAL est à l'IS**, et sa comptabilité est tenue sur **Indy.fr**. Aucune extension SCI/IS du module fiscal n'est conçue, aucune note de cadrage n'est produite : la question est tranchée, pas reportée. | 2026-09-11 |
| Indy | **Pas d'API publique** — vérifié le 2026-09-11. Le seul point d'accroche envisageable serait l'export FEC. Rien n'est construit dans cette direction. À ne pas reposer. | 2026-09-11 |
| Exception à la règle 6 | `lib/fiscal/` monte avec **un seul consommateur**, en connaissance de cause. Motif et portée dans `lib/fiscal/README.md`, qui doit être relu avant tout arbitrage sur ce module. | 2026-09-11 |
| Clé d'un événement | `key`, stable et jamais affichée, porte la jointure depuis `BlogPostMeta.event`. **Jamais le nom** : un nom est de l'affichage, il se corrige et finira par se traduire. Barbusse a migré ses cinq articles. | 2026-09-12 |
| `confirmed` sur un événement | Un **fait** sur l'événement (les dates sont-elles officielles), pas un aiguillage de comportement : conforme à la règle 2. Il commande l'émission du JSON-LD `Event`. | 2026-09-12 |
| `commune` | Additive, **optionnelle** dans le type du socle. Albiez la porte par entrée (sept communes), Barbusse la fournit une fois au JSON-LD (tout se passe au Mans). | 2026-09-12 |
| Deux enveloppes de calendrier de tableau de bord | **Maintenues séparées**, décision de `madame-soleil` au Lot 3, non rediscutée. Le Lot 5 pose la couche d'événements d'Albiez sur le moteur du socle sans fusionner les composants. | 2026-09-12 |
| Série de référence des stats | **Le net encaissé**, sur les deux pages. Le brut reste en sous-ligne — c'est lui qui se rapproche des relevés Airbnb et Booking. En brut, la carte « part du direct » classe le direct à l'envers : la politique tarifaire le veut 7 % moins cher qu'Airbnb, alors qu'il rapporte 12 % de plus une fois les 18,6 % de commission déduits. | 2026-09-12 |
| Unité de mesure des stats | **La nuitée-logement**, seul dénominateur des deux pages. `unitsTotal` est une donnée injectée (1 pour Albiez, 9 pour Barbusse), `Booking.units` le poids d'une ligne. Le triplet `SplitMetric {global, house, room}` est refusé : la justesse du passé à la chambre vient du dénominateur, pas de trois nombres par carte. | 2026-09-12 |
| Accueil du dashboard | **Le calendrier**, sur les deux sites. `/dashboard` redirige vers `/dashboard/calendar` (Barbusse) ou `/dashboard/calendrier` (Albiez) ; les statistiques ont leur propre chemin. Une **redirection**, jamais le calendrier rendu sur `/dashboard` : `allowedPaths` se lit par préfixe, et `/dashboard` dans cette liste ouvrirait tout ce qui le prolonge. | 2026-09-22 |
| Où tombe l'argent | **Une seule fonction décide** : `spreadRevenue` pour l'imputation, `availableUnitNights` pour le dénominateur. Aucune page ne recalcule. Le RevPAR est **défini comme un quotient** ; son égalité avec « prix moyen × occupation » est une conséquence arithmétique, plus une seconde formule qui peut diverger. | 2026-09-12 |
| Exception aux règles 6 et « n'entre jamais » : serrure Nuki | `lib/nuki.ts` et `lib/access-codes.ts` montent avec **un seul consommateur** (Barbusse), par décision de l'utilisateur : un prochain logement pourrait avoir une Nuki. Albiez n'est pas tenu de s'en servir (boîte à clés mécanique, code fixe). L'exception couvre ce client d'appareil **et lui seul** : `heatzy.ts` / `cozytouch.ts` restent dehors, et la tâche planifiée qui synchronise reste chez le site. Motif et portée dans la section v3.8.0. | 2026-11-07 |
| Exception à la règle 6 : préparation d'arrivée | `lib/arrival-readiness/` (`schedule`, `evaluate`, `format`, `nuki-probe`, `types`) monte avec **un seul consommateur** (Barbusse), par décision de l'utilisateur : le module est prévu pour les futurs équipements d'Albiez. **Portée** : le calendrier des passages, l'interface `ReadinessProbe` (`lock`, `heating`, `waterHeater`, `presence`, toutes facultatives), la mise en forme sans PIN ni nom de famille, l'anti-répétition par `nextAlertState`, et les sondes Nuki (qui s'appuient sur l'exception précédente). **Hors portée** : les sondes de chauffage et d'eau chaude (`heatzy.ts` / `cozytouch.ts` restent chez Barbusse, qui les adapte à `ReadinessProbe`), la route cron, le stockage de l'état, et toute heure ou tout seuil — tous fournis par le site, sans valeur par défaut. | 2026-11-07 |
| Messagerie voyageur | **Le moteur monte, les valeurs restent.** Deux appelants réels dès le départ (règle 6 respectée). Dans le socle : `lib/guest-messaging/` (types, planification pure, rendu, validation des textes, registre dans les `infoItems` Beds24, envoi à dépendances injectées, charge utile de l'écran de suivi) et `components/GuestMessagesDashboard.tsx`. Chez chaque site : **les textes** (aucun texte par défaut ici, même « Bonjour »), les règles concrètes, la route cron, le transport e-mail et ses secrets, la vérification propre au bien (serrure, boîte à clés). Aucun stockage supposé. Pas de booléen `dryRun` : le mode ombre appelle `planMessages` seul. Un canal n'est nommé que dans `channel-rules.ts`. | 2026-11-08 |

## Protocole de test

`docs/PROTOCOLE-TEST.md` — à lire avant tout lot, et à rejouer avant chaque déploiement.
Cinq principes, la photo de référence à prendre **avant** de modifier quoi que ce soit, la
batterie automatique, la matrice des portes par rôle, le test de fuite avec ses valeurs
attendues, ce que seul un œil humain peut faire, et neuf pièges payés une fois chacun.

Deux règles s'y détachent : **mesurer, jamais déduire** — deux sessions ont cru le même jour que
la production n'était pas à jour, sur la foi d'une référence de commit périmée — et **une
dégradation silencieuse est pire qu'une panne**, parce qu'un repli qui fonctionne masque la
panne qu'il compense.

### Tests unitaires (`npm test`)

La couche du dessous du protocole : **vitest**, en devDependency seule, sur les modules purs à
fort enjeu — `taxe-sejour`, `fiscal/*` (`bic`, `ir`, `lmp-test`, `cotisations`,
`orientations`, `config`, `revenus`), `stay-selection`, `invoice-number`. Ce sont des tests de
**caractérisation** : ils figent le comportement actuel, sans navigateur ni réseau.

- Ils vivent dans `tests/`, **jamais** à côté des modules : le motif d'export `./lib/*`
  rendrait un `lib/x.test.ts` importable par les sites.
- Le fuseau est fixé à `Europe/Paris` dans `vitest.config.mts` (`lib/dates.ts` compte en
  heure locale).
- Fixtures **inventées** (`tests/fixtures.ts`) : le dépôt est public.
- Un comportement qui ressemble à un bug n'est pas corrigé dans le test : il est figé tel quel,
  et le comportement attendu est écrit à côté en `it.skip` avec son motif. Retirer le `.skip`
  fait partie du correctif.
- Ajouter les tests ne change rien pour les sites : `tests/` n'est pas exporté, et un ajout de
  tests seul ne donne **pas de tag**. Depuis v3.9.0, en revanche, les sites installent vitest
  eux-mêmes pour leurs contrôles post-déploiement (`testing/deploy/vitest-suite`, peerDependency
  facultative) : c'est `testing/`, pas `tests/`, qui leur est exporté.

## Ce qui n'entre jamais

Contenu d'articles de blog, dictionnaires i18n, `public/`, données propres à un bien, photos.
`heatzy.ts` / `cozytouch.ts` et les crons (Barbusse) — seule exception, la serrure Nuki (v3.8.0). `seasons.ts` et sa descendance, `AWARDS`,
`property.ts`, `legal.ts` (Albiez). Les textes des messages voyageurs, leurs déclencheurs concrets, le
transport e-mail concret (SMTP d'un domaine). Ce sont les **valeurs**, pas les mécanismes.

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
| 1 | Auth, rôles, cloisonnement — **ferme la fuite `NUKI_PIN`** | `cerbere` | `v0.2.0` |
| 2 | Beds24 + modèle canonique `Booking` | `champollion` | `v0.3` — code écrit, tag à poser |
| 3 | Dashboard | `madame-soleil` | `v0.4` — code écrit, tag à poser |
| 4 | Factures, taxe de séjour, fiscal | `le-percepteur` | `v0.5` — code écrit, tag à poser |
| 5 | Vitrine — événements, calendrier public, blocs de réservation | `monsieur-loyal` | `v0.6.0`, puis `v0.6.1` |
| A | Convergence des stats — **les définitions** | `madame-soleil` | `v1.0.0` — **non consommable** |
| B | Convergence des stats — **routes, brut par canal, fiscal sur le `Booking`, gardes** | `champollion`, `cerbere`, `le-percepteur` | `v2.0.0` |
| C + D | Convergence des stats — **la charge utile unique et l'écran partagé** | `madame-soleil` | **`v3.0.0`** — le fiscal change des nombres publiés |
| 5 (suite) | Vitrine — **i18n et SEO** : `lib/locales.ts`, `lib/seo.ts` (hreflang, JSON-LD d'article, négociation de langue) | `poisson-babel` | `v3.1.0` |
| 5 (suite) | Événements — **les champs recommandés du nœud `Event`** (`organizer`, `performer`, `tickets`, `article`) | `le-douanier`, `chef-de-stand`, `le-dahu` | `v3.2.0` |
| 5 (suite) | Événements — **le CTA annonce les dates provisoires** (`EventBookingLabels.provisionalDates`) | `le-douanier`, `chef-de-stand` | `v3.3.0` |
| — | Dashboard — **les deux tableaux de séjours portent tout l'historique** | `madame-soleil`, `le-dahu`, `chef-de-stand` | `v3.4.0` |
| — | Factures — **une réservation payée sur une plateforme est pré-remplie comme acquittée** (`platformPaymentOf`) | `le-percepteur`, `le-douanier` | `v3.5.0`, puis `v3.5.1` (Abritel retiré) |
| — | Factures — **la taxe de séjour a sa ligne, et la mention Airbnb** (`touristTax`, `touristTaxNote`) | `le-percepteur` | `v3.6.0` |
| — | Dashboard — **chaque semaine du calendrier dans son cadre** (`WEEK_GRID`) | `madame-soleil` | `v3.7.0` |
| — | Serrure — **codes d'accès Nuki** (`nuki.ts`, `access-codes.ts`), exception à la règle 6 | `chef-de-stand`, `le-douanier` | `v3.8.0` |
| — | Correctifs de dates et de chiffres fiscaux | `le-percepteur`, `tonton-tuyau` | `v3.8.1` |
| — | Surveillance — moteur `testing/deploy`, workflow `deploy-checks.yml`, `alert-state`, `heartbeat` | `tonton-tuyau`, `champollion`, `poisson-babel`, `cerbere` | `v3.9.0` |
| — | Arrivées — santé Nuki, `listLogSince`, `missedArrivals`, `arrival-readiness` (exception règle 6) | `chef-de-stand` | `v3.10.0` |
| — | Contrôles — `excludedPaths` comparé par segments entiers (`pathHasFragment`) | `chef-de-stand` | `v3.10.1` |
| — | Contrôles — `llms.policies` exige l'unité (« 30 jours », « J-30 », « 50 % », « 48 h ») : un nombre nu donnait de faux verts | `le-dahu` | `v3.10.2` |
| — | Référencement — **Google Search Console dans le dashboard** (`google-auth`, `search-console`, `SearchConsoleDashboard`) | `le-douanier`, `le-dahu`, `chef-de-stand` | `v3.16.0` |
| — | Blog / guide — **pastilles de filtre** `FilterChips` (purement visuelles ; modèle d'article, prédicat et carte restent dans chaque site) | `le-douanier`, `le-dahu`, `chef-de-stand` | `v3.17.0` |
| — | Veille des dates d'événements (`lib/events-watch.ts`) | — | `v0.7.0` |

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

### Lot 1 — auth, rôles, cloisonnement

Trois portes, dans cet ordre : le **proxy**, le **handler de route**, la **projection de la
réponse**. Aucune n'est suffisante seule, et c'est le point : `/api/dashboard/bookings` de
Barbusse était couvert par aucune des trois et rendait 73 champs — dont 37 `NUKI_PIN` — à
n'importe quel rôle connecté.

| Chemin | Contenu | Vient de |
|---|---|---|
| `lib/auth.ts` | `createAuth<Role>` : JWT `jose` HS256, claim unique `{ role }`, expiration 90 j, secret `DASHBOARD_SECRET`. **Aucun import de `next/headers`** — le proxy tourne en edge. | 87 % de lignes identiques entre les deux sites |
| `lib/auth-cookie.ts` | `setAuthCookie` / `removeAuthCookie`. Isolé parce qu'il tire `next/headers` : seules les routes Node l'importent. | identique des deux côtés |
| `lib/auth-guard.ts` | `createRouteGuard` — `deny(request, roles)` et `denyNonAdmin(request)`, 401 sans cookie, 403 avec un cookie insuffisant. | remplaçe trois copies chez Barbusse, dont deux octet pour octet |
| `lib/proxy.ts` | `createDashboardProxy` — négociation de langue, redirections d'anciennes URLs, cookie, bornage du rôle restreint. | Albiez |
| `lib/booking-status.ts` | `EXCLUDED_STATUSES`, `UNCONFIRMED_STATUSES`, `HELD_STATUSES`, `provisionalKind`. | `EXCLUDED_STATUSES` recopié 5 fois ; les deux autres sortis d'un composant client |
| `lib/booking-dto.ts` | `BookingListItem` (15 champs), `AdminBookingListItem` (+5), `projectBookings`. | Albiez (`calendrier/route.ts`), généralisé |

**Le fail-safe est celui d'Albiez.** Un jeton illisible, expiré ou portant un `role` inconnu
retombe sur le rôle **restreint**. Barbusse retombait sur `"admin"` : un jeton invalide valait
les pleins pouvoirs. Échouer fermé ne coûte aucune reconnexion légitime — `createToken` pose
toujours le claim.

**Le préfixe des mots de passe est une liste, pas une constante.** Chaque site déclare les
siens : Albiez `["DASHBOARD_PASSWORD_MENAGE", "DASHBOARD_PASSWORD_VIEWER"]`, Barbusse
`["DASHBOARD_PASSWORD_VIEWER"]`. Le code passe à `viewer` **sans attendre le renommage des
variables Vercel** : leur valeur de production est un `Secret` illisible après coup, et un
renommage raté couperait l'accès de la personne du ménage sans retour possible. Les deux
formes marchant en même temps, la bascule des noms se fera à froid.

**Liste blanche par projection, jamais suppression de champs.** Beds24 renvoie 73 champs et en
ajoutera : `delete b.infoItems` protège de ce qu'on connaît, une projection protège aussi de ce
qui arrivera. Quatre champs à ne pas retirer du lot commun, vérifiés dans les composants :
`company` et `title` portent le nom sur les barres sans prénom, `comments` s'affiche sans
condition de rôle, `referer`/`channel` alimentent `normalizeChannel` même quand les couleurs
sont masquées, `notes` est la consigne de ménage — la raison d'être du rôle.

**Ce qui n'entre dans aucun DTO** : `infoItems` (le PIN de serrure), `invoiceItems`,
`stripeToken`, `pcibookingToken`, `commission`, `deposit`, `tax`, `address`, `city`, `state`,
`postcode`, `custom1..10`, `apiReference`, `apiMessage`, `groupNote`, `message`, `voucher`, et
les ~40 autres.

**Pas de bornage des dates.** La liste blanche rend la fenêtre inoffensive, et l'administrateur
a besoin de fenêtres larges.

Mesure sur `/api/dashboard/bookings?arrivalFrom=2025-01-01&arrivalTo=2026-06-30`, en `viewer` :
**73 clés et 37 `NUKI_PIN` avant, 15 clés et 0 après** (129 537 → 14 770 octets).

### Lot 2 — Beds24, modèle canonique, archive

| Chemin | Contenu | Vient de |
|---|---|---|
| `lib/booking.ts` | `Booking`, `BookingSource`, `nightsBetween`. **Le type canonique du domaine.** | Albiez (`Sejour`), renommé en anglais technique |
| `lib/beds24-types.ts` | `Beds24Booking`, `Beds24InfoItem`, `Beds24InvoiceItem`, `Beds24Property`, `Beds24CalendarSpan`, `Beds24CalendarRoom`, `Beds24AvailabilityRoom`. Le **format de transport**. | Barbusse (déclaration en production), + `commission` et `apiReference` d'Albiez |
| `lib/beds24-client.ts` | `createBeds24Client` — jetons par voie, cache d'access tokens, replis, `keepAlive`, `updateNotes`, `expandSpans`, `eachDay`. | les deux, écrits deux fois |
| `lib/archive.ts` | `createArchive<T>` — filtrage répliquant celui de l'API, dédoublonnage où le live gagne, `origin` exposé. | Albiez pour la forme, les deux pour le mécanisme |

**Deux types, et ce n'est pas une contradiction.** `Booking` est le modèle du domaine ;
`Beds24Booking` est le format de transport. Ce qui **calcule** parle le premier. Ce qui parle
vraiment à l'API — factures, code Nuki, notes internes, taxe de séjour assise sur les lignes de
facture — a besoin du second, avec ses `invoiceItems` et ses `infoItems`.

**Le partage requis / optionnel est l'argument entier.** Est requis ce que les deux sources
ont toujours ; est optionnel ce qu'une source peut légitimement ignorer. Albiez ne porte pas
`read:bookings-personal` : `firstName`, `email`, `phone`, `country` sont optionnels **pour
qu'aucun calcul du socle ne pousse ce site à réclamer ce scope**. De même `id` : les lignes
archivées d'Albiez viennent d'exports de canal et n'ont aucun identifiant Beds24 — d'où `ref`,
requis, dont la composition est le choix du site.

**Les deux replis de jeton sont deux champs, pas un drapeau.** `whenMissing` répond à une
variable non définie — une configuration incomplète, connue d'avance. `whenRefused` répond à
un refus. Les confondre ferait reprendre un 401 de la voie de lecture par la voie d'écriture,
qui ne porte pas `read:bookings-financial` : le dashboard afficherait des zéros au lieu d'une
erreur, ce qui est pire.

**`expandSpans` itère en UTC.** La boucle de réexpansion des tranches `[from, to]` était
écrite quatre fois — minimum de séjour et prix, de chaque côté — et deux de ces copies
faisaient `new Date(jour + "T00:00:00")` puis `toISOString()` : minuit **local** relu en UTC,
donc un décalage d'un jour vers le passé pendant les huit mois d'heure d'été. Sans effet sur
Vercel, qui tourne en UTC ; faux en développement depuis Paris.

**Le merge d'archive sort du client d'API.** Barbusse l'avait enfoui dans `getBookings()` :
un client qui ajoute en silence des lignes que l'API n'a pas renvoyées rend fausse d'avance
toute mesure de ce qu'il produit, et c'est précisément ce qui avait laissé 37 `NUKI_PIN`
d'origine archivée traverser une route qu'on croyait ne servir que du live. Le placement
d'Albiez — une fusion nommée, appelée par ses consommateurs — est retenu.

Ce qui **n'est pas** monté, et pourquoi :

- `surcollecteTaxe()` et `contraintes()` (Albiez), `getFullyBookedDates`, `findBookingByStripeIds`,
  `getProperties`, `getBookingById` (Barbusse) : un seul appelant réel chacun.
- Le **chargement** de l'archive. Barbusse importe un JSON du dépôt ; Albiez ne peut pas, le
  sien est gitignoré parce que son dépôt est public. C'est le paramètre `load`.
- La **clé** de dédoublonnage et le **tri** de la fusion : `ref` trié par arrivée chez Albiez,
  `id` sans tri chez Barbusse. Trier là où le site ne le faisait pas change l'ordre des séries
  d'un graphe.

Vérification de non-régression, dashboards interrogés en local avant et après : **totaux par
année et par canal identiques à l'euro près des deux côtés**, et la fuite `NUKI_PIN` toujours
fermée (15 clés, 0 PIN, 14 813 octets, à l'octet près avant/après).

### Lot 3 — dashboard

| Chemin | Contenu | Vient de |
|---|---|---|
| `lib/stats.ts` | `RevenueMode`, `RevenueExtra`, `RevenueChartData`, `ChannelYear`, `YearComparison`, `spreadRevenue`, `stayNights`, `revenueMovements`, `buildRevenueChart`, `channelsByYear`, `compareYears`, `occupiedNights`, `channelBreakdown`. | Albiez (`lib/stats.ts`, 332 l.), renommé en anglais |
| `lib/calendar-lanes.ts` | `placeSegments<T>`, `LaneBar<T>`, `Segment<T>`, `LaneGranularity`, `laneCount`, `roundedEnds`, `periodTooltip`, `PERIOD_PALETTE`. | Albiez pour la forme (`placer<T>`), les deux pour le mécanisme |
| `lib/chart-theme.ts` | `CHART_GRID`, `CHART_AXIS`, `chartAxisIn`, `CHART_TOOLTIP_STYLE`, `CHART_LEGEND`, `chartEuro`. | Albiez (rampe `slate`, arbitrée) |
| `components/DashboardNav.tsx` | Barre de navigation générée depuis une config de liens, avec filtrage par rôle et tiroir mobile. | les deux, convergents ligne pour ligne |
| `lib/dates.ts` | **+ `daysBetween`** — la seule fonction du module à compter en UTC, parce qu'un écart est une quantité et non un jour affiché. `nightsBetween` de `lib/booking.ts` y délègue. | trois copies, dont `joursEntre` d'Albiez |

**Ce que le socle fournit, ce sont les briques ; la composition reste au site.** Albiez a
délibérément abandonné le camembert — « il ne répondait qu'à *quelle est ma dépendance
aujourd'hui*, la vraie question est *comment évolue-t-elle* » — et Barbusse le garde ; Albiez a
`ComparaisonAnnuelle`, Barbusse `RevenueProjection` et `OccupancyGauge`. Aucun de ces choix
n'entre ici.

**La série de référence est le net, mais c'est un défaut, pas une contrainte.** Le parti pris
d'Albiez — le brut change de définition au milieu de son historique, la rupture Airbnb
*host-only* de mars 2024 — est celui de `spreadRevenue`. Barbusse suit son brut en passant le
montant explicitement (`spreadRevenue(b, mode, b.gross)`) : son dashboard l'annonce sur sa
première carte, et son historique ne traverse pas cette rupture. C'est une **donnée**, pas un
mode de plus.

**`demiCellules` est devenu `LaneGranularity`.** Le booléen d'Albiez disait *comment* une barre
occupe sa case ; il dit maintenant *ce qu'elle occupe* — `"half-day"` pour un séjour ou une
bande de vacances, qui libèrent la moitié de leur dernier jour, `"full-day"` pour un événement
de calendrier, qui n'en libère rien et qu'une demi-case de chaque côté réduirait à rien s'il ne
dure qu'un jour.

**`PERIOD_PALETTE.vacances` est une valeur par défaut, pas une constante.** Barbusse la
redéfinit : chez lui l'indigo est déjà la couleur du badge « Événement » du circuit, et sa zone
scolaire locale `B` se distingue des deux autres parce que c'est l'information utile au ménage.
`fete` est commune, aux mêmes `#fb7185` / `#be123c`.

**`RevenueMode` prend les mots de Barbusse.** `"averagedPerNight" | "byCheckIn" | "byCheckOut" |
"byBookingDate"` contre `"reparti" | "arrivee" | "depart" | "reservation"` : la règle 5 donnait
Albiez, la règle 4 donne l'anglais technique, et la règle 4 l'emporte sur un vocabulaire de
type. Les libellés affichés, eux, n'ont pas bougé.

Ce qui **n'est pas** monté, et pourquoi — les trois refus sont mesurés, pas d'humeur :

- **`<StatCard>`.** Les deux cartes partagent `rounded-2xl p-5` et rien d'autre : Albiez a une
  carte blanche cerclée à libellé `xs` capitalisé, Barbusse une carte pastel à libellé `sm` dont
  la **couleur est une information** (émeraude / ambre / rose selon le seuil d'occupation).
  Une brique commune coûterait ~25 lignes plus deux configurations de ~8 : autant que les 31
  lignes qu'elle remplacerait. Un composant dont chaque visuel est une prop est un `div`.
- **`BookingsTable`.** 145 lignes ici, 108 là, et pas les mêmes colonnes : Albiez double son
  tableau d'une liste de cartes sous `md` et affiche canal, période et net ; Barbusse a un
  bouton « voir les N » et une colonne Événement. Un tableau à colonnes configurables ferait
  ~120 lignes plus deux configurations de ~40, contre 253 — 20 % de gain contre une indirection
  et un changement de rendu garanti d'au moins un côté.
- **`GuestShareBlock` / `PartageVoyageur`.** 49 % de lignes identiques, mais l'essentiel de ces
  lignes est de la ponctuation JSX. Les deux divergent sur leur **source de vérité** : Albiez
  sert un code statique par variable d'environnement (`/api/dashboard/code-acces`), Barbusse un
  code **par réservation** lu dans Beds24 (`/bookings/{id}/nuki-code`) ; Barbusse présélectionne
  la langue d'après le pays, ce qu'Albiez ne peut pas faire faute du scope
  `read:bookings-personal` ; Barbusse arrête la propagation sur chaque clic, sa popup en
  dépend. Le seul morceau vraiment commun est le presse-papier avec repli de sélection
  manuelle : **~35 lignes**, contre l'ouverture d'une surface de hooks React dans le socle.
  Candidat pour un lot ultérieur, pas pour celui-ci.
- **L'enveloppe du `BookingCalendar`.** Voir ci-dessous.

**Le calendrier : le moteur monte, l'enveloppe reste.** Le plan d'ensemble prévoyait un
composant unifié à slots ; il n'est pas fait, et ce n'est pas un report. Ce qui était commun
était l'**algorithme** — placement en lanes, demi-cellules, arrondis, infobulle de bande — et il
est monté : Barbusse passe de 1 114 à 946 lignes, Albiez de 722 à 615. Ce qui reste divergent
est irréductible : bandeaux de saison de station d'un côté, barres d'événements de circuit et
rayures « non confirmé » de l'autre ; popup ancrée en carte absolue d'un côté, feuille modale
mobile de l'autre ; net, commission et surcollecte de taxe ici, identité voyageur et partage
là. Un composant capable des deux prendrait au moins six slots et serait plus difficile à lire
que les deux composants qu'il remplacerait.

**Le piège UTC, trois fois.** Trois copies de `toISOString().split("T")[0]` subsistaient chez
Barbusse, et deux d'entre elles étaient fausses depuis un fuseau à l'est de Greenwich :

1. `BookingCalendar.toDateStr` décidait quel jour entourer — entre minuit et 2 h à Paris l'été,
   la pastille se posait sur la veille ;
2. la ventilation par nuit de `/api/dashboard/stats` avançait une `Date` avec `setDate()` —
   heure locale — puis relisait le jour avec `toISOString()` — UTC : la nuit du passage à
   l'heure d'été comptait deux fois et la dernière du séjour était perdue, **459,16 €
   basculant de mars à avril** ;
3. `lib/events.ts` décalait d'un jour la fenêtre étendue d'un événement, si bien qu'une même
   réservation portait « SWS Karting Finals 2026 » sur Vercel et aucun événement en
   développement.

Aucun effet sur Vercel, qui tourne en UTC. **La vérification qui les a tous trouvés** : lancer
le serveur une fois tel quel et une fois avec `TZ=UTC`, et comparer les charges utiles. Avant,
les 20 combinaisons période × mode divergeaient ; après, aucune.

**Vérification de non-régression.** Barbusse sous `TZ=UTC`, c'est-à-dire dans le fuseau de
Vercel : **22 charges utiles identiques octet pour octet** (20 combinaisons période × mode de
`/api/dashboard/stats`, plus `/api/dashboard/bookings` en `admin` et en `viewer`). Albiez :
**17 charges utiles identiques** après application de la table de renommage des clés (16
combinaisons période × mode, plus `/api/dashboard/calendrier`) — les valeurs ne bougent pas,
seuls les noms de clés changent. La fuite reste fermée : **50 réservations, 15 clés distinctes,
0 `NUKI_PIN`, 14 813 octets**, à l'octet près.

**La question laissée ouverte par le Lot 2 est tranchée, et `booking-dto.ts` la porte.**
`/api/dashboard/bookings` continue de servir la forme Beds24 à `projectBookings`, et
`BookingLike.id` reste requis. Ce n'est pas un défaut : c'est la frontière. `toBooking` est un
traducteur, dont le métier est la fidélité ; `projectBookings` est une liste blanche, dont le
métier est le confinement — faire reposer la fermeture de la fuite `NUKI_PIN` sur un traducteur
serait la confier à une fonction qui n'a aucune raison de refuser un champ. Et `id` optionnel
est une vérité du **domaine** (une ligne d'archive d'Albiez n'a jamais eu d'identifiant Beds24),
pas du **transport**, où toute ligne en a un.

### Lot 4 — factures, taxe de séjour, fiscal

| Chemin | Contenu | Vient de |
|---|---|---|
| `lib/invoice-config.ts` | `InvoiceIssuerConfig` lu dans les `INVOICE_*`, plus `InvoiceBranding`, `InvoiceMentions`, `InvoiceLogo`, `InvoiceTemplateConfig`. | Barbusse (seul à facturer), branding et mentions extraits du gabarit |
| `lib/invoice-number.ts` | `PREVIEW_NUMBER`, `InvoiceCounterStore`, `createInvoiceNumbering`. **Clé préfixée par entité**, avec reprise de la série antérieure. | Barbusse, préfixe et reprise ajoutés |
| `lib/invoice-payload.ts` | `InvoicePayload`, `InvoiceKind`, `InvoicePaymentDetail`, `beds24ToPayload`, `platformPaymentOf`, `PlatformPayment`, `AIRBNB_TOURIST_TAX_NOTE`, `beds24PaymentToPayload`, `paymentToPayload`, `emptyPayload`, `validateInvoicePayload`, `computeNights`, `staySharePercent`, `remainingAfter`. | Barbusse, logique pure, montée telle quelle |
| `lib/invoice-pdf.tsx` | `renderInvoicePdf` — gabarit React-PDF paramétré par `InvoiceTemplateConfig`. | Barbusse |
| `lib/taxe-sejour.ts` | `TaxeSejourBareme`, `computeTaxeSejour`, **`ecartDeCollecte`**, `Provenance`, `groupByQuarter`, `groupByChannel`, `TaxeSejourLine`, `MonthTotals`. | **les deux** — moteur de Barbusse, exonération des mineurs d'Albiez |
| `lib/fiscal/*` | 8 fichiers : `config`, `revenus`, `commissions`, `bic`, `ir`, `lmp-test`, `cotisations`, `orientations`. | Barbusse |
| `lib/fiscal/README.md` | L'exception à la règle 6, motivée et datée. | — |

**⚠️ Cette section enfreint la règle 6, et le dit.** `lib/fiscal/` n'a **qu'un seul
consommateur** — Coliving Barbusse. La SCI JUARISAL est à l'IS et sa comptabilité est tenue
sur Indy.fr : le BIC LMNP au réel, `SEUIL_LMP_RECETTES`, `testLMP` et `computeCotisations` ne
la concernent pas, et Albiez n'est branché sur rien de tout cela. L'utilisateur a tranché
ainsi le **2026-09-11**, après que la conséquence lui a été signalée. `lib/fiscal/README.md`
porte la note complète et doit être relu avant tout arbitrage sur ce module. Une règle qu'on
enfreint sans le dire devient une règle morte.

**Le compteur de factures est préfixé par entité, et c'est une règle comptable.** La clé
était `invoice:counter:{année}`. Deux entités branchées sur le même Upstash — ce qui arrive
dès qu'on partage un projet Vercel ou qu'on recopie un `.env` — se partageraient la même
série, et deux personnes morales émettraient chacune un `2026-007`. La numérotation
chronologique continue et sans trou est une mention obligatoire de l'article 242 nonies A de
l'annexe II au CGI.

Mais préfixer une série déjà commencée la ferait **repartir à 001** et réémettrait des
numéros déjà utilisés — la même anomalie, prise par l'autre bout. `invoice:counter:2026`
valait **13** au 2026-09-11. D'où `legacyKey` : au premier numéro d'une année, si la clé
préfixée est absente et que l'ancienne porte une valeur, la nouvelle est semée avec elle et
la série reprend à `2026-014`. Idempotent, sans course grâce à `setIfAbsent`, à retirer une
fois 2026 close. Vérifié sur un magasin en mémoire, jamais sur la production.

**Le magasin est injecté, pas importé.** Upstash est le choix d'un site. Trois opérations
suffisent — `incr`, `get`, `setIfAbsent` — et `incr` doit être atomique : c'est tout ce qui
garantit qu'un numéro n'est pas attribué deux fois.

**La mention de TVA est obligatoire dans la config, sans valeur par défaut.** « TVA non
applicable, art. 293B du CGI (location meublée non professionnelle) » était en dur dans le
gabarit, à côté du nom, de la couleur rose et du logo. Les trois autres sont de la mise en
page ; celle-là est une mention **de régime fiscal**. Une SCI à l'IS assujettie ne porte pas
la même, et l'imprimer quand même rendrait la facture irrégulière. Un `tsc` rouge vaut mieux
qu'une facture fausse — d'où l'absence de repli.

**Le prestataire de paiement n'entre pas dans le socle.** `beds24StripeToPayload` et
`stripeToPayload` sont devenus `beds24PaymentToPayload` et `paymentToPayload`, sur un
`InvoicePaymentDetail` structurel dont le `StripePaymentDetail` de Barbusse est un
sur-ensemble. Le libellé du moyen de paiement est un **champ requis** de cet encaissement, et
non un `"Carte bancaire via Stripe"` deviné par le gabarit : écrire « carte bancaire » sur ce
qui serait un virement mettrait une contrevérité sur une pièce comptable. Seul le libellé de
description **par défaut** a changé, et il n'apparaît que quand le prestataire n'en fournit
aucun — c'est une suggestion que l'écran de saisie propose et que l'utilisateur corrige.

**Le barème de taxe de séjour est une donnée, et les clés changent de nom.** `city`,
`ratePercent`, `capPerPersonNight`, `departmentalRegionalRate` deviennent `collectivite`,
`tauxPourcent`, `plafondParPersonneNuit`, `tauxDepartemental` : le socle ne parle plus du
Mans mais d'une collectivité quelconque, chacune votant sa délibération au titre de l'article
L.2333-30 du CGCT. **Les valeurs ne bougent pas** — vérifié champ par champ — et aucun
composant ne lisait ces clés : le bloc était sérialisé dans la réponse sans être affiché.

**La surcollecte et le moteur ont fusionné, et aucun des deux n'a disparu.**
`surcollecteTaxe()` vivait dans `lib/beds24.ts` d'Albiez et n'était pas un doublon : c'était
une règle que le moteur de Barbusse n'avait pas. Elle est devenue `ecartDeCollecte`, et
Albiez l'importe désormais du socle — **sans aucune configuration**, puisqu'elle part du
montant collecté et non d'un barème. Les deux calculs répondent à deux questions
différentes :

| Fonction | Question | Source |
|---|---|---|
| `computeTaxeSejour` | combien **est dû** ? | le barème et la réservation |
| `ecartDeCollecte` | combien a été **collecté en trop** ? | la ligne de facture Beds24 |

L'exonération des mineurs (article L.2333-31 du CGCT) est appliquée par les deux, par deux
chemins qui se rejoignent : la taxe due se compte sur les seuls adultes, l'écart rapporte le
collecté à la part des adultes. Le motif de l'écart est que Beds24 assied un item en
pourcentage sur la totalité de l'hébergement — `per: "adult"` n'est honoré que par les items
à montant fixe, confirmé par leur support le 2026-09-01, aucun réglage ne corrigeant cela.
La correction est donc une routine permanente, pas une mesure d'attente.

**Le module fiscal ne suppose plus le répertoire de travail.** `loadFiscalYearConfig` faisait
`path.join(process.cwd(), "data", "fiscal", …)` : le `cwd` est celui de l'application, que le
socle n'a aucun moyen de connaître. Il prend un `dir`. De même, `revenus.ts` importait
`getBookingsWithArchive` et `getDailyPrices` du site : ce sont maintenant `fetchBookings` et
`fetchDailyPrices`, injectés — la fusion avec l'archive est un choix de site depuis le Lot 2,
et le pricing dynamique une option dont l'absence rend déjà `null`. Le `9` en dur du
dénominateur d'occupation est devenu `unitsWhenMultiProperty`, et « Le Mans Métropole »,
écrit dans le texte d'une orientation, est devenu `collectivite`.

Ce qui **n'est pas** monté, et pourquoi :

- **`components/dashboard/InvoiceForm.tsx` (753 lignes).** Un seul site facture, et le
  formulaire est entièrement fait de la composition d'écran de ce site — pré-remplissage
  depuis Beds24 ou Stripe, recherche de paiement, aperçu en iframe. C'est la règle 6 appliquée
  là où elle n'a pas de motif de dérogation : contrairement au fiscal, rien n'indique qu'une
  seconde entité voudra ce formulaire-là.
- **`INVOICE_TEMPLATE` et `TAXE_SEJOUR_CONFIG`.** Ce sont les valeurs, pas les mécanismes.
- **Le client du compteur.** `@upstash/redis` ne devient pas une dépendance du socle pour un
  site qui ne s'en sert pas.
- **La note de cadrage SCI/IS** que la définition de `le-percepteur` réclamait. Annulée par
  l'arbitrage du 2026-09-11 : la SCI est à l'IS et sa comptabilité est chez Indy.

**Un `.tsx` de `lib/` prend une entrée exacte dans `exports`.** Le motif `./lib/*` pointe sur
`./lib/*.ts` : `@sejour/socle/lib/invoice-pdf` ne se résolvait pas. Une entrée exacte
`"./lib/invoice-pdf": "./lib/invoice-pdf.tsx"` l'emporte sur le motif. Comme au Lot 3,
l'erreur n'apparaissait qu'au `next build`, pas au `tsc`.

**Vérification de non-régression.** Barbusse sous `TZ=UTC`, c'est-à-dire dans le fuseau de
Vercel :

- **Trois factures d'aperçu identiques octet pour octet** (acompte, solde, acquittée), la
  seule différence étant l'horodatage de génération — que react-pdf écrit dans un objet
  indirect `(D:AAAAMMJJHHMMSSZ)` et non sous une clé `/CreationDate`. Aucun numéro consommé :
  `?preview=1` rend `PREVIEW` des deux côtés.
- **Taxe de séjour, trois années** (2025, 2026, 2027) : charges utiles identiques au bit près
  une fois le bloc de barème renommé — total dû, réservations, nuitées, les quatre trimestres
  et leurs douze mois, les canaux, et les **67 lignes** de détail. 6,67 € en 2025, 671,27 € en
  direct et 1 276,70 € collectés en 2026, 99,46 € en 2027.
- **Module fiscal, six charges utiles** (3 années × projeté/réalisé) **identiques au sha256
  près**, 404 compris : CA 99 556,90 € et résultat 22 149,90 € en projeté 2026, 72 228,44 € et
  1 344,35 € en réalisé.
- **La fuite reste fermée** : **50 réservations, 15 clés, 0 `NUKI_PIN`, 14 813 octets** en
  `viewer`, à l'octet près, et 55 / 20 / 0 / 20 250 en `admin`.
- **Albiez : 17 charges utiles identiques octet pour octet** (16 combinaisons période × mode
  de `/api/dashboard/stats`, plus `/api/dashboard/calendrier`) après le passage de
  `surcollecteTaxe()` à `ecartDeCollecte`. Aucune réservation vivante ne porte à la fois des
  mineurs et une ligne de taxe : la branche positive a donc été vérifiée à part, sur **13 cas
  joués à la main** contre l'implémentation d'origine — dont le cas documenté d'Albiez,
  24,50 € pour 4 adultes et 2 enfants, qui donne bien 16,33 € dus et 8,17 € de trop.
- **La numérotation** vérifiée sur un magasin en mémoire : série neuve, reprise depuis 13,
  deux entités qui ne se marchent plus dessus, préfixe vide refusé, bascule d'année en UTC.

### Lot 5 — vitrine : événements et tunnel de réservation

| Chemin | Contenu | Vient de |
|---|---|---|
| `lib/events.ts` | `LocalEvent`, `nextEdition`, `findEventByKey`, `findEventOnDay`, `findEventForStay`, `stayWindow`, `eventJsonLd`. Depuis v3.2.0, `LocalEvent` porte aussi `organizer`, `performer` et `tickets`, optionnels. **Le type et les fonctions ; jamais les données.** | Albiez pour la forme (écrit pour être extrait), Barbusse pour `findEventForStay` |
| `lib/availability.ts` | `AvailabilityResponse`, `AvailabilityUrl`, `strictestMinStay`, `longestFreeRange`. | Barbusse (le CTA), généralisé |
| `lib/stay-selection.ts` | `SelectionContext`, `isValidCheckIn`, `isValidCheckOut`, `cellState`, `selectionAfterClick`, `consecutiveFreeNights`. **Le cœur du tunnel, sorti d'un composant client pour devenir testable.** | les deux calendriers, identiques |
| `lib/booking-url.ts` | `bookingUrl` — l'URL `booking2.php` composée à un seul endroit. | trois copies, mêmes paramètres dans le même ordre |
| `components/ReservationCalendar.tsx` | Le calendrier public : deux mois, huit états de case, séjour minimum, fermetures, compteurs, modale Beds24. | les deux, à 80 % identiques |
| `components/EventBanner.tsx` | L'encart « prochaine édition » — **serveur**, figé au build. | Albiez |
| `components/EventBookingCTA.tsx` | Le bloc de réservation de fin d'article — **client**, sonde la disponibilité. Depuis v3.3.0, `labels.provisionalDates` annonce une fenêtre projetée quand `confirmed` est `false`. | Barbusse |

**`EventBanner` et `EventBookingCTA` ne sont pas le même objet et ne doivent pas être
fusionnés.** La bannière répond à « quand est la prochaine édition » et doit être dans le HTML
initial d'une page dont l'événement est le sujet ; le CTA répond à « la maison est-elle libre »
et ne peut être lu qu'à la visite. Les deux coexistent sur une même page d'article.

⚠️ **Deux exceptions à la règle 6, assumées et à valider.** `EventBanner` n'a aujourd'hui
qu'Albiez comme appelant, `EventBookingCTA` que Barbusse. Ils montent parce que le Lot 5 les
désigne nommément et parce qu'ils sont l'un et l'autre le pendant manquant du site d'en face —
Barbusse gagnerait une bannière, Albiez gagnerait un CTA — mais aucun des deux n'a été posé
chez le voisin dans ce lot : cela réclame des libellés dans cinq langues, c'est-à-dire du
contenu, et le contenu n'est pas du ressort du socle. Si le second appelant n'apparaît pas, la
règle 6 dit de les redescendre.

**Ce qui ne monte pas, et pourquoi :**

- **Les catalogues d'événements.** Une valeur, comme une photo ou un dictionnaire. Toutes les
  fonctions reçoivent le catalogue en paramètre.
- **`shortEventLabel`** (Barbusse) — une table de noms propres du Mans. Donnée, pas mécanisme.
- **Les dictionnaires**, sauf la **forme** de la section `calendar` : `CalendarLabels` est
  déclarée avec le composant qui la consomme, et les deux sites y intersectent leur section.
  C'est la seule section commune aux deux dictionnaires ; le reste ne monte jamais.
- **Les deux enveloppes de calendrier de tableau de bord** — décision du Lot 3, maintenue.

**La rotation du samedi n'est pas un paramètre.** `sansArrivee` / `sansDepart` arrivent dans la
réponse de disponibilité ; un site qui n'en envoie pas lit deux index vides et ne voit rien
changer. C'était le moyen le plus court de respecter la règle 2 sur une règle métier qu'un seul
site possède.

**Trois corrections pour Barbusse au passage**, toutes issues d'Albiez : le `sandbox`
autorisant la redirection 3-D Secure sur l'iframe de paiement, le plafonnement adultes/enfants
à la capacité (on pouvait composer 37 voyageurs pour une maison de 20), et la mise à jour
fonctionnelle du cache de disponibilité, là où un objet capturé dans la closure perdait la
première de deux réponses qui se croisent.

### v0.7.0 — veille des dates d'événements

| Chemin | Contenu | Vient de |
|---|---|---|
| `lib/events-watch.ts` | `EventWatchConfig`, `PublicationWindow`, `EventWatchAlert`, `watchEvents`, `formatEventWatch`. Dit **quand aller vérifier** qu'une date non confirmée l'est devenue. | écrit directement dans le socle, les deux appelants posés le même jour |

**Ce n'est pas une détection, c'est un rappel.** Les organisateurs n'ont ni API ni flux : un
calendrier de circuit paraît en octobre sur le site de l'organisateur, une fête de village sur
Facebook ou par l'office de tourisme. La seule chose fiable est de rappeler à un humain d'aller
voir, au bon moment, avec la liste de ce qui manque. Trois règles, toutes réglées par des
données du site (règle 2) : l'**échéance** (une entrée `confirmed: false` dont le premier jour
projeté est à moins de `deadlineDays`), le **trou de catalogue** (le catalogue de l'année en
préparation — la suivante à partir d'un `MM-DD`, l'année en cours avant — doit compter au
moins `minEvents` entrées) et la **fenêtre de publication** (la période de l'année où les
organisateurs publient, avec la consigne du site — qui appeler, où regarder). La fenêtre ne
rappelle que s'il reste quelque chose à vérifier.

**Le trou de catalogue vaut toute l'année.** La première version ne regardait l'année
suivante qu'à partir d'octobre : les trois relecteurs ont vu la même chose — le 1er janvier,
elle basculait sur l'année d'après et se taisait avec le calendrier toujours vide, au moment
où plus rien ne pouvait le signaler, puisque la règle d'échéance ne voit pas des entrées qui
ne sont pas dans le catalogue. `from` marque désormais le jour où l'année **en préparation**
devient la suivante ; avant lui, c'est l'année en cours qui doit être pleine.

**Sans état, et c'est voulu.** Rien n'est mémorisé entre deux passages : la même alerte
revient chaque semaine tant que le catalogue n'est pas mis à jour, et s'éteint seule le jour
où il l'est. Un magasin « déjà notifié » transformerait un rappel qui insiste en rappel reçu
une fois puis oublié. Conséquence pour les sites : pas de Redis, pas de coupe-circuit.

**Le module rend le corps du message, jamais le titre.** Le corps est en français, comme
tous les messages du socle ; le titre porte le nom du site, que le socle ne connaît pas
(règle 1). Une date non confirmée n'y est affichée qu'au **mois** — c'est une projection,
comme partout ailleurs dans `lib/events.ts`.

**Un `NTFY_TOPIC` absent doit valoir un 500 chez l'appelant.** `sendNtfy` se contente sinon
d'un `console.error`, et une veille qui se tait ressemble exactement à une veille qui n'a
rien à dire — le principe 5 du protocole. Les deux routes le vérifient avant d'envoyer.

Vérifié sur **14 scénarios** joués sur les deux catalogues réels, identiques sous `TZ=UTC` et
`TZ=Europe/Paris` : rien à dire au 2026-09-12 des deux côtés ; Barbusse au 2026-10-05 signale
« 5 entrées seulement » pour 2027 et ouvre la fenêtre lemans.org, et le redit encore au
2027-01-11 si rien n'a bougé ; Albiez au 2027-03-15 signale Le Charoc à J-82 et liste les
cinq autres non confirmés, et au 2028-03-05 rappelle un catalogue vide alors qu'il n'y a plus
aucune entrée à confirmer ; un événement déjà commencé et toujours non confirmé se lit « déjà
commencé » ; une fenêtre qui chevauche le nouvel an tient ; un catalogue entièrement confirmé
ne rappelle rien.

### Lot 5 (suite) — i18n, SEO, moteur de blog

| Chemin | Contenu | Vient de |
|---|---|---|
| `lib/locales.ts` | `Locale`, `LOCALES`, `DEFAULT_LOCALE`, `LOCALE_META` (`short` / `native` / `bcp47` / `og`), `isLocale`, `localeFromAcceptLanguage`. **Aucun import** — le fichier est chargé par le proxy (edge), les composants serveur et les composants client. | Albiez ; Barbusse ne l'avait pas |
| `lib/seo.ts` | `PathFor`, `homePath`, `sectionPath`, `itemPath`, `openGraphLocales`, et `createSeo({siteUrl, siteName})` → `hreflangMap`, `alternatesFor`, `articleJsonLd`. | Albiez, déjà écrit générique |

**Une seule abstraction : `PathFor`.** Une fonction `(locale) => chemin`. Elle suffit aux slugs
traduits d'Albiez (`/fr/ete` ↔ `/en/summer`) comme aux slugs communs de Barbusse, et c'est
elle qui garantit que le `<head>` d'une page et le sitemap construisent la **même** table
`hreflang` : ils appellent tous les deux `hreflangMap`. Les deux jeux d'annotations décrivent
le même ensemble et Google les lit tous les deux ; une clé présente d'un côté et absente de
l'autre est une incohérence gratuite.

**Ce qui ne monte pas :**

- **Les dictionnaires** et le **contenu des articles**. Des valeurs.
- **`apartmentJsonLd`** (Albiez) et le JSON-LD de logement de Barbusse. Ils décrivent deux
  biens de nature différente — un appartement en station contre une maison de neuf suites —
  avec des types schema.org, des champs et des nœuds distincts. Les factoriser donnerait une
  signature à quinze paramètres optionnels, c'est-à-dire la donnée du site déguisée en
  configuration (règle 2). Chaque site garde le sien.
- **`BlogPostMeta`.** Le modèle de données est commun à 60 %, mais les deux extensions
  (`season` chez Albiez ; `soldOut`, `nextEdition`, `supersededBy`, `imageCredit` chez
  Barbusse) portent chacune des règles d'affichage que le socle n'a aucun moyen d'appliquer.
  Le **motif** d'imports paresseux, lui, s'est propagé — mais un motif se recopie, il ne
  s'importe pas.
- **`SEASON_SLUGS`, `DATE_LOCALE`.** `LOCALE_META.bcp47` vise `en-GB` ; Barbusse formate ses
  dates d'articles en `en-US`. Ce n'est pas la même chose qu'une étiquette de langue : c'est
  un format affiché, et l'aligner changerait le texte des articles.

**Le `<html lang>` correct impose deux layouts racines.** `app/layout.tsx` disparaît, le
segment de langue devient le layout racine du site, et le dashboard prend le sien. C'est la
seule façon d'écrire `lang` avec la vraie langue de la page en restant statique ; un
`useEffect` qui corrige `document.documentElement.lang` après l'hydratation n'est vu ni par un
moteur, ni par un lecteur d'écran. Conséquence à connaître : le `_not-found` global sort alors
avec un `<html>` sans `lang` — c'est le cas des deux sites.

### Lot A — les définitions de la page de statistiques

> ⚠️ **`v1.0.0` n'est pas un tag consommable.** `lib/fiscal/commissions.ts` y garde encore
> `computeCommissionBooking` sur l'ancienne sémantique (lignes de facture seules), alors que
> `lib/commissions.ts` porte déjà la définition unique. Le premier tag qu'une application peut
> épingler est celui du Lot B, qui bascule les deux sur `commissionOf`. **Aucun site ne passe de
> v0.7.0 à v1.0.0.** (Arbitrage du douanier, 2026-09-12.)

Premier lot d'une convergence en cinq : il pose les définitions, **aucune application ne les
consomme encore**. Les deux apps restent épinglées sur `v0.7.0` (tête de `veille-evenements`,
`f294f1c`) et leurs charges utiles n'ont pas bougé d'un octet.

| Chemin | Contenu | Vient de |
|---|---|---|
| `lib/commissions.ts` *(nouveau)* | `commissionOf`, `commissionFromInvoiceItems`, `isCommissionLine`, `COMMISSION_LINE_RE`, `invoiceLineTotal`, `listCommissionLines`. **La définition unique du commissionnement.** | `lib/fiscal/commissions.ts`, qui la réexporte et garde ses helpers de CA |
| `lib/booking-status.ts` *(+)* | `countsAsSold` = ni exclu, ni provisoire — et **`new` compte** ; `soldBookings()` et le type marqué `SoldBooking`, seule entrée des agrégations | les deux routes de stats |
| `lib/booking.ts` *(+)* | `units?: number` et `unitsOf(b)` — le poids d'une ligne en logements, défaut 1 ; `touristTax?: number` et `touristTaxOf(b)`, et **`gross` redéfini hors taxe de séjour** | Barbusse le pose, Albiez laisse le défaut |
| `lib/taxe-sejour.ts` *(+)* | `isTouristTaxLine`, `touristTaxFromInvoiceItems` — **la définition unique** d'une ligne de taxe ; `fiscal/commissions.ts` l'importe au lieu de recopier le motif | deux copies de `TAX_DESCRIPTION_RE` |
| `lib/dates.ts` *(+)* | `daysInMonthKey("YYYY-MM")` ; `daysInMonth` existait déjà | trois copies de `new Date(y, m, 0)` |
| `lib/stats.ts` *(+)* | `nightsInWindow`, `overlapsWindow`, `soldUnitNights`, `availableUnitNights`, `windowRevenue`, `buildMonthlySeries`, `computeIndicators`, et le renommage `YearComparison.projection` → `committedTotal`. **Les neuf agrégations ne prennent plus que `SoldBooking[]`** | écrit ici |
| `lib/dashboard-stats.ts` *(nouveau)* | `DashboardStatsPayload`, `StayRow`, `StatsPeriod`, `periodBounds` — la charge utile **unique** des deux routes | écrit ici |
| `scripts/verifier-indicateurs.ts` | La vérification de cohérence, exécutable **sans serveur ni Beds24** : `npm run verifier` | écrit ici |

**Les huit indicateurs sont calculés une fois, et leurs bases sont publiées.** `stayNet`,
`soldUnitNights` et `availableUnitNights` figurent dans la charge utile à côté des trois
quotients qu'ils produisent. Ce n'est pas de la redondance : c'est ce qui permet de refaire les
calculs à la main depuis la réponse, donc de prouver qu'il n'y a qu'un seul jeu de définitions
sur la page. Une valeur qu'on ne peut pas recalculer est une valeur qu'il faut croire sur
parole.

**Deux assiettes, et elles ne sont pas interchangeables.** Le net encaissé compte les recettes
sans nuits — kit de draps facturé à part, frais d'annulation, séjour facturé sans dates : les
retirer creuserait un trou de canal Direct sur 2024 et 2025 chez Albiez. Le prix par nuitée et
le RevPAR ne les comptent pas : une ligne sans nuit n'occupe rien. C'est écrit dans le type,
dans la fonction et ici, pour qu'on ne le « corrige » pas dans six mois.

**Deux sélections, et elles ne portent pas sur la même chose.** L'argent est retenu par le jour
où la convention le fait tomber (`spreadRevenue`), les nuitées par recouvrement de la période.
En `averagedPerNight` — la convention par défaut — les deux coïncident. En « à la réservation »,
l'argent d'un séjour de novembre réservé en août tombe en août, dans une période où ce séjour
n'a aucune nuit : c'est exactement ce que la convention dit, et le sélecteur est affiché
au-dessus des cartes. La vérification de cohérence rejoue les quatre conventions pour cette
raison.

**Le filtre par statut vit une fois, à l'entrée, et le type l'impose.** `le-dahu` a mesuré ce
que donnait un filtre posé dans trois fonctions sur huit : 12 287,78 € sur une carte et
12 510,73 € sur la barre annuelle du même écran, plus une colonne 2027 pour une réservation que
les cartes déclaraient non vendue. Filtrer dans chaque fonction n'aurait fait que reproduire le
défaut — la neuvième fonction aurait oublié le filtre. `soldBookings()` rend un `SoldBooking[]`
que rien d'autre ne sait produire, et les agrégations de `stats.ts` n'acceptent que lui : un
appelant qui oublie le tri a une erreur `tsc`, pas un écart de 222,95 € six mois plus tard.
Corollaire refusé d'avance : pas de paramètre `includeUnsold` (règle 2).

**`new` compte comme vendu ; `request`, `inquiry`, `black`, `cancelled` non.** Sur un canal OTA,
`new` est le statut d'arrivée tant que l'hôte n'a pas cliqué « Confirmed » dans Beds24 : un acte
de rangement, l'OTA a déjà confirmé. Les quatre `new` de Barbusse étaient des Airbnb **déjà
effectués**, importés après coup ; les deux d'Albiez étaient son carnet entier (1 797,40 € de
net, occupation à 90 jours de 30 % → 0 % si on les excluait). `provisionalKind` (affichage) et
`countsAsSold` (argent) divergent donc sciemment sur `new`, et c'est écrit dans les deux JSDoc.
Conséquences à attendre au Lot B : un `new` s'affiche ferme sur le calendrier de Barbusse, et
le rôle `viewer` voit les `new` dans `/api/dashboard/bookings` (le DTO filtre `isProvisional`)
— l'invariant « 50 réservations, 14 813 octets » du protocole bougera, pas les 15 clés ni le
zéro `NUKI_PIN`.

**`gross` est hors taxe de séjour, et un seul prédicat reconnaît une ligne de taxe.** Une taxe
collectée pour la commune n'est ni un produit ni une charge ; un « net encaissé » montré à un
banquier ne la contient pas. La séparation se fait dans le `toBooking` (Lot B), qui pose
`touristTax` ; aucun calcul ne soustrait rien. `TAX_DESCRIPTION_RE` vivait en deux copies —
`taxe-sejour.ts` et `fiscal/commissions.ts` —, exactement l'histoire du motif de commission qui
a produit D1. Mesuré sur les 61 lignes de Barbusse avant/après : CA fiscal **81 301,68 €**
inchangé, 58 919,45 € sur les 55 acquises ; taxe 779,01 € sur les 55 acquises.

⚠️ **Ce que la mesure a révélé pour le Lot B** : l'écart de 4 594,11 € entre `Σ price` et le CA
fiscal des 55 lignes acquises n'est **pas** la taxe de séjour — elle n'en fait que 779,01 €. Les
3 815,10 € restants sont Airbnb : sur ce canal, `price` = Σ lignes de facture **+ commission**
(4 349,79 € d'écart sur 41 lignes vendues, pour 4 543,53 € de commissions), c'est-à-dire que les
lignes de facture Airbnb sont **le versement hôte**, déjà nettes de la commission — qui n'existe
que dans le champ `commission`, jamais en ligne. Celles de Booking.com sont brutes, `City tax`
comprise ; celles du direct sont complètes, taxe comprise, et `price` la contient aussi (le
−465,60 € d'abord attribué au direct vient **entièrement de deux réservations modifiées** dont
la facture garde l'ancien groupe de lignes). `computeCAFromInvoiceItems` rend donc un net pour
Airbnb et un brut pour les autres. Le critère « +7 076,89 € de commissions, CA brut inchangé »
est faux : le CA brut bouge, et la commission Airbnb serait comptée **deux fois** si le fiscal
gardait ses lignes. La note de cadrage de `champollion` (2026-09-13) propose une seule formule,
sans branche par canal — `touristTax` par les lignes, `gross = price − touristTax`,
`commission = commissionOf`, `net = gross − commission` — exacte au centime sur 57 lignes sur 59,
et `price` fait foi sur les deux modifiées (+22,00 € d'erreur résiduelle documentée).

**Ce que la vérification garantit.** `npm run verifier` compile le module et son graphe
d'imports en CommonJS dans `.verif/`, puis exécute 48 contrôles sur un jeu de séjours écrit à la
main, contenant exprès les pièges du lot — une `inquiry`, une `cancelled`, un `black` et un `new`,
un séjour à cheval sur le 1er janvier, une ligne sans nuit, une réservation prise le jour de
l'arrivée :

```
prix moyen × nuitées vendues     = net des séjours
RevPAR     × nuitées disponibles = net des séjours
RevPAR                           = prix moyen × occupation
```

Les trois sont vérifiées sur les valeurs exactes puis sur les valeurs publiées à l'arrondi
près, et la série mensuelle doit retomber sur les indicateurs au centime. C'est ce qui interdit
au défaut D4 — deux RevPAR sur la même page — de revenir par une seconde formule.

**`commissionOf` d'abord, les lignes de facture en repli.** Le champ `commission` est ce que le
canal déclare à Beds24 ; la reconnaissance par libellé est une heuristique. Sur le compte de
Barbusse elle ne matche **aucune** description réelle, d'où **0 €** de commissions affichées sur
la page fiscale quand le champ en portait **7 076,89 €**. Au Lot A, `lib/fiscal/commissions.ts`
gardait l'ancienne sémantique sous son ancien nom ; le Lot B l'a supprimé (voir plus bas).

**Ce que le lot ne fait pas** : il ne touche à aucune application, ne modifie aucune route et ne
change aucun chiffre. Les 45 charges utiles de la photo de référence du 2026-09-12, relevées
sous `TZ=UTC`, sont identiques au sha256 après le lot.

### Lot B — le brut par canal, le fiscal sur le `Booking`, les gardes

**Tag `v2.0.0`, le premier épinglable depuis `v0.7.0`.** Majeur parce que la surface publique
est amputée : `lib/fiscal/commissions.ts` n'existe plus (`computeCABooking`,
`computeCAFromInvoiceItems`, `computeCommissionBooking`, `sumCommissions`, `listCommissionsBooking`
— zéro appelant hors du socle, vérifié), `FetchBookingsForFiscal` devient `FetchStaysForFiscal`
et prend des `SoldBooking[]`, `RevenusDeps.fetchBookings` devient `fetchStays`,
`RevenusBien.commissionsUpcoming` apparaît, `computeBICBien` ne projette plus par défaut.

**Ce que la mesure a établi, canal par canal, sur les 61 lignes de Barbusse (`champollion`,
2026-09-13).** `price` est le brut partout, prouvé au centime : Airbnb `price = versement hôte +
commission` (39/41 — les lignes de facture sont le versement, la commission n'existe **que** dans
le champ), Booking.com `price = hébergement + ménage + City tax` (3/3), direct `price = Σ charges
taxe comprise` (12/14), Abritel 1/1. D'où **une seule formule, sans branche par canal**, écrite
dans le `toBooking` de chaque site et nulle part ailleurs :

```
touristTax = touristTaxFromInvoiceItems(b.invoiceItems)   // lib/taxe-sejour
gross      = round2(price) − touristTax
commission = commissionOf(b)                               // lib/commissions
net        = gross − commission
```

Le fiscal reconstituait un « CA brut » depuis les lignes : il rendait un **net** pour Airbnb et un
brut pour les autres, 3 884,19 € d'écart avec la page de statistiques sur le même jeu de séjours.
Il n'y a pas de réparation possible depuis les lignes — la commission Airbnb n'y est pas — et
toute « correction » aurait réécrit `price − taxe` sous un autre nom : deux définitions du brut.
Le module lit désormais `gross` et `commission` du `Booking`, et n'accepte que des
`SoldBooking[]` — le fiscal ne filtrait que `cancelled` et `black`, il comptait une demande de
renseignement jamais payée (392,04 €, 15 nuits).

**Quatre réservations modifiées gardent leurs anciennes lignes de facture** (`82274645`,
`80467451`, `80768054`, `81056833`). `price` fait foi : +22,00 € d'erreur résiduelle documentée sur
une remise manuelle non répercutée, à corriger dans Beds24. L'heuristique « groupe de lignes le
plus récent » a été refusée : elle échoue sur le cas même qui la motive.

**Ce que « absent » veut dire pour `touristTax`** — texte imposé par le douanier, dans
`lib/booking.ts` : `gross` est toujours hors taxe ; `0` = la source porte le détail et il n'y avait
pas de taxe ; un montant = retiré de `gross` ; **absent = la taxe n'a jamais transité par nos
comptes**. L'archive d'Albiez est dans ce cas — son `brut` est déjà hors taxe sur 101/101 lignes,
l'export Airbnb met la taxe en colonne séparée — et rien n'y est posé.

**`subType` n'est pas une nomenclature Beds24.** C'est l'index de la grille de charges du compte :
sur celui de Barbusse, taxe en 3, 10 et 16, ménage en 2, 11 et 15, hébergement en 1, 7, 8 et 9.
Refusé comme critère de montant ; admis comme signal de doute à afficher. Le docstring de
`beds24-types.ts` qui affirmait « 8 hébergement, 11 extras » était faux sur les données du site
qui l'avait écrit.

**La page fiscale n'a pas le droit de projeter par défaut.** `projectedTotal` est mot pour mot la
« Tendance actuelle » bannie de la page de statistiques. Elle reste, comme **simulation**, derrière
`?projected=true` ; le défaut est le contractuel, et aucun invariant du protocole ne porte sur
une valeur projetée. Les commissions suivent le CA au même prorata de nuits
(`commissionsRealized + commissionsUpcoming = Σ commissionOf`). `asOf` est injectable — c'était
le neuvième `toISOString()` du chantier (D11).

**Côté apps** (hors socle, pour mémoire) : Barbusse — `toBooking` pose les quatre champs et
`units` (9 pour la maison entière), `getStays` demande **toujours** les lignes de facture et ce
n'est plus un paramètre (un appelant qui les aurait omises aurait eu 779,01 € d'écart silencieux
entre deux pages), gardes sur `stats`, `fiscal`, `taxe-sejour`, `invoices/generate`, tri par
`countsAsSold` sur les trois pages de chiffres. Albiez — même formule dans `sejoursBeds24`,
`soldBookings` en tête de route, `attenduLibre` et `prixParNuit` supprimés, « projeté » devient
« engagé à ce jour ». **Résultat mesuré** : `/stats?period=fiscal` = `/fiscal?year=2026` =
76 024,50 € chez Barbusse ; Albiez identique au centime sur 16 charges utiles. Le détail est dans
`docs/PROTOCOLE-TEST.md`.

### Lots C + D — une seule charge utile, un seul écran

**Tag `v3.0.0`.** Majeur, non parce que l'écran est nouveau — il est additif — mais parce que
`lib/fiscal/revenus.ts` **change les nombres publiés** d'une page fiscale : le fiscal impute au
recouvrement et au prorata des nuits, comme `spreadRevenue` en convention « réparti par nuit »,
et appelle `fetchStays` sur une fenêtre élargie d'un an en arrière. Chez Barbusse, 447,40 € de
brut changent d'exercice — les 17 nuits de janvier 2026 de deux séjours de décembre 2025.
`channelsByYear` prend désormais la convention en paramètre et suit l'argent nuit par nuit.

| Chemin | Contenu |
|---|---|
| `lib/dashboard-stats.ts` *(+)* | `computeDashboardStats(input)` — l'assembleur : période, huit indicateurs, revenu engagé, série mensuelle, trois blocs de comparaison sur tout l'historique, deux tableaux, avertissements ; `parseStatsQuery` (`?period=&mode=`, défauts `currentYear` / `averagedPerNight`, valeur inconnue → défaut) ; `REVENUE_MODES`, `REVENUE_MODE_LABELS` ; `period.asOf` dans la charge utile |
| `components/StatsDashboard.tsx` *(nouveau)* | L'écran entier, client, props `title`, `subtitle`, `accent`, `endpoint?`. Le conteneur `mx-auto max-w-6xl px-6 py-8` est dedans, le `DashboardNav` reste à la page |
| `components/stats/*` *(nouveau, privé)* | `MetricCard`, `CommittedRevenue`, `MonthlyRevenueChart` (Par mois / Par année / Par canal), `OccupancyByMonth`, `YearComparisonBlock`, `ChannelsByYearChart`, `StaysTable` ; `format.ts` porte les arrondis d'affichage et les teintes d'accent — importé en relatif, hors de la carte `exports` à dessein |
| `scripts/verifier-indicateurs.ts` | 48 → **84** contrôles : diff des clés de la charge utile contre une liste figée, INV-STATS-4 sur la charge utile, `comparison[année].committedTotal === committedRevenue.total`, C1, C2 |

**Ce que fournit une route, et rien d'autre** : `bookings` déjà passés par `soldBookings`,
`extras` (les recettes sans nuits d'Albiez ; rien chez Barbusse), `mode` et `period` lus par
`parseStatsQuery`, `unitsTotal` (**1 des deux côtés** — chez Barbusse l'unité est la **nuit de
maison**, et une nuit de chambre de l'époque à la chambre pèse 1/9, posé par `toBooking` ; décision
de l'exploitant du 2026-09-13, qui renverse la nuitée-logement à 9 unités de l'arbitrage : elle
montrait un prix moyen de 58 € et un RevPAR de 25 €, des chiffres de chambre pour une activité de
maison entière — l'occupation ne change pas, le prix par nuit et le RevPAR sont ceux d'une maison),
`markerOf` (période de vacances chez Albiez, événement du circuit chez Barbusse), `warnings`.
Les deux routes tiennent en 55 et 75 lignes ; les deux pages rendent `<DashboardNav />` puis
`<StatsDashboard title subtitle accent />`. Treize composants d'application ont disparu.

**Un seul périmètre pour l'engagé et la comparaison, et une seule convention.** `committedRevenue`
est calculé par `windowRevenue` sur l'exercice en cours, recettes sans nuits comprises, **toujours en
« réparti par nuit »** — un minimum garanti est une propriété du carnet, pas de l'axe d'affichage ; en
« date de réservation » le bloc affichait « 0 € confirmés » (le dahu). Et c'est
`committedRevenue.total` qui devient `comparison[année].committedTotal` — pas un second calcul.
Le dahu avait mesuré 30 € d'écart chez Albiez entre les deux blocs.

**On écarte l'année tronquée, jamais le séjour.** La règle des « années comparables » (on garde à
partir de la première année dont le premier séjour tombe en janvier) porte sur les **années
produites**, pas sur les séjours en entrée. Filtrée sur l'arrivée, elle retirait des trois blocs de
comparaison de Barbusse ses deux séjours à cheval sur le 1er janvier — présents dans les huit
cartes du même écran. La première année gardée perd ses pourcentages de variation.

**Ce que l'écran s'interdit.** Aucune infobulle : ce qui explique est imprimé, et servira tel
quel à la vue PDF. Seules les couleurs qui codent quelque chose : canaux (`CHANNEL_COLORS`),
seuils d'occupation (≥ 75 % émeraude, ≥ 50 % ambre, sinon rose), réalisé = accent plein et à venir
= accent éclairci, RevPAR violet avec son axe. Les cartes sont blanches des deux côtés — le rose
signifie Airbnb, qui n'est qu'un canal sur quatre. Aucun `if (site === …)` : quatre données, et
`unitsTotal` vient de la charge utile qui a servi au calcul. La page n'a pas de mode dégradé : les
routes d'argent répondent 403 au rôle restreint, jamais une charge utile allégée.

**Mesuré au 2026-09-13, local `TZ=UTC`** : diff des clés de premier niveau Albiez / Barbusse vide sur
les 16 combinaisons ; 32/32 invariants ; Barbusse fiscal 2026 `realized` = stats `grossRevenue`
écoulé = 66 260,42 €, commissions 7 732,79 des deux côtés ; Albiez `currentYear` net 12 555,31 €,
`committedTotal` 2026 = 13 670,04 €. Le détail est dans `docs/PROTOCOLE-TEST.md`.

### v3.2.0 — les champs recommandés du nœud `Event`

Déclenché par la Search Console de Barbusse le 2026-09-13 : cinq avertissements non critiques
sur les données structurées `Event` — `organizer`, `description`, `offers`, `image`,
`performer` manquants. Albiez émet le même nœud par la même fonction et les aurait eus aussi.

| Chemin | Contenu | Vient de |
|---|---|---|
| `lib/events.ts` | `LocalEvent.organizer`, `.performer`, `.tickets` (optionnels) ; `eventJsonLd(event, place, article?)` avec `article: { description?, imageUrl? }`. | écrit dans le socle, les deux appelants mis à jour le même jour |

**Deux sources, et deux seulement.** Ce qui est un **fait sur l'événement** — son organisateur
véritable, son plateau, sa billetterie officielle — est une donnée du catalogue de chaque site
(règle 2 : jamais un drapeau, jamais un nom de site). Ce qui est **propre à la page** — la
description dans sa langue, l'image de couverture — vient du troisième paramètre : le socle ne
connaît pas l'i18n, c'est l'appelant qui sait dans quelle langue il rend. Un champ absent de sa
source est omis du nœud, jamais inventé.

**Trois interdits, dont le type porte deux.** Nous ne sommes jamais `organizer` — le
commentaire de v0.6.0 disait « délibérément absent : nous ne sommes pas l'organisateur » ; il
reste vrai, on déclare désormais l'organisateur **véritable** quand le catalogue le connaît.
Notre hébergement n'est jamais `offers` : Google interdit de marquer un logement comme offre
d'un `Event`, d'où le nom `tickets` et non `offers` sur `LocalEvent`, pour qu'on ne lise pas
« notre offre ». Et `performer` s'émet en `Organization` seulement : un pilote nommé ferait
entrer de l'affichage et du droit à l'image dans un catalogue de dates.

**`tickets.price` est un sous-objet `{ amount, currency }`**, pas deux champs : un `price` sans
`priceCurrency` est un état que schema.org refuse, et le type le rend impossible. `availability`
vaut `InStock` en dur, acceptable parce que `tickets` n'existe que tant que la billetterie vend —
une épreuve complète retire la donnée.

Le protocole (`docs/PROTOCOLE-TEST.md`, « Les événements ») vérifie qu'aucune URL de réservation
des sites n'apparaît dans `offers`, et que `description` change entre `/fr/` et `/en/`.

### v3.3.0 — le bloc de réservation annonce les dates provisoires

Premier cas, chez Barbusse, d'un événement `confirmed: false` relié à un article avec CTA (les
24 Heures Moto 2027, dont l'ACO n'a pas publié les dates). Le JSON-LD s'était tu, le calendrier
affichait « 24h Moto ? », mais `EventBookingCTA` annonçait « Du 15 au 20 avril · 5 nuits » sans
un mot sur la nature de ces dates.

| Chemin | Contenu | Vient de |
|---|---|---|
| `components/EventBookingCTA.tsx` | `EventBookingLabels.provisionalDates?` — phrase rendue quand `event.confirmed` est `false`, sous la ligne de dates (états libre / partiel / panne) et sous le corps de l'état complet. | Barbusse |

**On prévient, on ne cache pas.** La décision côté Barbusse est écrite depuis le Lot 5 : un
événement non confirmé garde son CTA, la maison est bel et bien réservable sur ces nuits. Ce qui
change est la nature annoncée des dates, pas la fenêtre ni le lien Beds24.

**En texte seul**, comme `EventBanner` traite le même fait : pas de jeton ambre dans le contrat
de thème, et deux composants voisins qui traiteraient le même fait avec deux grammaires
visuelles seraient une régression. Le libellé n'est **pas** `EventBannerLabels.toBeConfirmed` :
là-bas il remplace les dates, ici il les complète.

**Optionnel, donc mineur.** Un champ requis aurait cassé le seul appelant pour une phrase qu'il
fournit de toute façon, et imposé à Albiez cinq traductions pour un composant qu'il ne monte
pas. Le type ne protège de rien (`""` compile) : le garde-fou est le protocole, qui vérifie que
l'article non confirmé porte à la fois **zéro** nœud `Event` et **un** CTA avec la phrase.

### v3.4.0 — les deux tableaux de séjours portent tout l'historique

Relevé par l'exploitant sur Albiez le 2026-09-22 : **la réservation la plus récente n'apparaissait
pas dans « Réservations récentes »**. Prise le 20 septembre 2026 pour un séjour de février 2027,
elle ne recouvrait pas la fenêtre d'« Exercice en cours », qui s'arrête au 31 décembre 2026. La
première ligne qu'on vient lire dans un carnet de commandes manquait.

| Chemin | Contenu | Vient de |
|---|---|---|
| `lib/dashboard-stats.ts` | `recentStays` et `topStays` se calculent sur `bookings` entier. La variable `stays` et l'usage d'`overlapsWindow` disparaissent. | — |
| `components/StatsDashboard.tsx` | Une note par tableau, disant que la liste ignore le sélecteur. | — |
| `components/stats/StaysTable.tsx` | `emptyLabel?`, pour que chaque tableau nomme ce qu'il n'a pas trouvé. | — |

**Le sélecteur de période pilote les mesures, pas les inventaires.** Deux règles de fenêtre ont
été essayées le même jour et écartées l'une après l'autre : le recouvrement de séjour, puis
l'union « commandes prises dans la période ou séjours qui la recouvrent ». Aucune ne survivait
sans exception — `bookedAt` est absent de 41 des 101 lignes d'archive d'Albiez, et sur « Tout
l'historique » la fenêtre commence au premier séjour connu, donc une commande antérieure en
tombait. Arbitrage de l'exploitant : **plus de fenêtre du tout sur ces deux listes**. Les huit
cartes, les séries et les blocs de comparaison ne changent pas d'un centime.

**Les deux biens vendent loin devant**, et c'est ce qui rend la règle nécessaire des deux côtés :
une station de montagne place l'hiver suivant dès septembre, et les 12 600 € des 24 Heures 2027
ont été signés en août 2026 — la plus grosse vente jamais faite par Barbusse était absente du
carnet de l'exercice où elle a été conclue.

**Les notes de bas de tableau font partie du correctif, pas de la décoration.** Les deux
responsables de site ont opposé leur veto, le même jour et sans s'être lus, sur une note partagée
devenue fausse ; puis `le-dahu` a démonté la note de remplacement, qui affirmait qu'un montant
hors période n'était pas dans les cartes — faux en « Par date de réservation », où `spreadRevenue`
impute tout le net sur `bookedAt`. Mesuré par `chef-de-stand` : 12 600 € sous la carte « Net
encaissé » pour un séjour dont pas une nuit n'a été dormie. Une note est un littéral, elle ne
connaît pas le mode sélectionné : elle renvoie à la convention au lieu d'affirmer.

**Invariant ajouté** à `scripts/verifier-indicateurs.ts` (88 vérifications) : *les deux tableaux
sont identiques sur les quatre périodes*. Il remplace les deux règles de fenêtre essayées, et
échoue si l'une d'elles revient.

**Limite connue, assumée par l'exploitant le 2026-09-22.** Les deux routes de statistiques ne
demandent à Beds24 que les arrivées jusqu'à `année courante + 1`. Une réservation pour 2028 n'est
donc ramenée par aucune requête, et les tableaux qui annoncent tout l'historique la tairaient en
silence. Jugé peu probable à cet horizon ; à rouvrir si un séjour à +2 ans se présente.

### v3.5.0 — une réservation payée sur une plateforme est pré-remplie comme acquittée

Relevé par l'exploitant le 2026-09-25 : pour facturer une réservation Airbnb, Booking.com ou
Abritel, il fallait trouver soi-même la date de paiement. Pire, `beds24ToPayload` mettait
`paid: false` sur **toute** réservation Beds24 : la facture d'un voyageur qui avait déjà payé
la plateforme portait l'IBAN et « Paiement attendu avant… ».

| Chemin | Contenu |
|---|---|
| `lib/invoice-payload.ts` | `platformPaymentOf(booking)` → `PlatformPayment` (`channel`, `paidAt`, `method`, `reference`, `caveat`) ou `null`. `beds24ToPayload` s'en sert : `paid`, `paidAt`, `paidMethod` (« Via Airbnb »…), `paidReference` (`apiReference`), `paymentDueDate`. |

**La date est celle de la réservation, au jour de Paris**, et c'est une approximation assumée :
Beds24 ne transmet la date du débit **sur aucun des trois canaux** (vérifié sur l'API le
2026-09-25 : ni ligne `payment` dans `invoiceItems`, ni date dans les `infoItems`). Juste
pour Airbnb dans la plupart des cas (sauf « payer une partie maintenant »), à vérifier pour un
tarif flexible Booking.com et pour l'échéancier Abritel. `caveat` porte cette phrase, que
l'écran de saisie affiche sous la date — la plateforme encaisse pour le compte de l'hôte, c'est
le paiement du voyageur à la plateforme qui éteint sa dette (art. 1342-2 C. civ.), pas le
versement à l'hôte.

**Séjour à venir : la date reste pré-remplie, l'avertissement se renforce.** Un paiement en
plusieurs fois (échéancier Abritel, « payer une partie maintenant », tarif flexible Booking.com)
peut ne pas être complet avant l'arrivée ; une facture « Paiement reçu » émise entre-temps
affirmerait le contraire. `le-percepteur` proposait de laisser la date vide dans ce cas ;
l'exploitant a choisi le 2026-09-25 de toujours pré-remplir, le contrôle reposant sur
l'avertissement. `platformPaymentOf(booking, today)` l'ajoute quand `arrival > today` —
`today` fourni par l'appelant, le module ne lit pas l'horloge.

**Trois refus, tous du côté prudent** — une facture « à payer » se corrige d'une case à cocher,
une facture acquittée à tort est une pièce fausse :
- statut non vendu au sens de `countsAsSold` (demande, inquiry, option `black`, annulée) ;
- Booking.com **sans** l'info `BOOKINGCOMBANKTRANS` : hors « Payments by Booking.com », le
  voyageur paie l'hôte, pas Booking. Le test suppose les `infoItems` demandés ;
- `bookingTime` illisible.

Additif, donc mineur : **changement de valeur de retour de `beds24ToPayload`, pas de
signature** — elle rend désormais `paid: true` pour une réservation de plateforme.
`beds24PaymentToPayload` réécrase les champs de paiement et ne change pas. Albiez ne facture
pas (aucun import d'`invoice-payload`), Barbusse est le seul appelant : validation de
`chef-de-stand`, celle de `le-dahu` est sans objet.

### v3.5.1 — Abritel n'est pas une plateforme qui encaisse

`v3.5.0` traitait Abritel comme Airbnb (« Via Abritel », date de réservation). C'est faux ici :
le voyageur Abritel paie **l'hôte** par carte via Stripe — échéancier de Beds24, ou facture
Stripe quand la carte est refusée — et Abritel prélève sa commission après coup. Relevé par
l'exploitant le 2026-09-25 et vérifié : réservation 82631846, réservée le 20/02, carte refusée
par Beds24 (`CARDFAILSTRIPE`), 1 344 € réglés par facture Stripe le 22/02 après sept échecs.
Une réservation Abritel reste donc « à payer » au pré-remplissage ; la facture acquittée se
fait depuis l'onglet Stripe, qui porte la vraie date. `v3.5.0` n'a été consommé par aucun
déploiement.

### v3.6.0 — la taxe de séjour a sa ligne sur la facture

Le PDF imprimait `amount` sur une ligne unique « Location saisonnière », donc **taxe de séjour
comprise dans le « Total HT »** — pour Booking.com (« City tax ») et le direct (« Taxe de
séjour €2,20… »), dont le `price` Beds24 contient la taxe. Or elle n'est pas le prix de la
prestation : elle est collectée pour la collectivité.

| Chemin | Contenu |
|---|---|
| `lib/invoice-payload.ts` | `InvoicePayload.touristTax` (part d'`amount`, lue par `touristTaxFromInvoiceItems`) et `touristTaxNote` ; `AIRBNB_TOURIST_TAX_NOTE`. Validation : `0 ≤ touristTax < amount`, forcée à 0 sur acompte / solde. |
| `lib/invoice-pdf.tsx` | Ligne « Taxe de séjour » dans le tableau, **Total HT = amount − taxe**, ligne « Taxe de séjour » entre TVA et Total TTC, mention sous le tableau. Total TTC inchangé. |

- **Airbnb n'a pas de ligne de taxe** : `price` = séjour + commission, la taxe est collectée et
  reversée par Airbnb (0 ligne de taxe sur 48 réservations, vérifié le 2026-09-25). La facture
  porte alors `AIRBNB_TOURIST_TAX_NOTE`, pour qu'un client rapproche un total inférieur à
  son reçu Airbnb.
- **Sans `invoiceItems`, rien ne change** : `touristTax = 0`, ligne unique comme avant.
- `beds24PaymentToPayload` ne ventile que si l'encaissement couvre tout le séjour — sur un
  paiement partiel on ne sait pas quelle part de taxe il porte.
- **Un acompte ou un solde ne se ventile pas** : c'est un forfait.
- Champs requis ajoutés au type : mineur quand même, `InvoicePayload` n'est construit que par
  les fabriques du socle et par `validateInvoicePayload`, qui prend 0 / "" par défaut — un
  client qui n'envoie pas ces champs retombe sur l'ancienne facture.

### v3.7.0 — chaque semaine du calendrier dans son cadre

`lib/calendar-lanes.ts` exporte `WEEK_GRID` : les classes du squelette des deux calendriers de
dashboard (`row`, `columnRule`, `barsBlock`). Additif, mineur.

Le défaut : **on se trompait de semaine en lisant une barre.** Les séjours s'empilent en bas de
leur semaine ; une semaine chargée (vacances + deux événements du circuit au-dessus d'un séjour,
du 5 au 11 octobre 2026 chez Barbusse) repousse la barre plus près des numéros de la semaine
suivante que des siens. Trois pistes écartées : griser les nuits occupées (Albiez a déjà deux
fonds de case, domaine ouvert et saison du lac), un séparateur plus épais (essayé : ne suffit
pas sur une semaine chargée), un cadre au seul survol (absent sur mobile). Retenu : un cadre
permanent par semaine et un vide de 6 px entre deux cadres — c'est le vide qui coupe la
proximité. Le cadre est un pseudo-élément `after:` au-dessus des cases, pour ne pas passer
sous les fonds de saison. Validé à l'écran par l'utilisateur sur les deux sites.

### v3.7.1 — le total du mois dans l'infobulle des revenus mensuels

`MonthlyRevenueChart`, vue « Par mois » : l'infobulle affiche `Réalisé`, `À venir`, puis une
ligne **Total** (somme des deux, recalculée à partir de la ligne survolée, ce n'est pas une série
du graphe), puis le `RevPAR`. Demandé par l'utilisateur pour ne plus additionner de tête.
Aucun export ni type public touché : correctif.

### v3.8.0 — codes d'accès d'une serrure Nuki

| Chemin | Contenu |
|---|---|
| `lib/nuki.ts` | Client Nuki Web limité aux codes du clavier et au journal : `listAuths`, `createKeypadCode`, `updateKeypadCode`, `deleteAuth`, `getLockHealth`, `listLog`, `redact`, `NukiError`. Jeton et `smartlockId` injectés. |
| `lib/access-codes.ts` | Planificateur **pur** : séjours + codes de la serrure → actions ordonnées (`delete`, `assign-pin`, `create`/`update`) et alertes sans PIN ni prénom. `pinFromPhone`, `generateKeypadPin`, `keypadArrivals`. |
| `lib/time.ts` | `parisInstant(date, heure)` : l'instant UTC d'une heure murale de Paris, juste aux changements d'heure. |
| `scripts/verifier-codes-acces.ts` | 53 vérifications, `npm run verifier:codes`, identiques sous `TZ=UTC`. |

**Pourquoi ici malgré la règle 6.** Le connecteur payant Beds24 → Nuki ne poussait plus les
codes depuis six mois (la serrure de remplacement n'avait pas Nuki Web activé). L'utilisateur
reprend la main et a tranché le 2026-11-07 : sujet socle, parce qu'un prochain logement pourrait
avoir une Nuki. le-douanier avait refusé faute d'exception écrite ; la voici. le-dahu : Albiez
reste sur son tag, une abstraction « code d'accès » commune serait artificielle pour une boîte
à clés. chef-de-stand : module validé, mise en service conditionnée au branchement (lecture du
live seul, statuts, passage à blanc, alertes dédoublonnées).

**Sans état.** Le nom du code porte le numéro de réservation (`90000010: Lucie`, format du
connecteur, 20 caractères au plus) : c'est la clé de jointure, rien n'est stocké ailleurs.
Codes `#…` jamais touchés ; code manuel repris seulement s'il a été visiblement saisi pour le
séjour (prénom dans le nom, ou plage datée). Seuls les séjours `confirmed` reçoivent un code.

**Quatre comportements de l'API, mesurés sur la serrure réelle** (détail dans l'en-tête de
`nuki.ts`) : écritures asynchrones (5 à 10 s) ; une mise à jour **efface les champs non
renvoyés** — un renommage seul a rendu un code daté permanent ; PIN unique par serrure (409) ;
**le message du 409 contient le PIN en clair**, d'où `redact` sur toute erreur.

**Le PIN.** Fourni par le PMS, ou généré si `random` est passé au planificateur : 6 derniers
chiffres du téléphone du voyageur (ou une autre fenêtre des 8 derniers) s'ils respectent les
règles du clavier (1 à 9, pas « 12 » en tête) et sont libres, sinon au hasard. Il est écrit
dans le PMS (`assign-pin`) **avant** d'être posé sur la serrure : un code qui ouvre mais que
le voyageur ne reçoit pas est le pire des cas.

**L'arrivée.** `keypadArrivals` lit dans le journal la première ouverture réussie au clavier
par le code d'une réservation (`trigger 255`, `state 0`). Elle remplace l'`infoItem` `CHECKIN`
que déposait le connecteur.

### v3.8.1 — correctifs de dates et de chiffres fiscaux

Correctif : aucun export, aucune signature, aucun type public modifié — d'où un correctif et non
une mineure, comme `v3.5.1` et `v3.7.1`. Des **valeurs affichées changent** ; chaque site les
valide avant de monter. Chaque correctif retire le `it.skip` qui le documentait.

| Chemin | Correctif | Effet visible côté site |
|---|---|---|
| `lib/invoice-number.ts` | Année du numéro lue au calendrier de Paris (`getUTCFullYear` avant). | Une facture émise le 1er janvier entre 0 h et 1 h à Paris prend un numéro de l'année nouvelle. |
| `lib/invoice-pdf.tsx` | « Émise le » au jour de Paris (jour UTC avant). | Facture faite entre 0 h et 1 h (2 h l'été) : la date d'émission n'est plus la veille. |
| `lib/invoice-payload.ts` | Dates par défaut (`emptyPayload`, `paymentToPayload`) et échéance J+3 de `defaultPaymentDueDate` au jour de Paris. | Formulaire de facture ouvert la nuit : date du jour et échéance justes. |
| `lib/taxe-sejour.ts` | `ecartDeCollecte` somme **toutes** les lignes de taxe (prolongation), lit `amount × qty` à défaut de `lineTotal`, écarte les lignes de paiement. | L'écart collecté / dû des séjours avec mineurs apparaît sur des réservations qu'il ignorait, et son montant change là où il y avait plusieurs lignes. |
| `lib/fiscal/revenus.ts` | `occupancyRatio` = nuits **réalisées** ÷ jours observés, bornes incluses, nuit du 31/12 comptée ; exercice futur : rien de réalisé, taux 0, `commissionsProjected` = commissions connues. | Taux d'occupation de la page fiscale **en baisse** sur l'exercice en cours (le carnet à venir n'y entre plus) ; exercice clos : légère hausse possible (nuit du 31/12) ; exercice futur : réalisé et taux à 0, commissions simulées non nulles. |
| `lib/stay-selection.ts` | Commentaire seul : le plafond de `consecutiveFreeNights` est 366, pas 365. | Aucun. |

Laissé en l'état, décision de l'utilisateur : quotient conjugal en dur dans `fiscal/ir.ts`
(foyer en couple, 3 parts) — `it.skip` conservé.

### v3.9.0 — contrôles post-déploiement et surveillance

Plan : `C:\Users\alexa\.claude\plans\keen-splashing-crescent.md`. **Mécanismes ici, valeurs chez
le site** : chaque site écrit `tests/deploy/site.ts` (`satisfies DeploySite`) qui importe ses
valeurs de son propre code, et `tests/deploy/deploy.test.ts` qui appelle `defineDeploySuite(site)`.

| Chemin | Contenu |
|---|---|
| `testing/deploy/` | Moteur sans vitest (`run`, `http` avec garde `allowedHosts`, `html`, `sitemap`, `normalize`, `report`, `beds24-monitor`) et contrôles `checks/{calendar,booking,indexing,llms,security,heartbeat}`, niveaux `vital` (horaire) / `full` (quotidien et post-déploiement). Résultats : compteurs et phrases fixes, **jamais un corps de réponse** — les logs Actions d'un dépôt public sont publics. `vitest-suite` est le seul point d'entrée vitest. |
| `config/deploy-site.ts`, `config/policies.ts` | `DeploySite` (tout ce qui est propre à un site est facultatif ⇒ `skip`, jamais un vert), `CancellationPolicy`, `PaymentPolicy`. Formes seules. |
| `lib/alert-state.ts` | `nextAlertState` : open / persist / escalate / recover, pur. `alertInputs` (dans `run`) reporte les échecs qu'un passage n'a pas re-contrôlés : sans lui, un `vital` horaire « rétablirait » un échec `full` chaque heure. |
| `lib/heartbeat.ts` | `recordHeartbeat`, `overdueCrons`, `heartbeatResponse` — un **nombre** de tâches en retard, jamais un nom (« la synchro de la serrure est en retard » renseignerait un cambrioleur). Magasin injecté. |
| `.github/workflows/deploy-checks.yml` | `workflow_call`, appelé **par SHA**, secrets un par un, `npm ci` sans secret, issue publique `surveillance-ko` sans détail, ntfy sur changement d'état, alerte si aucun run vert depuis N heures. |

Nouvel export `./testing/*` ; vitest en peerDependency facultative. Pièges payés pendant le lot :
vitest définit lui-même `BASE_URL="/"` (d'où `DEPLOY_BASE_URL`) ; Beds24 ne renvoie jamais les
jours déjà passés (ils ne comptent pas comme manquants) ; vitest masque la console des suites qui
passent (le rapport s'écrit sur `process.stdout`).

### v3.10.0 — préparation d'arrivée

| Chemin | Contenu |
|---|---|
| `lib/nuki.ts` | `NukiLockHealth` + `batteryChargePercent`, `lockState`, `motorBlocked` ; `listLogSince` (lecture incomplète ⇒ erreur, jamais un journal tronqué). **Une page de journal fait 50 lignes, quel que soit `limit`** (mesuré le 2026-11-07) ; la suite se lit avec `id=<dernier id>`. |
| `lib/access-codes.ts` | `missedArrivals` : seule l'ouverture au clavier par le code du séjour compte (`trigger 255`, `state 0`, nom `<bookId>:`) ; une ouverture par un code manuel non protégé rend `unknown`, jamais `missing` ; journal illisible ⇒ `unknown`. Le journal ne porte pas d'`authId`. |
| `lib/arrival-readiness/` | `schedule`, `evaluate`, `format`, `nuki-probe`, `types`. Heures, silences et seuils fournis par le site, sans défaut ; sondes facultatives (absente ⇒ `na`). Pas de PIN ni de nom de famille dans une alerte. Exception à la règle 6 : voir Arbitrages. |

### v3.11.0 — réservation par IA (devis, recherche, API des agents)

Plan : `C:\Users\alexa\.claude\plans\curried-mapping-stallman.md`. Une IA vérifie une
disponibilité, chiffre au centime, trouve des dates floues, produit un devis partageable et
amène à la page de paiement Beds24. **Rien n'est réservé ni payé par le socle.**

| Chemin | Contenu |
|---|---|
| `lib/stay-price.ts` | `fetchRoomPrice` sur `beds24.com/api/ajax/getroomprice.php` (sans jeton, celui de la page de réservation) : `roomprice` = total tout compris. Forme vérifiée (`RoomPriceShapeError` ⇒ anomalie) ; une erreur HTTP est une **panne**, pas une anomalie. Cache Next 5 min. `/inventory/rooms/offers` ne sert pas de repli : son prix exclut remise, frais et taxe. |
| `lib/stay-quote.ts` | `quoteStay` : forme → refus du site → disponibilité (lue dès la veille) → règles du calendrier (`stay-selection`) → prix. **Jamais de prix faux** : `expectedTotal` du site recalcule la grille, un écart > `tolerance` rend `price-blocked` et appelle `onAnomaly`. **Une panne n'est pas une indisponibilité** : `service-unavailable`. Un `warn` Beds24 a le dernier mot. `lastMinute` ⇒ `notices`. |
| `lib/stay-search.ts` | `findStays` (une lecture de dispo, règles rejouées par arrivée, prix **un par un**, au plus `limit × 2` appels, arrêt sur panne) et `nearbyStays` (alternatives d'un refus lié aux dates seulement). |
| `lib/quote-token.ts` | Devis signé JWT HS256 (jose), 7 jours, rotation par `_PREVIOUS` ; le `kid` n'est qu'un indice. Aucune donnée personnelle dans le jeton. |
| `lib/stay-agent.ts` | Les quatre outils (`propertyInfo`, `availability`, `quote`, `find`) sur des paramètres en chaînes : validation unique, politiques lues dans `CancellationPolicy` / `PaymentPolicy` (les constantes que contrôle `llms.policies`), liens `bookUrl` / `calendarUrl` / `quoteUrl`. Secret de devis absent ⇒ devis chiffré sans lien. |
| `lib/stay-agent-http.ts` | `createAgentRoute(cfg, depsFactory)` pour `app/api/agent/[tool]/route.ts` : GET seulement (une IA qui navigue ne sait pas faire de POST), CORS ouvert, `s-maxage` court, **jamais de cache sur un 5xx**. `runTool` sera repris tel quel par le serveur MCP. `openApi(cfg)`. |
| `lib/quote-page.ts`, `components/QuoteSummary.tsx`, `lib/quote-labels.ts` | `loadQuotePage` revérifie à chaque affichage : `valid`, `price-changed` (nouveau prix affiché), `unavailable` (+ alternatives), `expired`, `invalid` (autre site ou falsifié), `unchecked` (panne : on montre le devis signé). Textes en 5 langues sauf `included`, propre au site. |
| `components/ReservationCalendar.tsx` | Pré-remplissage par `?arrivee=&depart=&adultes=&enfants=` : voyageurs tout de suite, dates **seulement** si le moteur de sélection les accepte une fois le mois chargé. |

**Route publique, donc protections** (relecture cerbère) : `monthlyAvailability(read)`
(`lib/availability.ts`) — le site **doit** envelopper sa lecture Beds24 pour que l'API ne lise
que des mois civils entiers (quinze URL possibles, absorbées par le cache de 60 s, au lieu d'une
URL par bornes choisies par l'appelant) ; `find` plafonné à `limit × 2` prix, `limit` illisible ⇒
400 ; une alerte `onAnomaly` par type et par heure ; jamais d'écho d'une valeur reçue dans un
`detail` (relu par une IA) ; jetons de devis à audience `sejour-quote`, secret refusé s'il égale
`DASHBOARD_SECRET` ; jeton > 2 048 caractères ⇒ `invalid`. La limite par IP est une règle
**Vercel Firewall** de chaque projet (`/api/agent/*`, `/*/devis/*`), pas du code.
`OptionalExtra.bookingNote` : consigne ajoutée aux `notices` quand la page de paiement ne coche
pas le supplément d'elle-même. `purpose` est un paramètre documenté (refus propres au site).

`deps` est une **fabrique** côté site : `today` se recalcule à chaque requête. Vérification :
`npm run verifier` (`scripts/verifier-agent.ts`, réponses Beds24 enregistrées le 2026-11-07,
sans réseau). Pièges payés : la taxe de séjour de Barbusse ne porte que sur les adultes ; Beds24
rend les `minStay` décalés d'un jour ; la page `booking2.php` contient en dur « Pas de
disponibilité » (masqué), qu'un agent qui lit le HTML prend au pied de la lettre — d'où l'API.

### v3.12.0 — retours des tests voyageur

- `nearbyStays` adapte la durée à chaque arrivée (`StaySearch.maxExtraNights: 7`) : au moins le
  séjour minimum du jour, prolongé jusqu'au premier départ ouvert. À Noël, 2 nuits refusées
  rebondissent sur « 3 nuits du 21 au 24 » ; chez Albiez, un lundi fermé sur la semaine
  samedi → samedi. `findStays` sans ce champ (ou à 0) garde une durée fixe. `purpose` est
  transmis à `nearbyStays`, donc au refus propre au site. `MAX_STAY_NIGHTS` (60) borne à la fois
  la recherche et le paramètre `nights` de l'API.
- Le `warn` « minimum N » de Beds24 devient `minStayText(n, lang)` (5 langues), plus le texte brut.
- `QuoteSummary` : détail du prix quand un supplément est choisi (`labels.stay` + lignes), rappel
  d'annulation en prop `cancellation` — à construire par `cancellationText(policy, lang)`
  (`quote-labels`), tiré des constantes du site, paliers du plus au moins favorable ; chaîne vide
  sans palier remboursable ni grâce —, année sur la validité, prix par personne et
  par nuit sans centimes. Nouveau libellé obligatoire `stay` (fourni par `QUOTE_LABELS`).
- `StayAgentConfig.childrenDescription` (facultatif) : ce que le site compte comme enfant, servi
  par `info` et la description OpenAPI de `children`.

### v3.13.0 — serveur MCP (connecteur des assistants)

| Chemin | Contenu |
|---|---|
| `lib/stay-agent-mcp.ts` | `createMcpRoute(cfg, depsFactory)` pour `app/api/mcp/route.ts` : seul `POST` (et `OPTIONS`) est servi ; `GET` et `DELETE` rendent 405 sans passer par le transport (pas de flux SSE à rouvrir, sans état) ; un lot JSON-RPC est refusé (400) ; une exception rend un `isError` générique, sans le message d'origine. Quatre outils — `get_property_info`, `check_availability`, `get_quote`, `find_stays` — qui appellent **`runTool`**, exactement comme l'API REST : aucune logique propre. Schémas d'entrée zod (entiers, dates, suppléments du site en `enum`), descriptions rédigées pour un modèle (relayer `notices` avant le lien, ne rien réserver), `readOnlyHint`. Résultat : JSON en `content` texte **et** `structuredContent` ; `isError` seulement pour une requête mal formée ou une panne — un refus de dates est une réponse, avec ses alternatives. |

Transport : `WebStandardStreamableHTTPServerTransport` de `@modelcontextprotocol/sdk` 1.32.2, **sans
état** (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) — un serveur et un transport
neufs par requête, aucun flux SSE, aucune session : ce qui convient à une fonction serverless.
`mcp-handler` (Vercel) n'apporte rien de plus ici et exige le SDK v2 (`@modelcontextprotocol/server`).
SDK et zod en `peerDependencies` **facultatives** : seul un site qui monte la route MCP les installe.
Pas de « server card » : la spécification (SEP-2127) est encore un brouillon et son chemin de
découverte n'est pas fixé — l'URL du connecteur est donnée dans `llms.txt`. Vérification :
`npm run verifier`, section « Serveur MCP » (initialize, empreinte de `tools/list`, `tools/call`
sur les fixtures, sans réseau).

### v3.14.0 — la durée demandée d'abord, le séjour minimum réel, le détail du prix, IndexNow

Retours des tests voyageur du 2026-11-08.

| Chemin | Contenu |
|---|---|
| `lib/stay-search.ts` | `shortestStay(ctx, jour, auMoins, extra)` : la durée la plus courte réservable pour une arrivée (minimum du jour, minimum de chaque nuit couverte, premier départ ouvert). Alternatives classées par **3 × nuits subies + jours d'écart** (`EXTRA_NIGHT_WEIGHT`) : la semaine du samedi passe devant 9 nuits du jeudi au samedi suivant. Au moins un séjour de la **durée exacte** demandée s'il en existe un (Noël : le 2 nuits hors fêtes en plus des 3 nuits). Avec `near`, les séjours sortent **dans l'ordre du classement**, plus chronologiquement. |
| `lib/stay-quote.ts` | `checkStayRules` applique aussi le minimum de **chaque nuit couverte**, comme Beds24 (20 → 22/12 refusé : la nuit du 21 est en période des fêtes). `breakdown(p) ⇒ QuoteLine[]` facultatif : détail du total Beds24 (nuits, ménage, linge, taxe) ; s'il est fourni, sa somme **remplace** `expectedTotal` comme garde-fou et les lignes sortent en `stayLines`, au centime (l'arrondi va sur la première ligne). |
| `lib/stay-agent.ts` | `check_availability` rend `minStayByArrival` = séjour minimum **effectif** de chaque jour d'arrivée possible (6 nuits Beds24 + départ le samedi ⇒ 7) ; un jour absent n'accepte pas d'arrivée. Plus de `defaultMinStayNights` : `info.booking.minStay` dit que le minimum varie et renvoie à `check_availability` (`fallbackNights` n'est qu'un repli). |
| `components/QuoteSummary.tsx`, `lib/quote-page.ts` | Détail ligne par ligne (`stayLines`, puis suppléments) ; `notes` (rappels du site, ex. accueil des jeunes enfants) ; `included` peut être une fonction des suppléments retenus ; `withSrc` garde l'origine (`src`) sur les liens du calendrier. |
| `lib/indexnow.mjs`, `scripts/indexnow.mjs` | IndexNow (Bing, donc ChatGPT Search ; Yandex…) : `submitIndexNow`, `indexNowBody`, `sitemapUrls`, en JavaScript (Node n'enlève pas les types dans `node_modules`) ; le script n'est qu'un appelant. Clé publique par construction, une par site. |

**Note de version** (mineure, mais à lire avant de monter) :
- `defaultMinStayNights` disparaît des réponses `info` et `availability` : `info.booking.minStay`
  (`fallbackNights`, `howToKnow`) et `minStayByArrival` (minimum **effectif** par jour d'arrivée
  possible ; la profondeur de lecture se calcule pour ne jamais en faire disparaître un).
- `QuoteSummaryLabels.included` est `string | (suppléments retenus) => string`.
- `checkStayRules` **et** `isValidCheckOut` (calendrier) sont plus stricts : minimum de chaque
  nuit couverte, comme Beds24 — le calendrier ne propose plus 20 → 22/12.
- Avec `near`, `findStays` rend les séjours dans l'ordre du classement, plus chronologiquement.
- IndexNow : une seule source, `lib/indexnow.mjs` (JavaScript + JSDoc, entrée `exports`
  explicite), importée par `scripts/indexnow.mjs` et par le verifier. Le script refuse
  d'envoyer sans fichier de clé servi, sans sitemap en 200, avec une liste vide ou de plus de
  10 000 URL. Ne jamais lui passer en `--extra` une route qui interroge Beds24.

### v3.15.0 — retours du 2e tour de tests voyageur

- `find_stays` (MCP) : `weekdays` accepte une chaîne (`"fri,sat"`) ou un tableau (`["fri","sat"]`) ;
  côté REST, un paramètre répété (`weekdays=fri&weekdays=sat`, `extras=…&extras=…`) vaut une liste.
  Descriptions alignées : « 5 séjours par défaut, 8 au plus (`limit`) ».
- Message `min-stay` quand c'est une nuit couverte qui impose le minimum : il nomme la nuit **et**
  le départ au plus tôt (« la nuit du 21 est soumise à 3 nuits minimum, donc une arrivée le 20 doit
  repartir au plus tôt le 23 ») au lieu d'un « (nuit du 21) » qui égarait l'IA.
- Alternatives (`nearbyStays`) : `closestStay` ajoute le séjour qui **commence le jour demandé**, à
  la durée réservable la plus proche (plus courte comprise : lundi 11 → samedi 16), dans les jours
  d'arrivée demandés (`arrivalWeekdays`). Il est **placé d'office, pas classé** : dernière place de
  la tête, ou avant-dernière si le séjour de durée exacte occupe la dernière ; il remplace l'élément
  de cette place (repoussé juste après la tête) sans jamais décaler l'exact hors de la tête. Ordre : classement `3 × nuits subies + jours d'écart`, à égalité la date
  la plus tôt (Noël 24 → 26 : 21 → 24, 27 → 30, puis 19 → 21).
- `PropertyFacts.capacity` : `recommended?` facultatif dit pour combien le logement est pensé ;
  `min` reste accepté mais **ignoré** (`@deprecated`) — il se lisait comme un minimum de voyageurs.
  Version mineure : nouveau champ, nouveau comportement des alternatives.

### v3.16.0 — Google Search Console dans le dashboard

Les deux sites voulaient lire **les recherches qui mènent à eux** (requêtes, clics, impressions,
position) sans ouvrir Search Console. Deux consommateurs réels dès le départ : le module naît
dans le socle (règle 6 respectée).

- `lib/google-auth.ts` — jeton d'accès d'un **compte de service** Google, signé en RS256 par
  `jose` (déjà là), sans `googleapis`. `parseServiceAccount(raw)` lit le JSON de clé collé dans
  une variable d'environnement et rétablit les `\n` échappés de `private_key`. Cache mémoire
  par (`client_email`, portées triées). Réutilisable pour Business Profile plus tard.
- `lib/search-console.ts` — `getSearchConsoleReport({ credentials, siteUrl, days, today })` :
  totaux **par une requête sans dimension** (la somme des requêtes est sous-estimée, Google
  anonymise les rares), période précédente, série quotidienne complétée des jours vides,
  top 50 requêtes / 25 pages / 15 pays / appareils. `searchConsoleWindows` (pure, testée) :
  fin à `today − GSC_DATA_LAG_DAYS` (3), et `previous: null` quand la fenêtre précédente sort
  des `GSC_RETENTION_MONTHS` (16) — cas des 12 mois. `listSearchConsoleSites` pour diagnostiquer
  une propriété mal nommée. Le lib ne lit **aucune** variable d'environnement.
- `components/SearchConsoleDashboard.tsx` — même grammaire que `StatsDashboard` ; `accent`
  **obligatoire** (aucun site n'hérite du rose de l'autre), erreur en bandeau, jamais des zéros.
  N'importe le lib qu'en `import type`, pour garder `jose` hors du paquet client.

**Nommage** : `SearchConsole…` et jamais `Seo…` — `lib/seo.ts` *émet* des signaux pour les
moteurs, ce module-ci *lit* le résultat côté Google.

**Côté site** : une route admin (`guard.denyNonAdmin`, `dynamic = "force-dynamic"`) qui lit
`GOOGLE_SERVICE_ACCOUNT_JSON` et `GSC_SITE_URL` (`sc-domain:…` pour une propriété Domaine), une
page, un lien de nav `adminOnly`. Rien dans `proxy.ts` : le viewer est en liste blanche.
La clé ne vit que dans Vercel et `.env.local` — les dépôts sont publics.

### v3.17.0 — Pastilles de filtre du blog (`FilterChips`)

Les deux sites filtrent leur liste d'articles : Albiez par saison (guide), Barbusse par motif de
séjour (blog). Deux appelants réels : le composant naît dans le socle (règle 6).

- `components/FilterChips.tsx` — rangée de boutons `aria-pressed` dans un `role="group"`,
  compteur facultatif, `onChange(key)`. **Purement visuelle** : elle ne connaît ni les articles,
  ni la saison, ni le parcours, ni l'URL. Tokens de thème seulement (`primary`, `border`,
  `secondary`, `foreground`), transition coupée sous `prefers-reduced-motion`.
- **Ne monte pas** (veto le-dahu / chef-de-stand) : `BlogPostMeta`, `Season`, `Journey`, le
  prédicat de correspondance, la carte d'article, le tri, les libellés traduits, la lecture
  d'ancre ou de paramètre d'URL.
- Version mineure : composant nouveau, rien de modifié.

### v3.18.0 — messagerie voyageur (remplace les « Mail & Actions » de Beds24)

Les messages automatiques vivaient dans l'écran Beds24 : recopiés à la main en cinq langues,
sans version, invisibles de l'API — donc impossibles à relire ou contrôler. Ils passent dans le
dépôt de chaque site, et le socle décide quand et par où chacun part. Deux consommateurs réels.

- `lib/guest-messaging/types.ts` — `MessageTemplate` (déclencheur `booked` / `arrival` /
  `departure` + décalage en jours + heure de Paris ; politique de retard `send` jusqu'à un point
  ou `skip` après `graceHours` ; conditions en données ; `onAnchorChange` ; variables
  obligatoires et facultatives ; objet, corps, variante sans lien ; empreintes),
  `MessagingBooking` (entrée propre du moteur — **le `Booking` canonique ne change pas**),
  `MessageState`, `EmailTransport`.
- `schedule.ts` — `messageState` / `planMessages`, **purs**. Ordre : déjà envoyé → réservé
  (`in-flight`, puis `orphan` après 10 min, **jamais renvoyé**) → statut → canal → nuits →
  voie de sortie → butée (rien après le lendemain du départ) → `infoItem` requis → calendrier.
  `parisAt(jour, "HH:MM")` s'appuie sur `parisInstant` : juste des deux côtés d'un changement
  d'heure.
- `render.ts` — `{{nom}}`, `{{#nom}}…{{/nom}}`, `{{^nom}}…{{/nom}}`. Variable obligatoire
  absente ⇒ `RenderError` (fin du « Hello , »). Une valeur n'est jamais réinterprétée ;
  `sanitizeVar` retire contrôles et retours à la ligne.
- `validate.ts` — `validateTemplates` : textes présents, parité des variables avec le français,
  variable inconnue ou facultative non gardée, sections, restes de syntaxe Beds24, objet sans
  variable, chiffres/e-mails écrits en dur, rendu à blanc, liens vers un canal qui les filtre,
  longueur, empreintes trop courtes ou qui reconnaissent un autre modèle. Chaque site l'appelle
  dans un test qui bloque le build.
- `ledger.ts` — registre dans les `infoItems` : `MSG_<ID>_PENDING` avant l'envoi, `MSG_<ID>`
  après ; texte = métadonnées seules (`at`, `v`, `anchor`). `ledgerFromThread` reconnaît les
  messages de l'hôte par leurs empreintes (auto-actions Beds24 encore actives, envois manuels).
- `dispatch.ts` — `sendPlanned` (cron, plafond par passage : au-delà **rien** ne part) et
  `sendNow` (bouton du dashboard, aussi avant l'heure), mêmes contrôles : **mode du modèle
  (`modes`, seul `live` envoie — l'interrupteur général d'un site se traduit en modes `off`)**,
  relecture fraîche, recalcul, `ready` du site, rendu, réserver → **départager** → envoyer →
  confirmer. Le départage remplace l'écriture conditionnelle que Beds24 n'a pas : chaque trace
  porte un aléa (`n=`), on relit après avoir posé la sienne, et on s'efface si une autre trace du
  même modèle trie avant (instant, puis aléa). Un motif venu du site est réduit à un code
  (`/^[a-z0-9:_,-]{1,60}$/`, sinon `site-check`). `renderMessage` choisit la variante.
  ⚠️ Chaque écriture d'`infoItem` modifie la réservation, donc **déclenche le webhook** Beds24 :
  chez Barbusse, la synchro de la serrure repasse une fois par message (inoffensif, à savoir).
- `channel-rules.ts` — le seul endroit qui nomme un canal. Airbnb, Booking.com, Abritel : la
  messagerie ; Direct : l'e-mail du site ; Autre (HomeToGo…) : rien d'automatique. Ordre de
  reconnaissance : le champ `channel` s'il est rempli, sinon `apiSourceId`, sinon `referer`,
  sinon « Autre » — **une réservation non identifiée n'envoie rien**, jamais un e-mail par défaut.
  `messagingChannel` (≠ `normalizeChannel`, qui range l'inconnu en Direct pour les stats) et
  `realGuestEmail` (refuse les relais de plateforme et toute injection d'en-tête).
- `language.ts` — `pickGuestLocale` : `lang` Beds24, puis pays (`localeFromCountry`, remonté
  de Barbusse dans `locales.ts` avec `normalizeLocaleTag`), puis anglais ; la source est rendue.
- `overview.ts` + `components/GuestMessagesDashboard.tsx` — l'écran de suivi : DTO en liste
  blanche (prénom seul, aucun e-mail, téléphone, montant ni code), aperçu par `buildPreview`, qui
  masque **tout sauf** `MessageTemplate.previewVisible` (liste blanche : une variable secrète
  ajoutée plus tard reste masquée sans y penser), bouton « Envoyer maintenant » pour les modèles
  en mode `live`. `GuestMessagesBookingPanel` : les messages d'une réservation, pour la fiche du
  calendrier. Le composant n'affiche jamais le texte d'une erreur serveur : un message selon le
  code HTTP, et les seuls motifs codés qu'il connaît.
- `http.ts` — `createGuestMessagesRoutes({ guard, templateIds, report, preview, sendOne })` :
  les trois handlers de l'écran de suivi, **écrits une fois** parce que ce sont eux qui portent les
  contrôles ci-dessous ; chaque site les monte dans ses `route.ts`. Le cron reste chez le site.
- **Ce que les routes portent** (cerbere) : `denyNonAdmin` en tête de chaque handler,
  `Cache-Control: no-store`, erreurs génériques ; aperçu : `bookingId` entier et `templateId`
  connu ; envoi : `Content-Type: application/json` exact (415 sinon), `Origin` ou
  `Sec-Fetch-Site: same-origin` (403 sinon), corps en liste blanche, `sendNow` seul, réponse
  `{ outcome, reason }` ; cron : `verifyCronAuth`, `cap` toujours passé.
- `log.ts` — `logGuestMessage`, seule sortie console, en liste blanche de champs.
- `smtp.ts` — `createSmtpTransport` / `smtpConfigFrom` : le transport e-mail des réservations
  directes, **le même pour les deux sites** (SMTP authentifié OVH/Zimbra de leur domaine, aucune
  modification DNS). `nodemailer` est une dépendance paire **optionnelle**, chargée à la demande.
  Délais de 10 s, 465 en TLS ou 587 en STARTTLS, expéditeur = compte authentifié, copie cachée
  optionnelle, erreurs réduites au code SMTP (`SmtpError`) — celles de nodemailer citent
  l'adresse du destinataire. Le module ne lit aucune variable d'environnement.
- `beds24-types.ts` — `lang`, `apiSource`, `apiSourceId`, `modifiedTime`, `Beds24Message`.
- `beds24-client.ts` — `getMessages` (première page de 100 : un très long fil peut perdre une
  ancienne empreinte, le registre `infoItems` reste), `sendMessage`, `addInfoItems` (un item
  **sans `id`** est un ajout), `quota()` (crédits restants lus dans les en-têtes, par instance de
  fonction : indicatif). Les écritures passent par `postQuiet` — erreurs **sans** le corps de la
  réponse (Beds24 y renvoie le texte écrit), délai maximal de 15 s, invalidation de la voie
  réellement empruntée ; `updateNotes` y passe aussi désormais. `params` accepte un tableau
  pour répéter un paramètre (`status=confirmed&status=new`).
- `cron-auth.ts` — comparaison en temps constant (`constantTimeEqual`).

**Mode `test`** (demandé par l'hôte le 2026-11-08, avant de remplacer les auto-actions) : quatre
modes par modèle, `off` / `shadow` / `test` / `live`. En `test`, au moment où le message
partirait, il part **à l'hôte** par e-mail (`deps.test.to`), précédé d'un bandeau « COPIE DE
TEST », et la copie est notée dans `MSG_<ID>_TEST` (registre de test, `testLedgerFromInfoItems`),
jamais lu comme un envoi au voyageur. Le cron calcule son plan avec `planByMode` ; un modèle en
`test` n'est dû que dans les 2 h qui suivent son échéance (`testFreshHours`) — sans quoi
l'activation rattraperait tout ce que Beds24 a déjà envoyé. Plafond à part, sans arrêt du
passage. Dans l'écran, le bouton devient « M'envoyer une copie de test », disponible même
après une première copie.

**v3.18.1** (cerbere, 2026-11-08) : la trace `pending` est horodatée **au moment de son écriture**, plus au début du passage. Avec l'heure de début, un passage parti plus tôt mais écrivant plus tard se croyait prioritaire sur une trace déjà relue par l'autre : deux envois au voyageur. Fenêtre résiduelle : la latence d'une écriture Beds24.

**Dernière minute** (même date) : deux conditions de modèle.
- `minLeadHours` — réservée moins de N h avant le jour d'arrivée : écarté (`late-booking`), un
  autre message en porte le contenu (Albiez : l'avant-arrivée passe dans le message du code).
  Ce message décide avec `isLateBooking(b, heures)` (schedule.ts), la même mesure : sans date de
  création explicite, `false` des deux côtés — au pire un doublon, jamais un contenu perdu.
- `quietHours` — message de confort : écarté (`quiet`), jamais reporté, si un autre message est
  parti ou si la réservation a été créée (la confirmation Beds24 part à ce moment) dans les N h
  qui précèdent son échéance. Jamais sur un message qui porte un accès. Seuls les envois
  confirmés comptent (pas les `pending`) ; en `test`, les vrais envois comptent avec les copies.

Mesures du 2026-11-08 (lecture seule) : un `GET /bookings` coûte ~1 crédit ; codes
`apiSourceId` Airbnb 46, Booking.com 19, Vrbo/Abritel 30, HomeToGo 78, direct 0 ; `lang`
vaut `fr`, `en`, `es`, `it`, `ru` ou vide. Non mesuré, à faire avant de passer un site en
`live` : livraison réelle sur Abritel, envoi sur une réservation directe, liens chez
Booking.com, effet d'un `infoItem` sur le webhook.

### v3.19.0 — variations colorées sur la page Référencement (2026-11-08)

`MetricCard` prend un `subTone?: "up" | "down"` facultatif : sous-ligne de variation en vert
(`emerald-700`, contraste AA en `text-xs`) ou en rouge (`red-600`), le symbole ▲/▼ restant dans le
texte. `SearchConsoleDashboard` le renseigne ; la position compte « up » quand elle gagne des places.
Une variation qui s'arrondit à zéro s'écrit « = période précédente », sans flèche ni couleur.
`StatsDashboard` (pages montrables à un banquier) n'en met pas : la carte reste sans couleur.

### Comment une application s'y branche

```jsonc
// package.json
"@sejour/socle": "github:colivinglemans-prog/sejour-socle#v0.1.0"
```
Les composants React du socle se résolvent par `@sejour/socle/components/<Nom>`, une entrée
`exports` ajoutée au Lot 3 : `"./components/*": "./components/*.tsx"`. Comme pour `./lib/*`,
sans cette carte l'erreur n'apparaît qu'au `next build`, pas au `tsc`.

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
