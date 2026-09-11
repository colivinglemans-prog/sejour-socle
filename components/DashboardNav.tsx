"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Barre de navigation du dashboard : liens filtrés par rôle, tiroir mobile, déconnexion.
 *
 * Les deux sites avaient **la même structure, ligne pour ligne** — en-tête, liens de bureau,
 * bouton hamburger, tiroir translaté hors écran, blocage du défilement du corps, même test
 * d'activité, même filtre de rôle, même appel de déconnexion. Deux fois 213 lignes dont seule
 * différait la liste des liens et la rampe de gris. La liste des liens devient une **donnée**,
 * et les couleurs passent par les sept tokens sémantiques : chaque site reste peint de sa
 * couleur sans que la structure soit écrite deux fois.
 *
 * Aucun chemin de site ici : `links` et `siteLink` sont fournis par l'application. Les deux
 * seuls chemins en dur — `/api/auth/logout` et `/dashboard/login` — sont identiques des deux
 * côtés et restent surchargeables.
 */

export interface DashboardLink {
  href: string;
  label: string;
  /** Masqué au rôle restreint. */
  adminOnly: boolean;
  /** Sort du dashboard : nouvel onglet, et jamais marqué actif. */
  external?: boolean;
}

export interface DashboardNavProps {
  /** Nom du bien, en tête de barre et en tête de tiroir. Ramène à `/dashboard`. */
  title: string;
  links: DashboardLink[];
  /**
   * Lien de retour vers la vitrine — discret, toujours en dernier.
   *
   * Il porte son propre `adminOnly` parce que les deux sites en décident autrement, chacun
   * pour une raison écrite : Albiez le laisse au rôle restreint, la personne du ménage y
   * trouvant l'adresse et l'accès au logement ; Barbusse le réserve à l'administrateur.
   */
  siteLink?: DashboardLink;
  /**
   * Rôle courant. **Peut manquer au premier rendu** : il arrive d'une réponse d'API, et on
   * affiche alors la navigation complète le temps du chargement. Ce n'est pas une faille — le
   * proxy refuse déjà l'accès aux pages interdites, et les routes ne servent pas les montants
   * au rôle restreint. Ici on ne masque que des liens.
   */
  role?: string;
  /** Nom du rôle restreint. Les deux sites l'appellent `viewer` depuis le Lot 1. */
  restrictedRole?: string;
  logoutEndpoint?: string;
  loginHref?: string;
}

export default function DashboardNav({
  title,
  links,
  siteLink,
  role,
  restrictedRole = "viewer",
  logoutEndpoint = "/api/auth/logout",
  loginHref = "/dashboard/login",
}: DashboardNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  /*
   * Le tiroir se referme au clic de chaque lien, et non par un effet sur `pathname` : la
   * navigation est côté client, le composant n'est pas remonté, mais refermer depuis un
   * `useEffect` déclenche un second rendu en cascade — et le lint le refuse, à raison, la
   * fermeture étant la conséquence directe du clic.
   */

  // Sans ça, la page défile derrière le tiroir ouvert et on la retrouve ailleurs en refermant.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  async function logout() {
    await fetch(logoutEndpoint, { method: "POST" });
    // `refresh()` avant `push()` : sans lui, le rendu serveur mis en cache de la page de
    // connexion peut encore porter la session qu'on vient de fermer.
    router.refresh();
    router.push(loginHref);
  }

  const allowed = (l: DashboardLink) => !l.adminOnly || role !== restrictedRole;
  const visible = links.filter(allowed);
  const home = siteLink && allowed(siteLink) ? siteLink : null;

  const isActive = (link: DashboardLink) =>
    !link.external &&
    (link.href === "/dashboard"
      ? pathname === "/dashboard"
      : pathname === link.href || pathname.startsWith(link.href + "/"));

  const externalProps = (link: DashboardLink) => ({
    target: link.external ? "_blank" : undefined,
    rel: link.external ? "noopener noreferrer" : undefined,
  });

  return (
    <header className="border-b border-border bg-white">
      <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-6">
          {/* Le titre ramène à l'accueil du dashboard : c'est le réflexe qu'on a sur un site,
              et le seul chemin de retour depuis le calendrier sur un écran étroit. */}
          <Link href="/dashboard" className="text-lg font-bold text-primary">
            {title}
          </Link>

          <div className="hidden items-center gap-5 md:flex">
            {visible.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                {...externalProps(link)}
                className={`text-sm font-medium transition-colors ${
                  isActive(link)
                    ? "text-primary underline underline-offset-4"
                    : "text-secondary hover:text-primary"
                }`}
              >
                {link.label}
                {link.external && " ↗"}
              </Link>
            ))}
            {home && (
              <Link
                href={home.href}
                {...externalProps(home)}
                className="text-sm text-slate-400 hover:text-secondary"
              >
                {home.label}
              </Link>
            )}
          </div>
        </div>

        <button
          onClick={logout}
          className="hidden text-sm text-slate-400 transition-colors hover:text-secondary md:block"
        >
          Déconnexion
        </button>

        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Ouvrir le menu"
          aria-expanded={open}
          aria-controls="menu-dashboard"
          className="rounded-md p-2 text-secondary hover:bg-light-bg md:hidden"
        >
          <svg
            className="h-6 w-6"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </nav>

      {/* Tiroir mobile. Toujours dans le DOM et seulement translaté hors écran : monté au
          clic, il n'aurait pas d'état de départ à animer et apparaîtrait d'un coup. */}
      <div
        id="menu-dashboard"
        className={`fixed inset-0 z-50 md:hidden ${open ? "" : "pointer-events-none"}`}
      >
        <button
          type="button"
          aria-label="Fermer le menu"
          onClick={() => setOpen(false)}
          className={`absolute inset-0 bg-black/40 transition-opacity ${
            open ? "opacity-100" : "opacity-0"
          }`}
        />
        <div
          className={`absolute right-0 top-0 flex h-full w-72 max-w-[85vw] flex-col bg-white shadow-xl transition-transform ${
            open ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <span className="text-base font-bold text-primary">{title}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Fermer le menu"
              className="rounded-md p-2 text-secondary hover:bg-light-bg"
            >
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 6l12 12M6 18L18 6" />
              </svg>
            </button>
          </div>

          <ul className="flex-1 overflow-y-auto px-3 py-4">
            {visible.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  {...externalProps(link)}
                  onClick={() => setOpen(false)}
                  className={`block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    isActive(link)
                      ? "bg-light-bg text-primary"
                      : "text-slate-700 hover:bg-light-bg"
                  }`}
                >
                  {link.label}
                  {link.external && " ↗"}
                </Link>
              </li>
            ))}
            {home && (
              <li>
                <Link
                  href={home.href}
                  {...externalProps(home)}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-3 py-2.5 text-sm text-secondary hover:bg-light-bg"
                >
                  {home.label}
                </Link>
              </li>
            )}
          </ul>

          <div className="border-t border-border p-4">
            <button
              onClick={logout}
              className="w-full rounded-full border border-border px-4 py-2 text-sm font-medium text-secondary hover:bg-light-bg"
            >
              Déconnexion
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
