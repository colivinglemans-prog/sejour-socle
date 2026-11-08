import { importPKCS8, SignJWT } from "jose";

/**
 * Jeton d'accès Google pour un **compte de service**, sans la bibliothèque `googleapis`.
 *
 * Le flux est celui de la documentation « OAuth 2.0 for Server to Server Applications » : on
 * signe en RS256 une assertion JWT avec la clé privée du compte de service, et on l'échange
 * contre un jeton d'accès d'une heure. `jose` est déjà une dépendance des deux sites (cookie du
 * dashboard) ; `googleapis` pèserait plusieurs dizaines de mégaoctets pour deux requêtes.
 *
 * Le jeton est gardé en mémoire jusqu'à une minute avant son expiration, par couple
 * (compte, portées) : une instance chaude de fonction le réutilise, une instance froide en
 * redemande un — c'est sans état et sans risque.
 *
 * La clé ne doit **jamais** entrer dans un dépôt : les trois dépôts sont publics. Chaque site
 * la lit dans une variable d'environnement (`parseServiceAccount`).
 */

/** Les deux champs du fichier JSON de clé dont le flux a besoin ; les autres sont ignorés. */
export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Marge avant expiration : un jeton qui expire pendant la requête ferait un 401 incompréhensible. */
const EXPIRY_MARGIN_MS = 60_000;

const cache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Lit le JSON de clé tel que Google le télécharge, collé brut dans une variable d'environnement.
 *
 * Vercel conserve les retours à la ligne, mais un copier-coller passé par une ligne de
 * commande les transforme souvent en `\n` littéraux dans `private_key` : on les rétablit, faute
 * de quoi `importPKCS8` échoue sur une clé pourtant juste.
 */
export function parseServiceAccount(raw: string | undefined): ServiceAccountCredentials {
  if (!raw) throw new Error("Clé de compte de service Google absente.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Clé de compte de service Google illisible : le JSON est invalide.");
  }
  const { client_email, private_key } = (parsed ?? {}) as Partial<ServiceAccountCredentials>;
  if (typeof client_email !== "string" || typeof private_key !== "string") {
    throw new Error("Clé de compte de service Google incomplète : client_email ou private_key manquant.");
  }
  return { client_email, private_key: private_key.replace(/\\n/g, "\n") };
}

/** Un jeton d'accès valide pour les portées demandées. */
export async function getGoogleAccessToken(
  credentials: ServiceAccountCredentials,
  scopes: readonly string[],
): Promise<string> {
  const scope = [...scopes].sort().join(" ");
  const key = `${credentials.client_email} ${scope}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached.token;

  // Une clé mal collée échoue ici, avant tout appel à Google : le message doit le dire, sans
  // quoi l'appelant la confondrait avec une propriété refusée.
  let privateKey: CryptoKey;
  try {
    privateKey = await importPKCS8(credentials.private_key, "RS256");
  } catch {
    throw new Error("Google a refusé le jeton : la clé privée du compte de service est illisible.");
  }
  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(credentials.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Google a refusé le jeton du compte de service (${res.status}) : ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cache.set(key, { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}
