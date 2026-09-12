# Protocole de test

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
    curl -s -b cookie.txt "$BASE/api/dashboard/stats?period=$per&revenueMode=$mode" \
      -o "avant-$per-$mode.json"
  done
done
```

Côté Albiez, l'équivalent est `?periode=annee|precedente|12m|toute` × `?mode=reparti|arrivee|depart|reservation`,
plus `/api/dashboard/calendrier?mois=YYYY-MM`.

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
| Barbusse, CA `fiscal` | `77246.92`, 55 réservations, 44 % |
| Albiez, net / brut / commissions / nuits | `37514.05` / `43938.37` / `6424.32` / 525 |
| Fuite viewer (voir ci-dessous) | 50 réservations, 15 clés, **0** `NUKI_PIN`, **14 813 octets** |

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
| `/dashboard` | 307 | 200 | 200 |
| `/api/dashboard/bookings` | 401 | 200 réduit | 200 complet |
| `/api/dashboard/stats` | 401 | **403** | 200 |
| `/api/dashboard/fiscal`, `taxe-sejour`, `invoices/prefill` | 401 | **403** | 200 |
| `/api/dashboard/heating` (Barbusse) | 401 | **200** — voulu | 200 |
| `/api/dashboard/code-acces` (Albiez) | 401 | **403** | 200 |
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

---

## Mots de passe et secrets

Dans les `.env.local` respectifs, jamais dans le dépôt — les deux sont publics. Le mot de passe
admin de production d'Albiez est un `Secret` Vercel **non relisible** : il ne peut être que
remplacé, pas récupéré.
