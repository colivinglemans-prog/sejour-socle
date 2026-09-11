import data from "../data/vacances-scolaires.json";

/**
 * Vacances scolaires françaises par zone, plus les semaines de Noël et du Jour de l'An :
 * les périodes de forte demande, communes à toute location saisonnière en France.
 *
 * Deux partis pris, qui distinguent ce module d'un simple calendrier d'événements :
 *
 *   - **Aucune extension de dates.** Un calendrier d'événements élargit ses bornes de
 *     quelques jours pour rattraper le client arrivé la veille. Une période de vacances a
 *     des bornes exactes : l'élargir étiquetterait à tort les séjours voisins.
 *   - **Un séjour peut relever de plusieurs périodes.** En février les trois zones se
 *     chevauchent largement. On renvoie donc une liste là où un calendrier d'événements
 *     renvoie un nom.
 *
 * La liste est générée par `scripts/build-vacances.mjs` depuis l'open data du ministère.
 * Ne pas l'éditer à la main : les dates changent chaque année.
 *
 * `findPeriodesForStay` et `periodeLabel` n'ont aujourd'hui qu'un seul appelant : elles font
 * partie du même mécanisme que le reste du module et se déplacent avec lui.
 *
 * Le français des identifiants est délibéré : le domaine est réglementaire.
 */
export interface Periode {
  nom: string;
  /** « Zone A » / « Zone B » / « Zone C », ou « Toutes » pour les semaines de fêtes. */
  zone: string;
  /** Première journée de vacances, incluse (YYYY-MM-DD). */
  debut: string;
  /** Dernière journée de vacances, incluse (YYYY-MM-DD). */
  fin: string;
  type: "vacances" | "fete";
  anneeScolaire?: string;
  /** Le ministère n'a publié que la date de début : la borne de fin ne veut rien dire. */
  finNonPubliee?: boolean;
}

export const PERIODES: Periode[] = data.periodes as Periode[];

/** Ordre d'affichage : une semaine de fêtes prime sur des vacances qui l'englobent. */
const POIDS: Record<string, number> = {
  "Semaine du Jour de l'An": 100,
  "Semaine de Noël": 90,
};

function addDays(jour: string, n: number): string {
  const d = new Date(`${jour}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Nombre de nuits du séjour [arrivee, depart[ tombant dans la période [debut, fin].
 * Sert à classer les périodes : celle qui couvre le plus de nuits passe en tête.
 */
function nuitsCommunes(arrivee: string, depart: string, debut: string, fin: string): number {
  const debutCommun = arrivee > debut ? arrivee : debut;
  const finExclue = addDays(fin, 1);
  const finCommune = depart < finExclue ? depart : finExclue;
  const jours = Math.round(
    (Date.parse(`${finCommune}T00:00:00Z`) - Date.parse(`${debutCommun}T00:00:00Z`)) / 86_400_000,
  );
  return Math.max(0, jours);
}

/**
 * Toutes les périodes qu'un séjour [arrivee, depart[ recoupe, les plus significatives
 * d'abord — d'abord le poids (fêtes en tête), puis le nombre de nuits en commun.
 */
export function findPeriodesForStay(arrivee: string, depart: string): Periode[] {
  return PERIODES.map((p) => ({ p, nuits: nuitsCommunes(arrivee, depart, p.debut, p.fin) }))
    .filter(({ nuits }) => nuits > 0)
    .sort(
      (a, b) =>
        (POIDS[b.p.nom] ?? 0) - (POIDS[a.p.nom] ?? 0) ||
        b.nuits - a.nuits ||
        a.p.zone.localeCompare(b.p.zone),
    )
    .map(({ p }) => p);
}

/** Les périodes qui contiennent un jour donné, mêmes règles de tri. */
export function findPeriodesOnDay(jour: string): Periode[] {
  return findPeriodesForStay(jour, addDays(jour, 1));
}

/** « Vacances d'Hiver » → « Hiver ». Pour les affichages compacts (calendrier, badges). */
export function shortPeriodeLabel(nom: string): string {
  if (/jour de l'an/i.test(nom)) return "Jour de l'An";
  if (/no[eë]l/i.test(nom)) return "Noël";
  if (/toussaint/i.test(nom)) return "Toussaint";
  if (/hiver/i.test(nom)) return "Hiver";
  if (/printemps/i.test(nom)) return "Printemps";
  if (/ascension/i.test(nom)) return "Ascension";
  if (/été/i.test(nom)) return "Été";
  return nom;
}

/**
 * Étiquette unique pour un séjour : le nom de la période dominante, suivi des lettres de
 * zones concernées par cette même période. « Vacances d'Hiver A+C », « Noël ».
 *
 * Les zones sont regroupées parce qu'afficher trois badges identiques à la lettre près
 * n'apprend rien : ce qui compte est *combien* de zones sont en vacances, donc la pression
 * sur la demande.
 */
export function periodeLabel(arrivee: string, depart: string): string | null {
  const trouvees = findPeriodesForStay(arrivee, depart);
  if (trouvees.length === 0) return null;

  const dominante = trouvees[0];
  const court = shortPeriodeLabel(dominante.nom);
  if (dominante.type === "fete") return court;

  const zones = trouvees
    .filter((p) => p.nom === dominante.nom)
    .map((p) => p.zone.replace(/^Zone\s+/, ""))
    .filter((z) => z !== "Toutes")
    .sort();

  return zones.length > 0 ? `${court} ${zones.join("+")}` : court;
}

/**
 * Une bande de calendrier : **un seul libellé** pour une plage de jours homogène.
 *
 * Le calendrier peignait une barre par ligne de données, soit quatre barres empilées la
 * semaine de Noël (« Noël », « Noël A », « Noël B », « Noël C ») pour une seule information :
 * tout le monde est en vacances. On ne garde donc qu'**une bande à la fois**, découpée aux
 * jours où la composition change — c'est justement ce qui est intéressant, puisque le nombre
 * de zones en vacances est la mesure de la pression sur la demande :
 *
 *   « Hiver A » → « Hiver A+B » → « Hiver A+B+C » → « Hiver B+C » → « Hiver C »
 */
export interface BandePeriode {
  /** « Noël A+B+C », « Hiver A+C », « Jour de l'An A+B+C ». */
  libelle: string;
  /** Type de la période dominante du segment : c'est lui qui donne la couleur. */
  type: "vacances" | "fete";
  /**
   * Lettres des zones qui composent le libellé — « A », « B », « C ».
   *
   * À ne pas confondre avec `sources`, qui peut contenir une zone **absente** du libellé :
   * celle qui sortait au week-end de bascule absorbé (voir `fusionnerBascules`). Pour savoir
   * si une zone donnée est en vacances sur la bande telle qu'elle s'affiche, c'est cette
   * liste qu'il faut lire, jamais `sources`.
   */
  zones: string[];
  /** Premier jour du segment, inclus (YYYY-MM-DD). */
  debut: string;
  /** Dernier jour du segment, inclus (YYYY-MM-DD). */
  fin: string;
  /**
   * La composition commence bien ce jour-là, elle ne vient pas du mois précédent.
   *
   * Le calendrier en a besoin pour choisir entre une bascule en demi-journée et une bande
   * coupée au bord du mois. Pas d'équivalent pour la fin, et ce n'est pas un oubli : la
   * bande s'arrête à la moitié du **lendemain** du dernier jour, et ce jour de transition
   * sort de la fenêtre exactement quand la bande touche son bord droit.
   */
  debutReel: boolean;
  /**
   * Les périodes actives sur le segment, pour l'infobulle — plus, le cas échéant, la zone
   * sortante d'un week-end de bascule absorbé (voir `fusionnerBascules`). Le libellé
   * simplifie, l'infobulle continue de dire toute la vérité.
   */
  sources: Periode[];
}

/** Une bande avant que la fenêtre ne soit rognée : `debutReel` n'a pas encore de sens. */
type BandeBrute = Omit<BandePeriode, "debutReel">;

/** Sur-ensemble strict, par identité : les `sources` sont les objets de la liste d'entrée. */
function estSurEnsembleStrict(grand: Periode[], petit: Periode[]): boolean {
  return grand.length > petit.length && petit.every((p) => grand.includes(p));
}

/**
 * Le dernier week-end d'une zone est le premier week-end de la suivante.
 *
 * Les vacances nationales durent seize jours, du samedi au dimanche, et les zones démarrent
 * de sept en sept : deux zones qui se relaient se chevauchent donc **toujours** exactement
 * deux jours. Ce chevauchement n'est pas une information. Il ne dit pas que trois zones
 * partent ensemble, il dit que l'une rentre quand l'autre part — et il produisait une bande
 * de deux jours coincée entre les deux vraies : « PRINTEMPS A+B+C » les 17-18 avril 2027,
 * entre « A+C » et « A+B ».
 *
 * On la donne donc à la bande suivante, qui démarre au jour de bascule. Avec les
 * demi-cellules du calendrier, « A+C » s'arrête à la moitié du samedi et « A+B » repart de
 * l'autre moitié : la convention des séjours qui se relaient le même jour.
 *
 * Le test est étroit à dessein — au plus deux jours, deux voisines contiguës de même type,
 * et une composition sur-ensemble **strict** des deux. Un « ASCENSION A+B+C » d'un seul jour
 * n'a pas de voisine contiguë et n'est pas un sur-ensemble : il survit, comme il le doit.
 */
function fusionnerBascules(bandes: BandeBrute[]): BandeBrute[] {
  const restantes = [...bandes];
  const sortie: BandeBrute[] = [];

  for (let i = 0; i < restantes.length; i++) {
    const b = restantes[i];
    const precedente = sortie[sortie.length - 1];
    const suivante = restantes[i + 1];

    const bascule =
      precedente != null &&
      suivante != null &&
      precedente.fin === addDays(b.debut, -1) &&
      suivante.debut === addDays(b.fin, 1) &&
      suivante.type === b.type &&
      b.fin <= addDays(b.debut, 1) &&
      estSurEnsembleStrict(b.sources, precedente.sources) &&
      estSurEnsembleStrict(b.sources, suivante.sources);

    if (bascule) {
      restantes[i + 1] = {
        ...suivante,
        debut: b.debut,
        sources: [...b.sources, ...suivante.sources.filter((p) => !b.sources.includes(p))],
      };
      continue;
    }

    sortie.push(b);
  }

  return sortie;
}

/**
 * Libellé d'un jour : nom de la période dominante (fête d'abord) suivi des lettres de zones
 * en vacances ce jour-là. La semaine du Jour de l'An tombant en plein dans les vacances de
 * Noël, elle hérite de ses zones — ce sont bien elles qui sont en congés.
 */
function libelleDuJour(
  actives: Periode[],
): { libelle: string; type: "vacances" | "fete"; zones: string[] } {
  const dominante = [...actives].sort(
    (a, b) => (POIDS[b.nom] ?? 0) - (POIDS[a.nom] ?? 0) || a.zone.localeCompare(b.zone),
  )[0];

  const vacances = actives.filter((p) => p.type === "vacances");
  const nom = vacances.length > 0 ? vacances[0].nom : null;
  const zones = vacances
    .filter((p) => p.nom === nom)
    .map((p) => p.zone.replace(/^Zone\s+/, ""))
    .filter((z) => z !== "Toutes")
    .sort();

  const court = shortPeriodeLabel(dominante.nom);
  return {
    libelle: zones.length > 0 ? `${court} ${zones.join("+")}` : court,
    type: dominante.type,
    zones,
  };
}

/**
 * Découpe [premier, dernier] en bandes homogènes : un jour sans période n'en produit aucune,
 * et deux jours consécutifs de même libellé n'en produisent qu'une. Les bornes sont donc déjà
 * ramenées à la fenêtre demandée, l'appelant n'a rien à rogner.
 *
 * Le balayage commence **la veille** de la fenêtre. C'est le seul moyen de distinguer une
 * bande qui commence vraiment le 1er du mois d'une bande qui continue depuis le mois
 * précédent — distinction dont le calendrier a besoin, et qu'un test sur les seules dates
 * des périodes sources rate quand la composition change parce qu'une zone *sort*.
 */
export function bandesPeriodes(
  periodes: Periode[],
  premier: string,
  dernier: string,
): BandePeriode[] {
  const bandes: BandeBrute[] = [];

  for (let jour = addDays(premier, -1); jour <= dernier; jour = addDays(jour, 1)) {
    const actives = periodes.filter((p) => p.debut <= jour && p.fin >= jour);
    if (actives.length === 0) {
      continue;
    }

    const { libelle, type, zones } = libelleDuJour(actives);
    const courante = bandes[bandes.length - 1];
    if (courante && courante.libelle === libelle && courante.fin === addDays(jour, -1)) {
      courante.fin = jour;
      for (const p of actives) {
        if (!courante.sources.includes(p)) {
          courante.sources.push(p);
        }
      }
      continue;
    }

    bandes.push({ libelle, type, zones, debut: jour, fin: jour, sources: [...actives] });
  }

  // Les bascules se fusionnent avant le rognage : une bascule posée sur le 1er du mois doit
  // pouvoir voir la bande de la veille pour être reconnue.
  return fusionnerBascules(bandes)
    .filter((b) => b.fin >= premier)
    .map((b) => ({
      ...b,
      debut: b.debut < premier ? premier : b.debut,
      debutReel: b.debut >= premier,
    }));
}
