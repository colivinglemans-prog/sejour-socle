#!/usr/bin/env node
/**
 * Garde-fou avant commit, commun aux trois dépôts publics (Albiez, Barbusse, socle).
 *
 *   .githooks/pre-commit  →  node node_modules/@sejour/socle/scripts/garde-commit.mjs
 *
 * Né de la violation de données du 24/07/2026 : deux sauvegardes Beds24 (noms, téléphones,
 * codes de serrure) ont été commitées dans un dépôt public, faute de `.gitignore` à ce
 * moment-là. Le `.gitignore` est une barrière qu'on oublie ou qu'on contourne (`git add -f`) ;
 * ce script en est une seconde, qui s'exécute au moment où l'erreur se commet. La troisième est
 * côté GitHub (secret scanning et push protection, actifs sur les trois dépôts).
 *
 * Refus, sur le **contenu indexé** (pas la copie de travail) :
 *
 * 1. **Un fichier que le `.gitignore` exclut**, indexé quand même (`git add -f`). Le
 *    `.gitignore` reste la seule source de vérité : versionner un fichier de `data/`, c'est
 *    l'ajouter à la liste blanche du `.gitignore`, jamais modifier ce script. Un `.env` ou
 *    `.env.<x>` est refusé même s'il n'est pas ignoré (sauf `.example`, `.sample`, `.template`).
 * 2. **La valeur d'un secret du poste** dans un fichier indexé. Les fichiers d'environnement
 *    sont lus à la racine du worktree courant **et** du worktree principal (un worktree n'a pas
 *    de `.env.local`), plus ceux que `git config --get-all garde-commit.envFile` désigne (le
 *    socle y liste les `.env.local` des sites). Seules les variables au nom de secret et à la
 *    valeur qui en a l'air sont retenues (`classer`). Les codes courts (`CODE`, `PIN` : 4 chiffres
 *    ou plus) sont cherchés, bornés, dans les fichiers de données seulement.
 * 3. **Un export de réservations** dans un fichier de données (tout ce qui n'est pas du code ni du
 *    Markdown, quelle que soit l'extension : `.json.bak` compris) : clés personnelles JSON
 *    répétées, en-tête CSV/TSV personnel suivi de lignes, ou un infoItem de serrure `NUKI_PIN`
 *    suivi de sa valeur chiffrée, où qu'il soit.
 * 4. **Un secret de format connu**, même absent du poste : clé privée PEM, clé de compte de service
 *    Google, clé Stripe live, ou un vidage de variables d'environnement (`vercel env pull`).
 *
 * Le message de refus nomme le fichier et la variable, **jamais la valeur**. Un échec de git
 * refuse le commit (jamais de « rien vu, donc rien à dire »).
 *
 * Contournement : `git commit --no-verify`, réservé à l'hôte. Un agent ne s'en sert pas : il
 * corrige, ou il signale.
 *
 * Aucune dépendance, et le socle ne déclare ni `prepare` ni `postinstall` : ce script ne
 * s'exécute que parce qu'un dépôt l'appelle depuis son propre hook.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FICHIERS_ENV = [".env.local", ".env.protocole", ".env"];
export const LONGUEUR_MIN_SECRET = 8;
export const SEUIL_EXPORT = 5;
/** Au-delà, le fichier est refusé : trop gros pour être contrôlé (les dépôts n'ont rien au-dessus de 1 Mo). */
export const TAILLE_MAX = 20 * 1024 * 1024;

/** Noms de variables qui désignent un secret. `NEXT_PUBLIC_*` est public par construction. */
const NOM_SECRET = /(SECRET|TOKEN|PASSWORD|PASSWD|_PASS$|_KEY$|^KEY_|PRIVATE|TOPIC|CODE|_PIN$|HISTORIQUE|CREDENTIAL|IBAN)/i;
/** Un topic ntfy est un secret même écrit en URL publique : quiconque le connaît lit les alertes. */
const NOM_TOPIC = /TOPIC/i;
/** Un code d'accès physique, même court : boîte à clés, digicode. */
const NOM_CODE = /(CODE|_PIN$)/i;
/** Une URL qui porte un mot de passe (`rediss://user:pass@hôte`) est un secret, quel que soit le nom. */
const URL_AVEC_IDENTIFIANTS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

/** Code et documentation : ni export, ni code court cherché dedans (les nombres y abondent). */
const FICHIER_CODE = /\.(m?[jt]sx?|cjs|cts|css|scss|md|mdx|html?|svg)$/i;
const CLES_PERSONNELLES =
  /"(phone|mobile|email|firstName|lastName|address|guestFirstName|guestName|guestEmail|guestPhone|guestMobile|guestAddress)"\s*:/gi;
const COLONNES_PERSONNELLES =
  /^(phone|mobile|telephone|téléphone|email|e-mail|mail|firstname|first name|prénom|prenom|lastname|last name|nom|address|adresse|guestfirstname|guestname|guestemail|guestphone)$/i;
/** Un infoItem de serrure avec sa valeur chiffrée (la seule mention du code, sans chiffres, est de la doc). */
const CODE_SERRURE = /"code"\s*:\s*"NUKI_PIN"\s*,\s*"(?:text|value)"\s*:\s*"?\d{4,}/;
const FORMATS_CONNUS = [
  { motif: /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40,}/, nom: "clé privée PEM" },
  { motif: /"private_key"\s*:\s*"-----BEGIN/, nom: "clé de compte de service Google" },
  { motif: /\b[sr]k_live_[0-9A-Za-z]{16,}/, nom: "clé Stripe live" },
];
const LIGNE_VIDAGE_ENV = /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*["']?[^\s"'#]{8,}/gm;

/**
 * Lit un fichier dotenv avec la grammaire de `dotenv` (celle de Next) : une valeur entre
 * guillemets s'arrête au guillemet fermant et peut tenir sur plusieurs lignes ; `\n` y est
 * interprété entre guillemets doubles ; une valeur nue s'arrête au premier `#`. Quand une valeur
 * nue contient un `#`, la ligne entière est aussi rendue (`brutes`) : l'auteur la croyait
 * complète, c'est elle qu'il ne faut pas laisser fuiter.
 */
export function lireEnv(texte) {
  const vars = new Map();
  const src = texte.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const LIGNE =
    /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\n]+)?\s*(?:#.*)?$/gm;
  let m;
  while ((m = LIGNE.exec(src)) !== null) {
    let valeur = (m[2] ?? "").trim();
    const q = valeur[0];
    const entreGuillemets = (q === '"' || q === "'" || q === "`") && valeur.endsWith(q) && valeur.length >= 2;
    if (entreGuillemets) {
      valeur = valeur.slice(1, -1);
      if (q === '"') valeur = valeur.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    }
    vars.set(m[1], valeur);
  }
  return vars;
}

/** Les valeurs nues coupées par un `#` : `NOM` → ligne complète après le `=`. */
export function valeursBrutes(texte) {
  const brutes = new Map();
  for (const ligne of texte.replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*([^'"`\s].*?)\s*$/.exec(ligne);
    if (m && m[2].includes("#")) brutes.set(m[1], m[2]);
  }
  return brutes;
}

/**
 * Classe une variable : `"secret"` (cherché tel quel partout), `"code"` (code d'accès court,
 * cherché borné dans les fichiers de données) ou `null`.
 */
export function classer(nom, valeur) {
  if (nom.startsWith("NEXT_PUBLIC_") || !valeur) return null;
  if (URL_AVEC_IDENTIFIANTS.test(valeur)) return "secret";
  if (!NOM_SECRET.test(nom)) return null;
  if (NOM_CODE.test(nom) && /^\d{4,}$/.test(valeur)) return "code";
  if (valeur.length < LONGUEUR_MIN_SECRET) return null;
  if (/^(true|false|yes|no|on|off)$/i.test(valeur)) return null;
  if (/^[\d\s.,:-]+$/.test(valeur)) return null;
  if (/^https?:\/\/[^@\s]+$/i.test(valeur) && !NOM_TOPIC.test(nom)) return null;
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(valeur)) return null;
  if (/^-----BEGIN /.test(valeur) && !/-----END /.test(valeur)) return null; // en-tête seul, mal lu
  return "secret";
}

/** Compatibilité de lecture : une variable est-elle un secret au sens strict ? */
export function estSecret(nom, valeur) {
  return classer(nom, valeur) === "secret";
}

/** Secrets lus dans une liste de fichiers d'environnement (chemins absolus), noms `ignorer` exclus. */
export function secretsDesFichiers(chemins, ignorer = []) {
  const secrets = [];
  const ajouter = (nom, valeur, type, source) => {
    if (ignorer.includes(nom)) return;
    secrets.push({ nom, valeur, type, source });
    if (type === "secret" && NOM_TOPIC.test(nom)) {
      // Le topic peut aussi être écrit seul, sans l'URL du serveur.
      const segment = /\/([^/?#\s]+)\/?$/.exec(valeur)?.[1];
      if (segment && segment.length >= LONGUEUR_MIN_SECRET) secrets.push({ nom, valeur: segment, type, source });
    }
  };
  for (const chemin of chemins) {
    if (!existsSync(chemin)) continue;
    const texte = readFileSync(chemin, "utf8");
    for (const [nom, valeur] of lireEnv(texte)) {
      const type = classer(nom, valeur);
      if (type) ajouter(nom, valeur, type, chemin);
    }
    for (const [nom, brute] of valeursBrutes(texte)) {
      if (classer(nom, brute) === "secret") ajouter(nom, brute, "secret", chemin);
    }
  }
  return secrets;
}

/** Compatibilité : les secrets d'un seul dossier. */
export function secretsDuPoste(racine, fichiers = FICHIERS_ENV) {
  return secretsDesFichiers(fichiers.map((f) => join(racine, f)));
}

/** Noms des secrets dont la valeur figure dans le contenu. Les codes courts : bornés, fichiers de données seulement. */
export function secretsPresents(contenu, secrets, chemin = "") {
  const donnees = !FICHIER_CODE.test(chemin);
  const noms = secrets
    .filter((s) => {
      if (s.type === "code") return donnees && new RegExp(`(?<!\\d)${s.valeur}(?!\\d)`).test(contenu);
      return contenu.includes(s.valeur);
    })
    .map((s) => s.nom);
  return [...new Set(noms)];
}

/** Un fichier qui ressemble à un export de réservations (rend le motif, ou `null`). */
export function ressembleAExport(chemin, contenu) {
  if (CODE_SERRURE.test(contenu)) return "contient un code de serrure (infoItem NUKI_PIN avec sa valeur)";
  if (FICHIER_CODE.test(chemin)) return null;
  if ((contenu.match(CLES_PERSONNELLES) ?? []).length >= SEUIL_EXPORT) {
    return `ressemble à un export de réservations (≥ ${SEUIL_EXPORT} clés personnelles)`;
  }
  const lignes = contenu.split(/\r?\n/).filter((l) => l.trim());
  for (let i = 0; i < Math.min(lignes.length, 5); i++) {
    const sep = lignes[i].includes("\t") ? "\t" : lignes[i].includes(";") ? ";" : ",";
    const colonnes = lignes[i].split(sep).map((c) => c.trim().replace(/^["']|["']$/g, ""));
    const perso = colonnes.filter((c) => COLONNES_PERSONNELLES.test(c)).length;
    if (perso >= 2 && lignes.length - i - 1 >= SEUIL_EXPORT) {
      return `ressemble à un export de réservations (tableau à ${perso} colonnes personnelles)`;
    }
  }
  return null;
}

/** Un secret de format connu, indépendant du poste (rend son nom, ou `null`). */
export function formatConnu(chemin, contenu) {
  for (const f of FORMATS_CONNUS) if (f.motif.test(contenu)) return f.nom;
  if (!FICHIER_CODE.test(chemin) && (contenu.match(LIGNE_VIDAGE_ENV) ?? []).length >= 3) {
    return "vidage de variables d'environnement";
  }
  return null;
}

/** Un fichier d'environnement réel (`.env`, `.env.local`…), hors modèles documentés. */
export function estFichierEnv(chemin) {
  const nom = basename(chemin);
  return /^\.env(\..+)?$/.test(nom) && !/\.(example|sample|template)$/.test(nom);
}

/** Décode un contenu texte (UTF-8, ou UTF-16 avec BOM). `null` pour un binaire. */
export function decoder(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const le = Buffer.from(buffer.subarray(2));
    le.swap16();
    return le.toString("utf16le");
  }
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function git(args, options = {}) {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: TAILLE_MAX + 1024 * 1024, ...options });
  if (r.error) throw new Error(`git introuvable ou en échec (${r.error.code ?? r.error.message})`);
  return r;
}

function gitOk(args, options = {}, codesAcceptes = [0]) {
  const r = git(args, options);
  if (!codesAcceptes.includes(r.status)) {
    throw new Error(`git ${args[0]} a échoué (code ${r.status}) : ${String(r.stderr ?? "").trim().split("\n")[0]}`);
  }
  return r;
}

/** Les fichiers d'environnement à lire pour un dépôt : worktree courant, principal, et `garde-commit.envFile`. */
export function fichiersEnvDuDepot(top) {
  const dossiers = new Set([top]);
  const commun = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: top });
  if (commun.status === 0 && commun.stdout.trim()) dossiers.add(dirname(commun.stdout.trim()));
  const chemins = [...dossiers].flatMap((d) => FICHIERS_ENV.map((f) => resolve(d, f)));
  const extra = git(["config", "--get-all", "garde-commit.envFile"], { cwd: top });
  for (const f of extra.stdout?.split(/\r?\n/).filter(Boolean) ?? []) chemins.push(isAbsolute(f) ? f : resolve(top, f));
  return [...new Set(chemins)];
}

/**
 * Contrôle l'index du dépôt courant — ou, avec `depuis`, les fichiers modifiés entre cette
 * référence et `HEAD` (mode CI : une PR, un push), lus dans `HEAD`. Rend
 * `{ refus, avertissements }`, chaque refus `{ fichier, motif }`. `racine` et `secrets` sont
 * injectables pour les tests.
 */
export function controlerIndex({ racine, secrets, depuis } = {}) {
  const top = racine ?? gitOk(["rev-parse", "--show-toplevel"]).stdout.trim();
  const opts = { cwd: top };
  const avertissements = [];
  if (depuis !== undefined) {
    // Une référence commençant par « - » serait lue comme une option de git.
    if (!depuis || depuis.startsWith("-")) throw new Error(`référence --depuis invalide : « ${depuis} »`);
    gitOk(["rev-parse", "--verify", "--quiet", `${depuis}^{commit}`], opts);
  }
  // Mode index : `:fichier` ; mode CI : `HEAD:fichier`.
  const prefixe = depuis === undefined ? ":" : "HEAD:";
  const lister =
    depuis === undefined
      ? ["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"]
      : ["diff", "--name-only", "--diff-filter=ACMRT", "-z", `${depuis}...HEAD`];
  const indexes = gitOk(lister, opts)
    .stdout.split("\0")
    .filter(Boolean);
  if (indexes.length === 0) return { refus: [], avertissements };

  const refus = [];

  // check-ignore : 0 = au moins un ignoré, 1 = aucun ; tout autre code est une erreur.
  const ignores = gitOk(["check-ignore", "--no-index", "-z", "--stdin"], { ...opts, input: indexes.join("\0") }, [0, 1])
    .stdout.split("\0")
    .filter(Boolean);
  for (const f of new Set(ignores)) {
    refus.push({ fichier: f, motif: "exclu par le .gitignore (git add -f ?) : l'autoriser dans le .gitignore s'il doit être versionné" });
  }
  for (const f of indexes) {
    if (estFichierEnv(f) && !ignores.includes(f)) refus.push({ fichier: f, motif: "fichier d'environnement" });
  }

  let duPoste = secrets;
  if (!duPoste) {
    const ignorer = git(["config", "--get-all", "garde-commit.ignorer"], opts).stdout?.split(/\r?\n/).filter(Boolean) ?? [];
    // Un réglage local, permanent et invisible dans le dépôt : on le rappelle à chaque commit.
    if (ignorer.length) avertissements.push(`variables exclues par garde-commit.ignorer : ${ignorer.join(", ")}`);
    const fichiersEnv = fichiersEnvDuDepot(top);
    duPoste = secretsDesFichiers(fichiersEnv, ignorer);
    if (!fichiersEnv.some((f) => existsSync(f))) {
      avertissements.push("aucun fichier d'environnement trouvé : le contrôle des valeurs de secrets est inactif");
    } else if (duPoste.length === 0) {
      avertissements.push("aucun secret retenu dans les fichiers d'environnement : le contrôle des valeurs de secrets est inactif");
    }
  }

  for (const f of indexes) {
    const taille = git(["cat-file", "-s", `${prefixe}${f}`], opts);
    if (taille.status === 0 && Number(taille.stdout.trim()) > TAILLE_MAX) {
      refus.push({ fichier: f, motif: `plus de ${TAILLE_MAX / 1024 / 1024} Mo : trop gros pour être contrôlé` });
      continue;
    }
    const blob = git(["cat-file", "blob", `${prefixe}${f}`], { ...opts, encoding: "buffer" });
    if (blob.error || blob.status !== 0) {
      // Un lien symbolique ou un sous-module n'a pas de blob lisible ainsi : rien à lire.
      const mode = (
        depuis === undefined ? git(["ls-files", "-s", "-z", "--", f], opts) : git(["ls-tree", "-z", "HEAD", "--", f], opts)
      ).stdout.split(" ")[0];
      if (mode === "120000" || mode === "160000") continue;
      refus.push({ fichier: f, motif: "illisible dans l'index : contrôle impossible" });
      continue;
    }
    if (blob.stdout.length > TAILLE_MAX) {
      refus.push({ fichier: f, motif: `plus de ${TAILLE_MAX / 1024 / 1024} Mo : trop gros pour être contrôlé` });
      continue;
    }
    const contenu = decoder(blob.stdout);
    if (contenu === null) continue; // binaire
    for (const nom of secretsPresents(contenu, duPoste, f)) {
      refus.push({ fichier: f, motif: `contient la valeur de ${nom}` });
    }
    const exportMotif = ressembleAExport(f, contenu);
    if (exportMotif) refus.push({ fichier: f, motif: exportMotif });
    const connu = formatConnu(f, contenu);
    if (connu) refus.push({ fichier: f, motif: `contient un secret (${connu})` });
  }
  return { refus, avertissements };
}

/** Arguments : aucun (hook avant commit) ou `--depuis <réf>` (CI). */
export function lireArguments(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--depuis") return { depuis: argv[1] };
  throw new Error(`arguments inattendus : ${argv.join(" ")} (usage : [--depuis <réf>])`);
}

function main() {
  let resultat;
  try {
    resultat = controlerIndex(lireArguments(process.argv.slice(2)));
  } catch (e) {
    console.error(`\n✋ garde-commit : contrôle impossible, commit refusé — ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  for (const a of resultat.avertissements) console.error(`⚠ garde-commit : ${a}`);
  if (resultat.refus.length === 0) return 0;
  console.error("\n✋ garde-commit : commit refusé, ce dépôt est PUBLIC.\n");
  for (const r of resultat.refus) console.error(`  • ${r.fichier} — ${r.motif}`);
  console.error(
    "\nRetirer le fichier de l'index (git restore --staged <fichier>) ou en ôter le secret.\n" +
      "Un faux positif se signale à l'hôte : c'est lui qui décide de l'exception.\n",
  );
  return 1;
}

/** Exécuté directement, y compris à travers un lien ou une jonction (`npm link`, `file:`). */
function estPointDEntree() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (estPointDEntree()) process.exitCode = main();
