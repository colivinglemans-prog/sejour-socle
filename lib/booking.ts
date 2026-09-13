import type { Channel } from "./channels";
import { daysBetween } from "./dates";

/**
 * Le type canonique du domaine : **un séjour vendu**, quelle que soit sa provenance.
 *
 * Chaque site y traduit ses deux sources — les réservations vivantes de Beds24 et son
 * historique archivé — et tout ce qui calcule (revenus, occupation, taxe, graphes) ne
 * connaît que ce type. C'est le modèle d'Albiez, et son argument tient en une phrase, écrite
 * dans son `lib/dashboard-types.ts` :
 *
 * > « nos séjours archivés n'ont ni `id` numérique, ni `propertyId`, ni `roomId`, ni nom de
 * > voyageur. Les inventer pour satisfaire un type serait fabriquer des données. »
 *
 * D'où le partage requis / optionnel ci-dessous : **est requis ce que les deux sources ont
 * toujours**, est optionnel ce qu'une source peut légitimement ignorer. Un champ optionnel
 * n'est pas un champ négligé — c'est un champ dont l'absence est une information.
 *
 * ⚠️ **Ne jamais rendre requis un champ d'identité.** Albiez ne porte pas le scope
 * `read:bookings-personal` : il ne lit ni nom, ni e-mail, ni téléphone, ni pays, et ce n'est
 * pas un manque à combler. Rendre `firstName` obligatoire pousserait ce site à réclamer un
 * scope dont il n'a pas besoin, pour satisfaire un type. C'est exactement l'inverse du but.
 */

/**
 * D'où vient la ligne.
 *
 * `"live"` : lue à l'instant dans Beds24. `"archive"` : rejouée depuis un historique figé —
 * canaux antérieurs au branchement de l'API chez Albiez, propriété supprimée du compte chez
 * Barbusse. Un séjour archivé n'est pas annotable : il n'existe plus dans Beds24.
 */
export type BookingSource = "live" | "archive";

export interface Booking {
  /**
   * Clé de dédoublonnage entre le live et l'archive, **toujours présente**.
   *
   * Sa composition est le choix du site : Albiez prend `apiReference` — le numéro de
   * confirmation du canal, seule chose que portent ses exports — avec un repli
   * `beds24-${id}` ; Barbusse prend l'`id` numérique, que son archive a conservé. C'est le
   * paramètre `key` de `createArchive`, pas un arbitrage du socle.
   */
  ref: string;

  /** Canal normalisé. Déjà passé par `normalizeChannel` : plus personne n'a à le refaire. */
  channel: Channel;

  /** Première nuit, incluse (YYYY-MM-DD). */
  arrival: string;

  /** Jour du départ, **exclu** des nuits (YYYY-MM-DD). */
  departure: string;

  /** Nuits vendues. Peut valoir 0 : une recette sans dates n'est pas une erreur. */
  nights: number;

  /**
   * Ce qui revient à l'exploitant avant prélèvement du canal — **hors taxe de séjour**.
   *
   * La taxe est collectée pour la commune, elle n'est ni un produit ni une charge : un « net
   * encaissé » qui la contiendrait serait majoré d'un argent qui ne reste pas. La séparation se
   * fait à la frontière d'entrée, dans le `toBooking` de chaque site, là où l'on sait encore
   * lire les lignes de facture (`touristTaxFromInvoiceItems`) ; **aucun calcul ne soustrait
   * rien**, ils lisent `gross`. Redéfini ainsi le 2026-09-12 — jusque-là `gross` valait
   * `price` de Beds24, taxe comprise.
   */
  gross: number;

  /** Ce qui reste après commission du canal. `gross − commission`, hors taxe de séjour. */
  net: number;

  commission: number;

  /**
   * Taxe de séjour collectée sur ce séjour, en euros. Défaut `0`.
   *
   * Absent quand la source ne permet pas de la séparer — l'archive d'Albiez n'a pas de lignes
   * de facture, seulement `brut`/`net`/`commission` — et dans ce cas `gross` la contient sans
   * qu'on puisse le dire. Posé par le `toBooking`, jamais recalculé en aval.
   */
  touristTax?: number;

  source: BookingSource;

  /**
   * Identifiant numérique Beds24 — **absent des archives d'Albiez**, et c'est la raison
   * d'être de `ref`. C'est aussi la clé d'écriture des notes : pas d'`id`, pas d'annotation.
   */
  id?: number;

  /**
   * Propriété Beds24. Sert à Barbusse pour distinguer la maison entière de la location à la
   * chambre, ce qui change le poids en room-nights. Albiez n'a qu'un bien et ne le renseigne
   * pas.
   */
  propertyId?: number;

  roomId?: number;

  /**
   * **Nombre de logements que cette ligne occupe.** Défaut `1`.
   *
   * C'est le poids de la réservation dans la seule unité de mesure du dashboard, la
   * *nuitée-logement* : nuitées vendues = Σ `nights × units`, nuitées disponibles =
   * `unitsTotal × jours écoulés`. Le `toBooking` du site le pose — il a le droit, lui, de
   * connaître ses identifiants de propriété — et le socle ne fait que le lire (règle 1).
   *
   * Chez Barbusse, une nuit de maison entière remplit 9 nuitées sur 9 ; une chambre seule en
   * remplit 1 sur 9. C'est ce qui rend l'historique à la chambre juste — un dénominateur à 1
   * afficherait 100 % d'occupation avec une chambre occupée sur neuf — **sans pénaliser
   * l'avenir**, où tout se loue en maison entière. Chez Albiez, `unitsTotal = 1` et le défaut
   * suffit : la nuitée-logement y est la nuitée, aucun chiffre ne bouge.
   *
   * Additif et non cassant : un site qui ne le renseigne pas lit `1` partout.
   */
  units?: number;

  /** Statut Beds24 brut. Le sens commercial est dans `./booking-status`. */
  status?: string;

  /**
   * Date de réservation — délai de réservation, et convention de revenu « à la réservation ».
   *
   * Toujours **comparable lexicographiquement** : soit `YYYY-MM-DD`, soit l'horodatage ISO
   * complet que renvoie Beds24. Un consommateur qui a besoin du jour tronque à 10
   * caractères ; un tri fonctionne dans les deux cas.
   */
  bookedAt?: string | null;

  /** Note interne (champ `notes` de Beds24, jamais `comments`) : la consigne de ménage. */
  notes?: string;

  /**
   * Voyageurs, adultes et enfants confondus.
   *
   * `null` et non `0` quand la source ne dit rien : zéro voyageur serait un chiffre,
   * l'absence d'information n'en est pas un. Vide sur tout l'antérieur d'Albiez — aucun
   * export de canal ne le porte — et c'est la vérité, pas un bug d'affichage.
   */
  guests?: number | null;

  numAdult?: number;
  numChild?: number;

  /**
   * Identité et coordonnées du voyageur — **le lot `read:bookings-personal`**.
   *
   * Tous optionnels, tous absents chez Albiez, qui ne porte pas ce scope. Aucun calcul du
   * socle ne doit en dépendre.
   */
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  country?: string;

  /** Remarque du voyageur — s'imprime sur les documents envoyés au client. */
  comments?: string;

  arrivalTime?: string;

  /** Présent dans les deux sources : conservé après dédoublonnage, pour pouvoir le dire. */
  alsoLive?: boolean;
}

/**
 * Nuits entre deux jours calendaires, en UTC pour que l'heure d'été ne décale rien.
 *
 * Rend `0` sur un séjour sans nuit et un nombre négatif sur des dates inversées : c'est
 * volontaire. Plafonner à 1 masquerait une donnée incohérente au lieu de la laisser voir, et
 * un appelant qui veut ce plafond l'écrit lui-même.
 */
export function nightsBetween(arrival: string, departure: string): number {
  return daysBetween(arrival, departure);
}

/**
 * Le poids d'une ligne en logements, défaut `1`.
 *
 * Écrit une fois ici plutôt que `b.units ?? 1` à chaque somme : c'est le genre de valeur par
 * défaut qu'un appelant finit par oublier, et l'oubli ne se voit pas — il divise simplement
 * l'occupation par neuf.
 */
export function unitsOf(booking: Pick<Booking, "units">): number {
  const u = booking.units;
  return typeof u === "number" && Number.isFinite(u) && u > 0 ? u : 1;
}

/** La taxe de séjour d'une ligne, défaut `0` — même raison d'exister que `unitsOf`. */
export function touristTaxOf(booking: Pick<Booking, "touristTax">): number {
  const t = booking.touristTax;
  return typeof t === "number" && Number.isFinite(t) ? t : 0;
}
