// Petites briques HTTP communes aux modules du protocole — `fetch` natif de Node 24 seulement,
// aucune dépendance. Rien ici ne journalise jamais un mot de passe, un cookie ou un secret :
// seuls des statuts, des tailles et des extraits de charge utile passent dans les rapports.

/**
 * Un appel HTTP dont on veut le statut brut — jamais suivi automatiquement. Un `fetch` qui
 * suit les redirections masquerait le 307 du proxy derrière le 200 de la page de destination,
 * et c'est justement ce 307 qui distingue un anonyme repoussé d'un administrateur reçu.
 */
export async function appeler(url, { method = "GET", cookie, body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined && h["content-type"] === undefined) h["content-type"] = "application/json";
  const reponse = await fetch(url, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const texte = await reponse.text();
  return {
    status: reponse.status,
    location: reponse.headers.get("location"),
    setCookie: typeof reponse.headers.getSetCookie === "function" ? reponse.headers.getSetCookie() : [],
    texte,
    json() {
      try {
        return JSON.parse(texte);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Connexion : rend le cookie `dashboard_token` du rôle obtenu, ou `null` avec un motif — jamais
 * une exception, pour que l'appelant puisse dire « admin non testé : … » et continuer.
 */
export async function connecter(config, motDePasse, roleAttendu) {
  if (!motDePasse) {
    return { cookie: null, role: null, motif: `mot de passe ${roleAttendu} absent de l'environnement` };
  }
  const reponse = await appeler(`${config.base}/api/auth/login`, {
    method: "POST",
    body: config.loginBody(motDePasse),
  });
  if (!config.loginOk(reponse.json())) {
    return { cookie: null, role: null, motif: `mot de passe ${roleAttendu} refusé (${reponse.status})` };
  }
  const brut = reponse.setCookie.find((c) => c.startsWith("dashboard_token="));
  if (!brut) {
    return { cookie: null, role: null, motif: "connexion acceptée mais aucun cookie dashboard_token reçu" };
  }
  const cookie = brut.split(";")[0];
  const role = config.loginRole(reponse.json());
  return { cookie, role, motif: null };
}

/** Jeton non signé `{"alg":"none"}` / `{"role":"admin"}` — doit toujours être refusé. */
export const JETON_FORGE = "dashboard_token=eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYWRtaW4ifQ.";
