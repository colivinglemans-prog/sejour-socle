# `lib/fiscal/` — LMNP au réel

> ## ⚠️ Exception assumée à la règle 6 du socle
>
> **Un seul consommateur aujourd'hui, exception assumée le 2026-09-11.** La règle 6 —
> « on n'extrait pas au cas où : un module qui n'a qu'un seul appelant réel reste chez son
> site » — n'est pas respectée ici, et c'est un choix, pas un oubli.
>
> Le motif : **la SCI JUARISAL est à l'IS**, et sa comptabilité est tenue sur **Indy.fr**.
> Ce module calcule un BIC LMNP au réel — `SEUIL_LMP_RECETTES`, `testLMP`,
> `computeCotisations`, les amortissements réputés différés. Rien de tout cela ne s'applique
> à une société soumise à l'impôt sur les sociétés, dont le résultat, les amortissements et
> l'imposition se déterminent autrement. Albiez ne consomme donc rien d'ici, et **on ne lui
> invente pas de configuration**.
>
> **Indy n'a pas d'API publique** — vérifié le 2026-09-11. Le seul point d'accroche
> envisageable serait l'export FEC. Rien n'est construit dans cette direction ; la question
> est notée pour ne pas être reposée.
>
> Une règle qu'on enfreint sans le dire devient une règle morte : le jour où ce module
> deviendra réellement partagé, ou le jour où l'on décidera de le redescendre chez son unique
> site, cette note doit être relue avant de trancher.

## Ce que le module fait

Le résultat BIC d'un ou plusieurs biens en location meublée non professionnelle au régime
réel, et ce qui s'en déduit : impôt sur le revenu additionnel, test de bascule LMP,
prélèvements sociaux ou cotisations, orientations et échéances déclaratives.

`BienFiscal` est **multi-biens par conception** depuis l'origine : chaque bien porte ses
charges, son amortissement annuel et son stock d'amortissements réputés différés, et les
totaux se somment. C'est ce qui a rendu le module portable sans le réécrire.

## Ce qui a changé en montant au socle

| Avant | Après | Pourquoi |
|---|---|---|
| `path.join(process.cwd(), "data", "fiscal", …)` | `loadFiscalYearConfig(year, { dir })` | Un module du socle ne peut pas supposer le répertoire de travail de l'application qui l'appelle. |
| `import { getBookingsWithArchive } from "@/lib/bookings"` | paramètre `fetchBookings` | Le socle ne connaît ni l'archive ni le client Beds24 d'un site. |
| `import { getDailyPrices } from "@/lib/beds24"` | paramètre `fetchDailyPrices`, facultatif | La projection au pricing dynamique est une option, pas une obligation. |
| « Le Mans Métropole » en dur dans une orientation | `collectivite` dans le contexte | Règle 1 : aucun module ne connaît le nom d'un lieu. |
| `Beds24Booking` depuis `@/lib/types` | `../beds24-types` | Le format de transport vit au socle depuis le Lot 2. |

Aucune formule, aucun taux, aucun seuil n'a bougé.

## Les valeurs, et d'où elles viennent

Rien ici n'est inventé. Le barème IR est celui de l'article 197 du CGI ; le plafond du
quotient familial, l'article 197-I-2 ; le seuil de 23 000 €, l'article 155-IV ; les
amortissements réputés différés, l'article 39 C. Les constantes qui bougent d'une année sur
l'autre — barème, plafond, taux de prélèvements sociaux — sont **dans les données**
(`FiscalConstantes`, `IR_BRACKETS_*`) et non dispersées dans le code, précisément pour qu'on
puisse les rapprocher de leur source une fois par an.
