/**
 * Les liens « Réserver » vers le calendrier de la page (`/fr#disponibilite`, `/fr#reserver`).
 *
 * Un `<Link>` de Next vers l'adresse **déjà affichée**, ancre comprise, ne fait rien : ni
 * navigation ni défilement. C'est le cas courant sur mobile, et surtout dans l'appli posée sur
 * l'écran d'accueil, qui garde l'adresse : après « Voir le calendrier » (page Séjour, devis,
 * Tarifs), l'adresse finit déjà par `#disponibilite`, et le gros bouton du bas restait sans effet
 * (relevé par l'hôte le 2026-11-20). Depuis un lien pré-rempli (`?arrivee=…`), le clic quittait
 * aussi la requête et perdait les dates.
 *
 * À brancher sur `onClick` : si l'ancre est sur la page affichée, on y défile (en respectant
 * `scroll-margin`) et on garde la requête ; sinon on laisse `<Link>` naviguer.
 */
export function goToAnchor(event: { preventDefault: () => void }, anchor: string): void {
  if (typeof document === "undefined") return;
  const target = document.getElementById(anchor);
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search}#${anchor}`);
}
