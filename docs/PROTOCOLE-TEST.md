# Protocole de test

## Rejouer le protocole en une commande

Ce document se rejouait à la main, une heure de `curl` par lot. `scripts/protocole/` en fait
une commande — matrice des portes, test de fuite, 16 charges utiles et leurs invariants,
captures d'écran des deux dashboards — contre une base quelconque, locale ou en production.

```bash
npm run protocole -- --site albiez|barbusse|both --base <url> [--playwright]
```

Aucun argument de ligne de commande ne porte de secret. Tout vient de variables
d'environnement :

| Variable | Sert à |
|---|---|
| `ALBIEZ_BASE`, `BARBUSSE_BASE` | l'URL de base de chaque site (ignorée avec `--site both`, qui lit les deux) |
| `ALBIEZ_ADMIN_PASSWORD`, `ALBIEZ_VIEWER_PASSWORD` | connexion Albiez (`POST /api/auth/login {"motDePasse"}`) |
| `BARBUSSE_ADMIN_PASSWORD`, `BARBUSSE_VIEWER_PASSWORD` | connexion Barbusse (`POST /api/auth/login {"password"}`) |
| `CRON_SECRET_ALBIEZ`, `CRON_SECRET_BARBUSSE` | en-tête `Authorization: Bearer …` du cron keepalive |

`--env-file <chemin>` charge un `.env` local (via `process.loadEnvFile`, l'équivalent en cours
d'exécution de `node --env-file=<chemin>` — les deux reviennent au même) :

```bash
node scripts/protocole/run.mjs --site both --env-file .env.protocole
```

Un rôle non connecté (mot de passe absent ou refusé) ne fait pas planter le protocole : la
ligne correspondante dit « non testé : … » plutôt que d'être comptée comme un échec. C'est le
cas connu de l'administrateur de production d'Albiez, dont le mot de passe n'est pas celui de
`.env.local`.

`--playwright` ajoute la capture plein écran des deux dashboards en admin, à 390×844 (mobile)
et 1280×900, dans le dossier daté — le seul recours à un navigateur de tout le protocole, et
uniquement pour ce qu'un œil humain doit voir. Playwright est une devDependency optionnelle :
sans elle, ou sans navigateur installé (`npx playwright install chromium`), le module le dit
et le reste du protocole continue.

`--compare <dossier>` diffuse les charges utiles de l'exécution en cours contre une photo
précédente, clé par clé — les clés qui dérivent naturellement de l'horloge (`period.*`,
`asOf`, `forwardOccupancy90`) sont signalées à part, jamais comptées en échec.

Chaque exécution écrit un dossier daté `.protocole/<horodatage>/` (charges utiles au format
JSON, captures PNG, `rapport.md`) — jamais commité, voir `.gitignore`. Le code de sortie est 1
s'il y a au moins un ÉCHEC, 0 sinon.

Écrit après six lots livrés en deux jours sur deux sites en production. Chaque règle vient
d'une erreur réellement commise, et la plupart des bugs trouvés n'étaient **pas** visibles à
l'écran.

---

## Cinq principes

**1. Mesurer, jamais déduire.** Deux sessions ont cru, le même jour, que la production n'était
pas à jour — sur la foi d'une référence de commit périmée. La seule chose qui tranche est de
**lire la page en ligne** et l'âge du déploiement Vercel. Un dépôt propre ne dit rien de ce qui
tourne.

**2. Comparer des charges utiles, pas des impressions.** « Les chiffres ont l'air bons » ne vaut
rien. `curl` avant, `curl` après, comparaison octet pour octet. Un graphe peut changer de forme ;
un total qui bouge doit être expliqué, pas constaté.

**3. Toujours sous `TZ=UTC`.** C'est le fuseau de Vercel. Trois bugs de date ont été trouvés
ainsi, dont un qui déplaçait **459,16 €** de mars à avril la nuit du changement d'heure. Un
chiffre qui diffère entre Paris et UTC est un bug, pas une curiosité.

**4. Le compilateur est un testeur.** Le DTO typé a trouvé le seul endroit où un montant était
lu sans garde de rôle. Une liste blanche construite champ par champ vaut mieux qu'une
suppression de champs : un nouveau champ sensible est alors caché par défaut, pas découvert
après coup.

**5. Une dégradation silencieuse est pire qu'une panne.** Les replis masquent les pannes : si le
jeton public meurt, le site continue de fonctionner en ayant reperdu la séparation des
privilèges. Tout repli doit avoir une sonde qui le rend visible — c'est la vraie raison d'être
du cron keepalive.

---

## Avant de commencer un lot — la photo de référence

Sans photo d'avant, on ne peut rien prouver. À prendre **avant la première modification**.

```bash
# Sous TZ=UTC, et se connecter d'abord (voir plus bas)
for per in year fiscal 1y 6m 3m 30d; do
  for mode in averagedPerNight byCheckIn byCheckOut byBookingDate; do
    curl -s -b cookie.txt "$BASE/api/dashboard/stats?period=$per&mode=$mode" \
      -o "avant-$per-$mode.json"
  done
done
```

Côté Albiez, l'équivalent est `?periode=annee|precedente|12m|toute` × le **même** `mode=` — les
valeurs sont en anglais des deux côtés depuis le Lot 3 (`averagedPerNight|byCheckIn|byCheckOut|
byBookingDate`) — plus `/api/dashboard/calendrier?mois=YYYY-MM`.

⚠️ **Vérifier que la photo exerce bien les quatre conventions** : les quatre fichiers d'une même
période doivent avoir des sha256 **différents**. Le 2026-09-12, une première photo a été prise
avec `revenueMode=` (paramètre inexistant, la route lit `mode=`) et des valeurs françaises
périmées : 45 fichiers, tous identiques entre modes, trois conventions sur quatre non couvertes,
et rien ne le signalait. Une photo qui ne varie pas quand on change le paramètre n'a pas lu le
paramètre.

Si le lot renomme des clés, prévoir une table de correspondance et comparer les **valeurs**.

---

## Après le code, avant le déploiement

### La batterie automatique — les trois dépôts

```bash
npx tsc --noEmit && npx next build && npx eslint .
```

Albiez doit être à **zéro problème**. Barbusse a **2 erreurs `react-hooks/refs`** connues dans
`BookingCalendar.tsx` (accès à une ref pendant le rendu, écrites en mars 2026) : toute erreur
supplémentaire est une régression.

### Les invariants — valeurs de référence au 2026-09-12

| Mesure | Valeur attendue |
|---|---|
| Barbusse, `/api/dashboard/stats?period=fiscal` = `/api/dashboard/fiscal?year=2026&projected=false` | **le même nombre**, au centime, sur le CA (`totalRevenue` = `realized + confirmedUpcoming`) et sur le réalisé. Relevé du 2026-09-13 : `76024.50` / `65835.02`, 54 réservations, commissions `9541.59` |
| Barbusse, Σ `price` des vendues − taxe de séjour des lignes | = CA fiscal. Relevé : 76 842,20 − 817,70 = 76 024,50 ; la page `taxe-sejour` rend 817,70 |
| Albiez, net / brut / commissions / nuits (« toute ») | `37514.05` / `43938.37` / `6424.32` / 525 — **inchangés par le Lot B**, vérifié 16/16 |
| Fuite viewer (voir ci-dessous) | **54** réservations (les 4 `new` sont visibles depuis le Lot B), 15 clés, **0** `NUKI_PIN`, **15 722 octets** |

⚠️ L'ancien invariant `Barbusse, CA fiscal 77 246,92 €, 55 réservations, 44 %` est **supprimé** : c'était
`projectedTotal` — réalisé + confirmé + moyenne journalière × jours restants — plus 1 344,35 € d'un
bien saisi à la main. Une extrapolation qui changeait chaque jour, additionnée à une saisie. Aucun
invariant ne porte plus sur une valeur `projected=true` ni sur un bien `source: "manuel"` ; le bien
manuel se relève sur sa propre ligne, comme témoin de saisie.

⚠️ **`dynamicPricingRevenue` n'est pas un témoin valable** : il dérive des prix Beds24 futurs et
change tout seul d'une heure à l'autre. Stable au sein d'un déploiement, pas entre deux.

### Le test de fuite — le plus important

```bash
curl -s -b viewer.txt \
  "$BASE/api/dashboard/bookings?arrivalFrom=2025-01-01&arrivalTo=2026-06-30" -o v.json
node -e '
const a=JSON.parse(require("fs").readFileSync("v.json","utf8"));
const cles=[...new Set(a.flatMap(Object.keys))].sort();
const interdits=["price","email","mobile","phone","infoItems","invoiceItems",
                 "stripeToken","commission","deposit","address"];
console.log(a.length+" resas, "+cles.length+" cles, "
  +(JSON.stringify(a).split("NUKI_PIN").length-1)+" NUKI_PIN");
const f=interdits.filter(x=>cles.includes(x));
console.log(f.length ? "FUITE : "+f.join(", ") : "aucun champ sensible");'
```

La fenêtre large est délibérée : c'est elle qui atteignait les 37 codes de serrure de l'archive
locale. Une fenêtre étroite ne prouve rien.

### La matrice des portes

| Route | anonyme | viewer | admin |
|---|---|---|---|
| `/dashboard` | 307 → connexion | 307 → calendrier | 307 → calendrier |
| `/dashboard/calendar` (Barbusse), `/dashboard/calendrier` (Albiez) | 307 | 200 | 200 |
| `/dashboard/stats` (Barbusse), `/dashboard/statistiques` (Albiez) | 307 | **307 → calendrier** | 200 |
| `/api/dashboard/bookings` | 401 | 200 réduit | 200 complet |
| `/api/dashboard/stats` | 401 | **403** | 200 |
| `/api/dashboard/fiscal`, `taxe-sejour`, `invoices/prefill` | 401 | **403** | 200 |
| `/api/dashboard/invoices/generate` (POST, Barbusse) | 401 | **403** | 400 sur payload vide — la garde est franchie, le compteur de factures n'est pas atteint |
| `/api/dashboard/heating` (Barbusse) | 401 | **200** — voulu | 200 |
| `/api/dashboard/code-acces` (Albiez) | 401 | **403** | 200 |
| `/api/dashboard/calendrier` (Albiez) | 401 | **200** — voulu, projection viewer | 200 |
| `/api/cron/*` sans en-tête | 401 | — | — |

Tester aussi un **jeton forgé** non signé portant `{"role":"admin"}` : doit rendre 401.

### Le tunnel de réservation — le chemin qui encaisse

Sur la réponse réelle de `/api/disponibilites` (Albiez) ou `/api/availability?mode=map`
(Barbusse) : une arrivée valide est trouvée, un départ trop tôt est refusé, un départ ≥ minimum
est accepté, et **une nuit vendue reste un départ possible** (le voyageur part le matin, le
suivant arrive le soir).

**Albiez, rotation du samedi** — règle métier qu'il est seul à avoir :

```bash
curl -sL "$BASE/api/disponibilites?du=2027-02-01&au=2027-02-28" | node -p '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const sa=new Set(d.sansArrivee);
const ok=Object.entries(d.dates).filter(([j,v])=>v&&!sa.has(j)).map(([j])=>j);
"arrivees : "+ok.length+" — jours : "+[...new Set(ok.map(j=>
  ["dim","lun","mar","mer","jeu","ven","sam"][new Date(j+"T12:00:00Z").getUTCDay()]))].join(",")'
```

Toutes les arrivées doivent tomber un **samedi**.

### Les événements

Un événement `confirmed: true` émet un nœud `"@type":"Event"` ; un événement non confirmé n'en
émet **aucun**. Ne jamais annoncer à Google une date supposée comme un fait.

```bash
curl -sL "$BASE/fr/guide/<slug>" | grep -c '"@type":"Event"'
```

**Les champs recommandés (v3.2.0)** — `organizer`, `performer`, `offers` viennent du catalogue,
`description` et `image` de l'article. Deux interdits à vérifier sur chaque nœud émis :

```bash
# 1. Aucune de nos URL de réservation ne doit apparaître dans offers : la billetterie est
#    celle de l'organisateur, jamais notre hébergement. Attendu : 0.
curl -sL "$BASE/fr/guide/<slug>" | grep -o '"offers":{[^}]*}' \
  | grep -c 'booking2.php\|coliving-barbusse.fr\|albiez-aiguilles.fr'

# 2. La description suit la langue de la page : les deux lignes doivent différer, preuve que
#    l'i18n est restée chez l'appelant et non dans le socle.
for l in fr en; do
  curl -sL "$BASE/$l/guide/<slug>" | grep -o '"@type":"Event"[^<]*' | grep -o '"description":"[^"]*"'
done
```

Et le site n'est **jamais** `organizer` : `grep -o '"organizer":{[^}]*}'` ne doit pas contenir le
nom du site.

**Le pendant côté CTA (v3.3.0)** — sur l'article d'un événement **non confirmé**, le bloc de
réservation reste, mais il dit que les dates sont provisoires. Le CTA est client : la phrase
n'est pas dans le HTML prérendu, il faut un navigateur (`--playwright`) ou vérifier que le
libellé est bien câblé dans le dictionnaire du site.

```bash
# Attendu : 0 nœud Event…
curl -sL "$BASE/fr/blog/<slug-non-confirme>" | grep -c '"@type":"Event"'
# …et, dans le rendu navigateur, la phrase `provisionalDates` du site sous le titre du bloc.
```

Un article non confirmé sans la phrase est un défaut du site, pas du socle : le champ est
optionnel et le compilateur ne le réclame pas.

### Invariants permanents des statistiques (arbitrage du 2026-09-12)

```
INV-STATS-1 — En convention averagedPerNight : prix moyen × nuitées vendues = net, au centime.
En byCheckIn, byCheckOut et byBookingDate l'égalité ne tient pas : l'écart est relevé, consigné,
et NE DOIT PAS être « corrigé ». Un correctif qui rétablirait l'égalité dans les quatre
conventions aurait recalculé l'argent en dehors de spreadRevenue.

INV-STATS-2 — forwardOccupancy90 se mesure sur [aujourd'hui, +89 j], jamais sur elapsedTo.
C'est la seule carte tournée vers l'avant, et son libellé le dit.

INV-STATS-3 — Les huit cartes se mesurent sur la part écoulée [du, min(au, aujourd'hui)].
Un euro déjà réservé au-delà d'elapsedTo apparaît UNE fois, dans « Revenu engagé », segment
Confirmé — jamais aussi dans « Net encaissé ».

INV-STATS-4 — À période et convention égales, indicators.netRevenue et la somme des barres de
la série mensuelle sur [du, elapsedTo] coïncident à 0,00 €. Le même SoldBooking[] nourrit les
cartes, la série, la comparaison annuelle et les canaux — ou aucun des quatre. Le tri par statut
s'applique une fois, par soldBookings(), jamais dans un calcul.

INV-STATS-5 — new compte comme vendu ; request, inquiry, black et cancelled, jamais.
```

`npm run verifier` dans le socle rejoue INV-STATS-1 sur les quatre conventions, plus
`RevPAR × nuitées disponibles = net`, `RevPAR = prix moyen × occupation` et
`brut − commissions = net`.

### Lot B (convergence des stats) — critère mesuré, et ce qui est devenu invariant

Le critère provisoire « +7 076,89 € de commissions, CA brut inchangé » était **faux par
construction** : les lignes de facture Airbnb sont le versement hôte, déjà nettes de la commission
(qui n'existe que dans le champ `commission`), donc le CA fiscal « par lignes » rendait un net pour
Airbnb et un brut pour les autres. Le Lot B a posé **une seule définition du brut, dans le
`toBooking` de chaque site** — `gross = price − taxe de séjour des lignes`, `commission =
commissionOf`, `net = gross − commission`, `price` faisant foi — et le fiscal lit ces champs.

**Mesuré le 2026-09-13, local `TZ=UTC`, contre la production du 12/09 (Barbusse) :**

| Grandeur | Avant | Après | Δ | Cause |
|---|---:|---:|---:|---|
| `/stats?period=fiscal` `totalRevenue` | 77 246,92 | **76 024,50** | −1 222,42 | −404,72 `inquiry` · −817,70 taxe de séjour sortie du brut |
| `/stats?period=fiscal` réservations | 55 | **54** | −1 | `countsAsSold` |
| `/fiscal?year=2026&projected=false` réalisé + confirmé | 70 884,09 | **76 024,50** | +5 140,41 | commission Airbnb réintégrée dans le brut, lignes périmées sorties, `inquiry` sortie |
| `/fiscal` commissions (réalisées + à venir) | 0,00 | **9 541,59** | +9 541,59 | D1 : le motif de libellé ne matchait rien, `commissionOf` lit le champ |
| `/fiscal` `bic.ca` du bien Beds24 | 97 859,73 *(projeté)* | **76 024,50** | — | le défaut est devenu contractuel ; `?projected=true` rend 104 165,74, libellé « simulation » |
| `/stats?period=year` `totalRevenue` | 14 421,64 | **14 319,62** | −102,02 | taxe de séjour |
| Albiez, 16 charges utiles | — | **identiques** sur net, brut, commissions, graphe, canaux | 0,00 | seules les clés datées bougent (photo du 12, mesure du 13), réconciliées à la ligne |
| Albiez, `comparaison[2026]` | `projection` 16 126 à 17 234 selon l'onglet | **`committedTotal` 13 640,04**, valeur unique | — | l'attendu libre était une extrapolation |

**Invariants permanents ajoutés :**

```
INV-FISCAL-1 — Sur le même exercice, le CA de /api/dashboard/fiscal (projected=false, bien
Beds24, réalisé + confirmé) = totalRevenue de /api/dashboard/stats?period=fiscal, au centime.
Et realized fiscal = projection.realizedRevenue des stats. Relevé : 76 024,50 / 65 835,02.

INV-FISCAL-2 — Σ price des nuits vendues − Σ touristTax = CA fiscal. Relevé : 76 842,20 − 817,70.

INV-FISCAL-3 — Σ touristTax des Booking = total collecté de /api/dashboard/taxe-sejour, au
centime. Relevé : 817,70 des deux côtés. ⚠️ CONDITIONNEL : la page taxe interroge en fenêtre de
DÉPART, le fiscal en fenêtre d'ARRIVÉE. L'égalité tient tant qu'aucun séjour à cheval sur le
31/12 ne porte de ligne de taxe (Airbnb n'en porte jamais). Un Booking.com à cheval la casserait
sans prévenir : dans ce cas l'écart doit être égal à la taxe de ce séjour, et rien d'autre.
```

**Quatre lignes de facture anomales chez Barbusse, nommées pour qu'on ne les « corrige » pas
dans le code** : `82274645` et `80467451` (Airbnb, la ligne d'origine cohabite avec la ligne
refaite, −193,74 € si les lignes faisaient foi), `80768054` (direct, deux groupes de lignes
entiers), `81056833` (direct, remise manuelle de −22,00 € non répercutée dans `price`). `price`
fait foi : +22,00 € d'erreur documentée, à corriger **dans Beds24**, pas ici. Un libellé de
taxe « 3% » nu échappe au motif : le remède est aussi dans Beds24 (« Taxe de séjour 3% »).

**Ce qui n'a pas bougé et devait ne pas bouger** : chauffage, 8 crons (401 sans en-tête,
keepalive `ok` sur les trois jetons), compteur de factures (`invoices/generate` admin sur payload
vide → 400 avant le compteur), badge d'événement, vitrine 5 locales, redirections `/reservation`.
`/dashboard/water-heater` répond 500 en local faute d'identifiants Cozytouch : **à vérifier en
preview**.

Le tag consommable du Lot B est **`v2.0.0`** (surface amputée : `computeCABooking`,
`computeCAFromInvoiceItems`, `computeCommissionBooking`, `sumCommissions` et
`lib/fiscal/commissions.ts` disparaissent ; `FetchBookingsForFiscal` devient
`FetchStaysForFiscal` ; `YearComparison.projection` devient `committedTotal`). `v1.0.0` reste non
consommable.

### Lots C + D (charge utile unique et écran partagé) — critère d'acceptation chiffré

Rejoué sous `TZ=UTC`, les deux apps sur le même tag, **à la même minute**. 32 charges utiles =
2 sites × 4 périodes (`currentYear|previousYear|rolling12m|all`) × 4 conventions.

| Grandeur | Attendu |
|---|---|
| Clés de premier niveau, Albiez vs Barbusse | `diff` **vide**, sur les 4 × 4 combinaisons. Seul `chart.byChannel` varie par les années présentes |
| `npm run verifier` (socle) | **84/84**, sans serveur ni Beds24 |
| Reproductibilité | Deux appels à une heure d'écart → charge utile **identique à l'octet** (aucun champ ne dérive d'un prix Beds24) |
| `INV-STATS-4` (Σ barres réalisées = `indicators.netRevenue`) | **32/32**, tolérance `0,005 € × nb de mois + 0,005` |
| Σ de toutes les barres = `committedRevenue.total` | en `averagedPerNight` seulement (le minimum garanti ne suit pas le sélecteur), même tolérance |
| `indicators.grossRevenue − indicators.commissions = indicators.netRevenue` | **32/32**, au centime |
| `committedRevenue.realized = indicators.netRevenue` sur `period=currentYear` | égalité stricte en `averagedPerNight` ; dans les trois autres conventions `committedRevenue` est **identique** à celui de la convention par défaut (il ne dépend pas de l'axe d'affichage) |
| RevPAR = `stayNet ÷ availableUnitNights` | **32/32** ; un seul RevPAR par écran (carte et courbe) |
| `comparison[année en cours].committedTotal = committedRevenue.total` | **32/32**, égalité stricte (ferme le C2 du dahu, 30 €) |
| `comparison[année en cours].toDate = indicators.netRevenue` sur `currentYear` / `averagedPerNight` | **égalité stricte** — le filtre des années comparables porte sur les années produites, jamais sur les séjours |
| Séjours à cheval sur le 1er janvier, Barbusse | `80062893` et `79264420` présents dans `chart`, `comparison` et `channelsByYear` de 2026 : **17 nuits, 447,40 € de brut, 364,17 € de net** |
| Barbusse, unité = nuit de maison | `unitsTotal` **1**, `units` 1 (maison) / 1/9 (chambre) ; `soldUnitNights` sur `all` = 104 + 280/9 ≈ **135,1** nuits de maison ; occupation inchangée (≈ 43,6 % sur 2026), prix par nuit et RevPAR × 9 par rapport à la nuitée-chambre |
| Aucune période ne commence avant le premier séjour connu | Barbusse `previousYear` : `period.from` = **2025-11-26**, occupation sur 36 jours et non 365 |
| Accent de Barbusse | `#334155` — jamais `#FF385C`, qui est la couleur du canal Airbnb |
| Albiez, `currentYear` net | **12 555,31 €** (13/09) ; `committedRevenue.total` 2026 = **13 670,04 €** |
| `recentStays` / `topStays` | Listes **complètes**, non plafonnées ; assiette `[from, to]` en recouvrement ; `topStays` exclut les lignes à 0 nuit |

**Réconciliation fiscale (Barbusse, exercice 2026, `projected=false`)**

| Grandeur | Attendu |
|---|---|
| `INV-FISCAL-1` — `fiscal.realized` = `stats.indicators.grossRevenue` (part écoulée, `currentYear`) | **66 260,42 €** (13/09), au centime |
| Commissions, fiscal = stats | **7 732,79 €** des deux côtés, au centime |
| `INV-FISCAL-4` — net fiscal total vs `committedRevenue.total` | **66 825,09 € vs 66 825,08 €** — écart **≤ 0,01 € par exercice**, arrondi cumulé du prorata par nuit. **Ne jamais le rattraper par un ajustement.** Dette : `splitAmount` doit passer à `spreadRevenue`, pour que l'écart devienne impossible plutôt que toléré |
| Albiez | Δ stats/fiscal sans objet (pas de page fiscale) ; aucun séjour à cheval, trois ans de suite |

⚠️ `INV-FISCAL-1` s'énonce désormais sur la **part écoulée** : depuis le Lot C le fiscal impute au
recouvrement et au prorata des nuits, comme la page de statistiques, et le CA total d'un exercice
(`realized + confirmedUpcoming`) n'a plus d'équivalent dans une seule carte — il vaut le brut de
`committedRevenue` (réalisé + confirmé), que la charge utile porte en net. Le relevé du Lot B
(`76 024,50` des deux côtés sur la fenêtre d'arrivée) est historique.

**Relevé du jour J, en production, à la même minute, Albiez d'abord :**

1. `/api/dashboard/stats?period=currentYear&mode=averagedPerNight` sur les deux sites →
   `indicators` complets, `committedRevenue`, `period.from/to/elapsedTo/asOf`, `unitsTotal` (**1** des deux côtés).
2. `diff` des clés de premier niveau des deux réponses → **vide**.
3. `/api/dashboard/fiscal?year=2026&projected=false` (Barbusse) → CA, commissions, nuits ; les
   trois égalités du tableau ci-dessus.
4. Matrice des portes inchangée : `stats | fiscal | taxe-sejour` → **401 / 403 / 200**, jeton forgé → **401**.
5. Rappel du même `/stats` une heure plus tard → **octet pour octet identique**.
6. Œil humain, **en mode app sur mobile**, les deux sites : captures côte à côte. Hors titre,
   sous-titre et couleur d'accent, **aucune différence**. Vérifier nommément : la liste de cartes
   sous `md` (aucun défilement horizontal), la mention `archive` écrite à plat, le bouton
   « Voir les N », la réserve imprimée sous « Net encaissé », la date de fenêtre dans « À date ».

---

## Après le déploiement — la fumée en production

Ordre imposé : **Albiez d'abord, vérifier, puis Barbusse.** Albiez a moins de trafic et une
surface plus réduite ; il sert de canari.

- Vitrine, toutes les locales servies, plus `robots.txt` et `sitemap.xml`
- L'API de disponibilité renvoie des données réelles
- Le keepalive rend `ok` pour **les trois** jetons — c'est la seule preuve qu'un jeton vit
- Les crons répondent 200 avec l'en-tête, 401 sans
- La matrice des portes, rejouée en ligne
- Les chiffres du dashboard, comparés aux invariants

---

## Ce que seul un œil humain peut faire

Aucun navigateur sans tête n'est installé dans ces dépôts, et c'est le trou connu du dispositif.

1. **Aller au bout d'un paiement test** sur les deux sites. Le `sandbox` de l'iframe autorise la
   redirection 3-D Secure de la banque : c'est le point le plus sensible, et le seul chemin qui
   produit du chiffre d'affaires direct.
2. **Le calendrier de dashboard** : libellés des barres, filets de vacances, barres d'événement,
   « OPTION » et « ? » chez Barbusse, bandeaux de saison chez Albiez.
3. **En rôle viewer** : ni montants, ni canaux — **mais** consignes, heure d'arrivée et remarques
   voyageur toujours présentes.
4. **Les compteurs de voyageurs** : monter les adultes doit raboter les enfants au plafond.
5. **Les boutons « Copier »** du partage voyageur, et le presse-papier.
6. **Une facture générée**, comparée à une facture d'avant.

---

## Pièges payés une fois — ne pas les repayer

| Piège | Conséquence | Parade |
|---|---|---|
| `npm install` après un déplacement de tag | réinstalle l'ancienne version | `npm install "git+https://…#vX.Y.Z"` explicitement |
| `npm link` vers le socle | casse `next build`, `tsc` passe | copier dans `node_modules/@sejour/socle/` |
| `.tsx` dans `lib/` du socle | échec au **build** seulement | entrée exacte dans `exports`, le motif `./lib/*` pointe sur `.ts` |
| `vercel env add --force` | ne dit rien si ça échoue | ne **jamais** masquer la sortie ; l'âge de `env ls` est la création, pas la mise à jour |
| Retirer une variable d'env avant de déployer | 500 en production | déployer le code qui cesse de la lire, **puis** retirer |
| `git add -A` avec une autre session active | emporte son travail en cours | `git add -u`, ou lister les chemins nommément |
| `vercel --prod` | envoie le **répertoire local**, pas le dernier commit | vérifier `git status` avant |
| `toISOString()` pour composer un jour | décale d'un jour huit mois par an | `@sejour/socle/lib/dates` |
| Une URL en `Disallow` | son `noindex` n'est jamais lu | autoriser l'exploration **et** poser `noindex` |
| Un CA « reconstitué depuis les lignes de facture » | net chez Airbnb (versement hôte), brut ailleurs — 3 884,19 € d'écart entre deux pages du même site | le brut se définit **une fois**, dans le `toBooking` ; tout le reste lit `gross` |
| Un attendu écrit en brut pour une série en net | fait lire une régression là où il n'y en a pas (−371,40 contre −302,31) | dire l'unité de chaque écart attendu |
| Un attendu « rien ne bouge » sur des agrégats fenêtrés | faux dès le lendemain (`occupation90Jours` glisse d'un jour) | séparer l'argent (invariant) des clés datées (à réconcilier à la ligne) |
| Une photo sans vérifier qu'elle lit le paramètre | 45 fichiers identiques entre conventions | les sha256 des quatre conventions doivent différer |
| Une fonction qui lit l'horloge en secret | irrejouable à date fixe, 44,58 € d'écart fantôme | `asOf?` injectable partout, `todayParis()` seulement en défaut |

---

## Mots de passe et secrets

Dans les `.env.local` respectifs, jamais dans le dépôt — les deux sont publics. Le mot de passe
admin de production d'Albiez est un `Secret` Vercel **non relisible** : il ne peut être que
remplacé, pas récupéré.
