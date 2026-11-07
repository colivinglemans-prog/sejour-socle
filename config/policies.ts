/**
 * Formes des politiques commerciales affichées au voyageur. **Les valeurs restent chez chaque
 * site** (Barbusse : `lib/property-info.ts`, Albiez : `lib/property.ts`) ; le socle ne porte que
 * la forme, pour que l'affichage et le contrôle de cohérence lisent la même source.
 *
 * Les phrases ne vivent pas ici : elles restent dans les dictionnaires de chaque site. Le contrôle
 * cherche les **nombres** de la politique dans les textes publiés, et l'absence des formulations
 * périmées déclarées par le site.
 */

export interface CancellationTier {
  /** Annulation au moins N jours avant l'arrivée. */
  minDaysBefore: number;
  refundPct: number;
}

export interface CancellationPolicy {
  /** Nom de la politique de plateforme dont celle-ci est l'alignement (ex. `ferme`, `limitee`). */
  name: string;
  /** Du plus favorable au moins favorable. */
  tiers: CancellationTier[];
  /** Délai de grâce après réservation (Airbnb Ferme : 48 h, si l'arrivée est à J-14 ou plus). */
  gracePeriod?: { hoursAfterBooking: number; minDaysBefore: number; refundPct: number };
  /** La même règle s'applique-t-elle sur les plateformes (Airbnb…) qu'en direct ? Dit aux IA. */
  sameOnAllChannels?: boolean;
}

export interface PaymentPolicy {
  direct: {
    upfrontPct: number;
    via: string;
    touristTaxIncluded: boolean;
  };
  business?: {
    depositPct: number;
    via: string;
    /** Quand se règle le solde, dit tel quel aux IA (« before arrival »). */
    balanceDue?: string;
  };
}
