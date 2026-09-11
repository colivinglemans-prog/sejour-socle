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
| Régime d'Albiez | **La SCI JUARISAL est à l'IS**, et sa comptabilité est tenue sur **Indy.fr**. Aucune extension SCI/IS du module fiscal n'est conçue, aucune note de cadrage n'est produite : la question est tranchée, pas reportée. | 2026-09-11 |
| Indy | **Pas d'API publique** — vérifié le 2026-09-11. Le seul point d'accroche envisageable serait l'export FEC. Rien n'est construit dans cette direction. À ne pas reposer. | 2026-09-11 |
| Exception à la règle 6 | `lib/fiscal/` monte avec **un seul consommateur**, en connaissance de cause. Motif et portée dans `lib/fiscal/README.md`, qui doit être relu avant tout arbitrage sur ce module. | 2026-09-11 |

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
| 1 | Auth, rôles, cloisonnement — **ferme la fuite `NUKI_PIN`** | `cerbere` | `v0.2.0` |
| 2 | Beds24 + modèle canonique `Booking` | `champollion` | `v0.3` — code écrit, tag à poser |
| 3 | Dashboard | `madame-soleil` | `v0.4` — code écrit, tag à poser |
| 4 | Factures, taxe de séjour, fiscal | `le-percepteur` | `v0.5` — code écrit, tag à poser |
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
| `lib/invoice-payload.ts` | `InvoicePayload`, `InvoiceKind`, `InvoicePaymentDetail`, `beds24ToPayload`, `beds24PaymentToPayload`, `paymentToPayload`, `emptyPayload`, `validateInvoicePayload`, `computeNights`, `staySharePercent`, `remainingAfter`. | Barbusse, logique pure, montée telle quelle |
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
