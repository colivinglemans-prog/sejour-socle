import { NextResponse, type NextRequest } from "next/server";
import type { Auth } from "./auth";
import { COOKIE_NAME } from "./auth";

/**
 * Proxy de Next 16 : la première des trois portes du dashboard.
 *
 * Next n'accepte qu'un proxy par projet, si bien que ce fichier porte des responsabilités
 * sans rapport entre elles — négociation de langue, redirections d'anciennes URLs,
 * authentification. Elles sont ici des **données** de configuration, pas des branches
 * codées en dur : un site qui n'a pas de redirection d'URL n'en déclare pas.
 *
 * Le modèle vient d'Albiez. Le point important est le helper `refuser` unique : une route
 * d'API répond par un statut, une page par une redirection. Un client JSON qui reçoit un 307
 * vers du HTML tente de le parser et échoue de façon illisible ; une page qui reçoit un 401
 * nu laisse un écran blanc. Barbusse répétait le test six fois en ligne et perdait au passage
 * la destination demandée.
 *
 * ⚠️ Ce module tourne en **runtime edge** : il n'importe que `./auth` (vérification JWT
 * pure), jamais `./auth-cookie`, qui tire `next/headers`.
 */

/** Négociation de langue sur un chemin exact — la racine du site, en pratique. */
export interface LocaleRedirect {
  /** Chemin exact déclenchant la négociation. */
  path: string;
  /** Locale à servir pour cet en-tête `Accept-Language`. */
  negotiate: (acceptLanguage: string | null) => string;
}

/** Ancienne URL à faire suivre vers sa remplaçante. */
export interface LegacyRedirect {
  /** Testée sur le `pathname` seul, sans la query. */
  from: RegExp;
  /** Destination ; `$1`…`$9` reprennent les groupes capturants de `from`. */
  to: string;
  /** 301 par défaut : ces URLs ont disparu pour de bon, et le référencement doit suivre. */
  status?: number;
}

export interface DashboardProxyConfig<Role extends string> {
  /** Instance d'authentification du site — c'est elle qui porte la liste des rôles. */
  auth: Auth<Role>;

  /** Rôle en lecture, celui dont on borne les chemins. */
  restrictedRole: Role;

  /**
   * Chemins ouverts au rôle restreint. Un chemin de la liste autorise lui-même et tout ce
   * qui le prolonge (`/api/dashboard/heating` couvre `/api/dashboard/heating/mode`).
   */
  allowedPaths: readonly string[];

  /** Préfixes exigeant un cookie valide. */
  protectedPaths: readonly string[];

  /** Laissés publics à l'intérieur des précédents — la page de connexion, sinon la redirection boucle. */
  publicPaths?: readonly string[];

  /** Page de connexion, destination d'un visiteur non authentifié. */
  loginPath: string;

  /** Où renvoyer un rôle restreint qui frappe une page qui ne lui est pas ouverte. */
  restrictedHome: string;

  localeRedirect?: LocaleRedirect;
  legacyRedirects?: readonly LegacyRedirect[];
}

/** `/x` couvre `/x` et `/x/quelque-chose`, mais pas `/xy`. */
function couvre(pathname: string, prefixe: string): boolean {
  return pathname === prefixe || pathname.startsWith(`${prefixe}/`);
}

export function createDashboardProxy<Role extends string>(
  config: DashboardProxyConfig<Role>,
): (request: NextRequest) => Promise<NextResponse> {
  const {
    auth,
    restrictedRole,
    allowedPaths,
    protectedPaths,
    publicPaths = [],
    loginPath,
    restrictedHome,
    localeRedirect,
    legacyRedirects = [],
  } = config;

  return async function proxy(request: NextRequest): Promise<NextResponse> {
    const { pathname, search } = request.nextUrl;

    if (localeRedirect && pathname === localeRedirect.path) {
      const locale = localeRedirect.negotiate(request.headers.get("accept-language"));
      const url = request.nextUrl.clone();
      url.pathname = `/${locale}`;
      // 307 et non 308 : la destination dépend de l'en-tête du visiteur, la mettre en cache
      // côté navigateur figerait la langue du premier passage.
      return NextResponse.redirect(url, 307);
    }

    for (const legacy of legacyRedirects) {
      const m = pathname.match(legacy.from);
      if (!m) continue;
      const url = request.nextUrl.clone();
      url.pathname = pathname.replace(legacy.from, legacy.to);
      url.search = search;
      return NextResponse.redirect(url, legacy.status ?? 301);
    }

    const protege = protectedPaths.some((p) => couvre(pathname, p));
    if (!protege) return NextResponse.next();
    if (publicPaths.some((p) => couvre(pathname, p))) return NextResponse.next();

    const estApi = pathname.startsWith("/api/");

    /**
     * Un seul point de refus, qui décide de la forme de la réponse d'après le chemin.
     * `?retour=` conserve la destination demandée : sans elle, la connexion ramène toujours
     * à la même page et le lien qu'on avait suivi est perdu.
     */
    const refuser = (statut: number, message: string, code: string): NextResponse => {
      // Les deux clés : `erreur` pour les clients d'Albiez, `error` pour ceux de Barbusse.
      // Les deux vocabulaires existent déjà côté application, aucun n'a de raison de gagner.
      if (estApi) return NextResponse.json({ erreur: message, error: code }, { status: statut });
      const url = request.nextUrl.clone();
      url.pathname = loginPath;
      url.search = "";
      url.searchParams.set("retour", pathname);
      return NextResponse.redirect(url);
    };

    const token = request.cookies.get(COOKIE_NAME)?.value;
    if (!(await auth.verifyToken(token))) return refuser(401, "Authentification requise", "Unauthorized");

    /**
     * Le contrôle de rôle vit ici **et** dans les routes qui portent une donnée sensible.
     * Le proxy est une commodité — il évite de répéter le test sur des dizaines de chemins —
     * mais il ne doit pas être le seul rempart : un matcher oublié rouvre tout d'un coup.
     */
    if ((await auth.roleFromToken(token)) === restrictedRole) {
      const autorise = allowedPaths.some((p) => couvre(pathname, p));
      if (!autorise) {
        if (estApi) {
          return NextResponse.json(
            { erreur: "Réservé à l'administrateur", error: "Forbidden" },
            { status: 403 },
          );
        }
        const url = request.nextUrl.clone();
        url.pathname = restrictedHome;
        url.search = "";
        return NextResponse.redirect(url);
      }
    }

    return NextResponse.next();
  };
}
