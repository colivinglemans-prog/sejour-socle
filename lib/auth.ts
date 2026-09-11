import { SignJWT, jwtVerify } from "jose";

/**
 * Authentification du dashboard : vérification pure du jeton, **sans `next/headers`**.
 *
 * Le découpage n'est pas cosmétique. Le proxy de Next tourne en runtime edge et ne peut pas
 * charger un module qui tire `next/headers` : tout ce qui touche au cookie côté serveur vit
 * donc dans `./auth-cookie`, et ce module-ci reste importable des deux côtés. C'est ce qui
 * permet à un site d'arrêter de redéfinir `COOKIE_NAME` et `getSecret()` dans chaque route.
 *
 * Modèle : un mot de passe par rôle en variable d'environnement, un JWT HS256 signé posé en
 * cookie httpOnly, aucun stockage. Le dashboard a un administrateur et quelques lecteurs.
 */

/** Nom du cookie, identique sur les deux sites — un site, un domaine, un cookie. */
export const COOKIE_NAME = "dashboard_token";

/** 90 jours. La même valeur sert d'expiration au JWT et de `maxAge` au cookie. */
export const TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

/** Forme littérale attendue par `setExpirationTime` de `jose`. */
const TOKEN_EXPIRATION = "90d";

/**
 * Configuration d'une instance d'authentification.
 *
 * `Role` est laissé générique : le socle ne connaît pas la liste des rôles d'un site, il
 * connaît la mécanique. Aujourd'hui les deux sites déclarent `"admin" | "viewer"`.
 */
export interface AuthConfig<Role extends string> {
  /** Rôle pleins pouvoirs. */
  adminRole: Role;

  /**
   * Rôle en lecture, donné par les mots de passe nommés.
   *
   * Ce n'est pas « le rôle du ménage » : chez Barbusse il pilote aussi le chauffage. C'est un
   * accès en lecture, d'où le nom `viewer` retenu des deux côtés.
   */
  restrictedRole: Role;

  /**
   * Rôle rendu quand le jeton est illisible, expiré, ou porte un `role` inconnu.
   *
   * ⚠️ **Doit être le rôle le moins puissant.** Retomber sur l'administrateur, comme le
   * faisait Barbusse, transforme un jeton invalide en passe-droit. Échouer fermé ne coûte
   * aucune reconnexion légitime : `createToken` pose toujours le claim `role`, aucun jeton
   * émis par ce code n'en est dépourvu.
   */
  fallbackRole: Role;

  /** Rôles acceptés dans le claim. Tout autre valeur retombe sur `fallbackRole`. */
  roles: readonly Role[];

  /** Variable d'environnement portant le mot de passe administrateur. */
  adminPasswordVar?: string;

  /**
   * Préfixes de variables d'environnement donnant le rôle restreint.
   *
   * **Une liste, et non une constante**, parce que les deux sites ne nomment pas leurs
   * variables pareil et qu'on ne les renomme pas de gaieté de cœur : la valeur de production
   * d'un `Secret` Vercel est illisible après coup, un renommage raté coupe l'accès sans
   * retour possible. Albiez reste donc sur `DASHBOARD_PASSWORD_MENAGE*`, Barbusse sur
   * `DASHBOARD_PASSWORD_VIEWER*`, et les deux formes sont acceptées partout.
   *
   * Chaque variable préfixée est un mot de passe distinct (`…_Sylvie`), ce qui permet de
   * révoquer une personne sans changer celui des autres.
   */
  restrictedPasswordPrefixes: readonly string[];
}

export interface Auth<Role extends string> {
  readonly cookieName: string;
  readonly adminRole: Role;
  readonly restrictedRole: Role;
  createToken(role?: Role): Promise<string>;
  verifyToken(token: string | undefined | null): Promise<boolean>;
  roleFromToken(token: string | undefined | null): Promise<Role>;
  roleForPassword(
    password: string | undefined | null,
    env?: Record<string, string | undefined>,
  ): Role | null;
}

function getSecret(): Uint8Array {
  const secret = process.env.DASHBOARD_SECRET;
  if (!secret) throw new Error("DASHBOARD_SECRET n'est pas défini");
  return new TextEncoder().encode(secret);
}

export function createAuth<Role extends string>(config: AuthConfig<Role>): Auth<Role> {
  const {
    adminRole,
    restrictedRole,
    fallbackRole,
    roles,
    adminPasswordVar = "DASHBOARD_PASSWORD",
    restrictedPasswordPrefixes,
  } = config;

  const connus = new Set<string>(roles);

  async function createToken(role: Role = adminRole): Promise<string> {
    return new SignJWT({ role })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(TOKEN_EXPIRATION)
      .sign(getSecret());
  }

  async function verifyToken(token: string | undefined | null): Promise<boolean> {
    if (!token) return false;
    try {
      await jwtVerify(token, getSecret());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Rôle porté par le jeton, ou `fallbackRole` en cas de doute.
   *
   * Les trois cas de doute retombent ensemble : jeton absent, signature invalide ou expirée,
   * claim `role` inconnu. Un rôle qu'on n'a pas su lire n'est pas un rôle.
   */
  async function roleFromToken(token: string | undefined | null): Promise<Role> {
    if (!token) return fallbackRole;
    try {
      const { payload } = await jwtVerify(token, getSecret());
      const role = payload.role;
      return typeof role === "string" && connus.has(role) ? (role as Role) : fallbackRole;
    } catch {
      return fallbackRole;
    }
  }

  /**
   * Rôle correspondant à un mot de passe présenté, ou `null` s'il n'en ouvre aucun.
   *
   * Le même `null` couvre le mot de passe vide, faux, ou celui d'une variable non définie :
   * l'appelant ne doit pas pouvoir distinguer les trois cas dans sa réponse.
   */
  function roleForPassword(
    password: string | undefined | null,
    env: Record<string, string | undefined> = process.env,
  ): Role | null {
    if (!password) return null;

    const admin = env[adminPasswordVar];
    if (admin && password === admin) return adminRole;

    const ouvre = Object.entries(env).some(
      ([cle, valeur]) =>
        !!valeur &&
        valeur === password &&
        restrictedPasswordPrefixes.some((prefixe) => cle.startsWith(prefixe)),
    );
    return ouvre ? restrictedRole : null;
  }

  return {
    cookieName: COOKIE_NAME,
    adminRole,
    restrictedRole,
    createToken,
    verifyToken,
    roleFromToken,
    roleForPassword,
  };
}
