/**
 * `scripts/garde-commit.mjs` — le garde-fou avant commit des trois dépôts publics.
 *
 * Trois couches : les fonctions pures (grammaire dotenv, tri secret / code / rien, exports,
 * formats connus), puis `controlerIndex` sur un vrai dépôt git jetable — tout le mécanisme
 * repose sur ce que git rapporte de l'index —, enfin le hook lui-même, déclenché par un vrai
 * `git commit` (y compris `commit -a`, qui passe par un index temporaire). Données inventées.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classer,
  controlerIndex,
  decoder,
  estFichierEnv,
  formatConnu,
  lireArguments,
  lireEnv,
  ressembleAExport,
  secretsDesFichiers,
  secretsPresents,
  valeursBrutes,
} from "../scripts/garde-commit.mjs";

const SCRIPT = resolve(__dirname, "../scripts/garde-commit.mjs");

describe("lireEnv — grammaire de dotenv", () => {
  it("lit les affectations, retire les guillemets, ignore commentaires et export", () => {
    const vars = lireEnv(["# commentaire", "A=1", 'export B="deux mots"', "C='x=y'", "", "pas une ligne", "D="].join("\r\n"));
    expect([...vars]).toEqual([["A", "1"], ["B", "deux mots"], ["C", "x=y"], ["D", ""]]);
  });
  it("arrête une valeur entre guillemets au guillemet fermant, commentaire de fin compris", () => {
    expect(lireEnv('IBAN="FR76 0000 0000 0000" # compte pro').get("IBAN")).toBe("FR76 0000 0000 0000");
  });
  it("arrête une valeur nue au #, comme Next", () => {
    expect(lireEnv("SMTP_PASS=abc#def").get("SMTP_PASS")).toBe("abc");
  });
  it("interprète \\n entre guillemets doubles et lit une valeur sur plusieurs lignes", () => {
    expect(lireEnv('A="ligne1\\nligne2"').get("A")).toBe("ligne1\nligne2");
    expect(lireEnv('K="-----BEGIN X-----\nAAAA\n-----END X-----"\nB=2').get("K")).toBe("-----BEGIN X-----\nAAAA\n-----END X-----");
  });
  it("valeursBrutes rend la ligne entière d'une valeur nue coupée par un #", () => {
    expect([...valeursBrutes("SMTP_PASS=abc#defghij\nA=sans\nB=\"x#y\"")]).toEqual([["SMTP_PASS", "abc#defghij"]]);
  });
});

describe("classer", () => {
  it.each([
    ["DASHBOARD_PASSWORD", "aB3dE6gH9jK2mN5p"],
    ["BEDS24_REFRESH_TOKEN", "eyJhbGciOiJIUzI1NiJ9.zzzzzzzz"],
    ["CRON_SECRET", "0123456789abcdef0123456789abcdef"],
    ["CAMERA_PASSWORD", "Motdepas10"],
    ["NTFY_TOPIC", "https://ntfy.exemple/alertes-x7k2m9q4"],
    ["INVOICE_IBAN", "FR76 3000 6000 0112 3456 7890 189"],
    ["REDIS_URL", "rediss://default:s3cr3tvalue@cache.exemple:6379"],
  ])("%s est un secret", (nom, valeur) => {
    expect(classer(nom, valeur)).toBe("secret");
  });

  it.each([
    ["CODE_BOITE_A_CLES", "4821"],
    ["DIGICODE", "190375"],
    ["PORTE_PIN", "246810"],
  ])("%s est un code court", (nom, valeur) => {
    expect(classer(nom, valeur)).toBe("code");
  });

  it.each([
    ["SITE_URL", "https://www.exemple.fr", "nom banal"],
    ["KV_REST_API_URL", "https://cache-12345.exemple.io", "URL sans identifiants"],
    ["SMTP_PASS", "court", "trop court"],
    ["FEATURE_TOKEN_ENABLED", "true", "booléen"],
    ["API_KEY", "1234567890", "nombre"],
    ["SECRET_CONTACT", "contact@exemple.fr", "adresse e-mail"],
    ["NEXT_PUBLIC_API_KEY", "abcdefghijklmnop", "public par construction"],
    ["BASE_URL_TOKEN", "https://exemple.org/chemin", "URL publique"],
    ["PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----", "en-tête PEM seul"],
    ["CODE_PAYS", "FR", "code non numérique et court"],
  ])("%s=%s n'est rien (%s)", (nom, valeur) => {
    expect(classer(nom, valeur)).toBe(null);
  });
});

describe("secretsPresents", () => {
  const secrets = [
    { nom: "A", valeur: "valeur-secrete-1", type: "secret" },
    { nom: "B", valeur: "valeur-secrete-2", type: "secret" },
    { nom: "A", valeur: "segment-de-a", type: "secret" },
    { nom: "CODE_BOITE", valeur: "4821", type: "code" },
  ];
  it("nomme les variables dont la valeur figure, une seule fois chacune", () => {
    expect(secretsPresents("x valeur-secrete-1 y segment-de-a", secrets, "a.ts")).toEqual(["A"]);
    expect(secretsPresents("rien", secrets, "a.ts")).toEqual([]);
  });
  it("cherche un code court borné, et seulement dans les fichiers de données", () => {
    expect(secretsPresents('{"boite":"4821"}', secrets, "notes.json")).toEqual(["CODE_BOITE"]);
    expect(secretsPresents('{"prix":"48210"}', secrets, "notes.json")).toEqual([]);
    expect(secretsPresents("const annee = 4821;", secrets, "lib/x.ts")).toEqual([]);
    expect(secretsPresents("4821", secrets, "docs/x.md")).toEqual([]);
  });
});

describe("secretsDesFichiers", () => {
  let dossier: string;
  beforeEach(() => (dossier = mkdtempSync(join(tmpdir(), "garde-env-"))));
  afterEach(() => rmSync(dossier, { recursive: true, force: true }));

  it("lit plusieurs fichiers, retient le segment d'un topic, exclut les noms ignorés", () => {
    writeFileSync(join(dossier, ".env.local"), "NTFY_TOPIC=https://ntfy.exemple/alertes-x7k2m9q4\nINDEXNOW_KEY=abcdef0123456789\n");
    writeFileSync(join(dossier, ".env.protocole"), 'CRON_SECRET="0123456789abcdef" # protocole\n');
    const s = secretsDesFichiers([join(dossier, ".env.local"), join(dossier, ".env.protocole"), join(dossier, "absent")], ["INDEXNOW_KEY"]);
    expect(s.map((x) => [x.nom, x.valeur])).toEqual([
      ["NTFY_TOPIC", "https://ntfy.exemple/alertes-x7k2m9q4"],
      ["NTFY_TOPIC", "alertes-x7k2m9q4"],
      ["CRON_SECRET", "0123456789abcdef"],
    ]);
  });

  it("retient aussi la valeur entière d'un mot de passe coupé par un #", () => {
    writeFileSync(join(dossier, ".env.local"), "SMTP_PASS=abc#defghijk\n");
    expect(secretsDesFichiers([join(dossier, ".env.local")]).map((x) => x.valeur)).toEqual(["abc#defghijk"]);
  });
});

describe("ressembleAExport", () => {
  const ligne = (i: number) => `{"firstName":"P${i}","phone":"+3360000000${i}"}`;
  it("repère un JSON aux clés personnelles répétées, quelle que soit l'extension", () => {
    const json = `[${[1, 2, 3].map(ligne).join(",")}]`;
    expect(ressembleAExport("data/x.json", json)).toMatch(/export/);
    expect(ressembleAExport("sauvegarde.json.bak", json)).toMatch(/export/);
  });
  it("repère les clés Beds24 v1", () => {
    const v1 = [1, 2, 3].map((i) => `{"guestFirstName":"P${i}","guestEmail":"p${i}@exemple.fr"}`).join(",");
    expect(ressembleAExport("vieux.json", `[${v1}]`)).toMatch(/export/);
  });
  it("repère un CSV ou un TSV à en-tête personnel", () => {
    const csv = ["id;prénom;nom;téléphone", ...[1, 2, 3, 4, 5].map((i) => `${i};P${i};N${i};+336000000${i}`)].join("\n");
    expect(ressembleAExport("export.csv", csv)).toMatch(/colonnes personnelles/);
    const tsv = ["firstName\tlastName\temail", ...[1, 2, 3, 4, 5].map((i) => `P${i}\tN${i}\tp${i}@exemple.fr`)].join("\n");
    expect(ressembleAExport("export.tsv", tsv)).toMatch(/colonnes personnelles/);
  });
  it("repère un code de serrure, même dans du code", () => {
    expect(ressembleAExport("lib/x.ts", '[{"code": "NUKI' + '_PIN", "value": "123456"}]')).toMatch(/serrure/);
  });
  it("laisse passer un fichier de données sobre, un CSV trop court, et le code", () => {
    expect(ressembleAExport("data/reviews.json", `[${ligne(1)},{"email":"a@exemple.fr"}]`)).toBe(null);
    expect(ressembleAExport("x.csv", "prénom,nom\nA,B")).toBe(null);
    expect(ressembleAExport("lib/x.ts", `[${[1, 2, 3].map(ligne).join(",")}]`)).toBe(null);
    expect(ressembleAExport("CLAUDE.md", "le code NUKI_PIN du registre")).toBe(null);
    expect(ressembleAExport("lib/x.ts", '// motif : "code":"NUKI' + '_PIN", sans valeur')).toBe(null);
    expect(ressembleAExport("x.json", '{"code":"NUKI' + '_PIN","text":"482193"}')).toMatch(/serrure/);
  });
});

describe("formatConnu", () => {
  it("repère une clé privée, une clé de compte de service, une clé Stripe live", () => {
    expect(formatConnu("k.pem", `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----`)).toMatch(/PEM/);
    // Motifs coupés en deux : ce fichier passe lui-même par le garde.
    expect(formatConnu("sa.json", '{"private' + '_key": "-----BEGIN PRIVATE KEY-----\\nAAA"}')).toMatch(/Google/);
    expect(formatConnu("x.ts", `const k = "sk_live_${"a1B2".repeat(6)}";`)).toMatch(/Stripe/);
  });
  it("repère un vidage d'environnement, pas un modèle vide ni la doc", () => {
    const vidage = ["CRON_SECRET=0123456789ab", "DASHBOARD_PASSWORD=motdepasse12", "BEDS24_TOKEN=abcdefghijkl"].join("\n");
    expect(formatConnu("env-prod.txt", vidage)).toMatch(/vidage/);
    expect(formatConnu("env.example.txt", "CRON_SECRET=\nDASHBOARD_PASSWORD=\nBEDS24_TOKEN=")).toBe(null);
    expect(formatConnu("docs/env.md", vidage)).toBe(null);
    expect(formatConnu("x.ts", "-----BEGIN PRIVATE KEY----- est l'en-tête attendu")).toBe(null);
  });
});

describe("estFichierEnv", () => {
  it.each([
    [".env", true],
    [".env.local", true],
    ["app/.env.production", true],
    [".env.example", false],
    [".env.sample", false],
    [".env.local.template", false],
    [".envrc", false],
    ["docs/env.md", false],
  ])("%s → %s", (chemin, attendu) => {
    expect(estFichierEnv(chemin)).toBe(attendu);
  });
});

describe("decoder", () => {
  it("décode l'UTF-16 avec BOM (redirection PowerShell 5), écarte le binaire", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"phone":1}', "utf16le")]);
    expect(decoder(le)).toBe('{"phone":1}');
    const be = Buffer.from(le.subarray(2));
    be.swap16();
    expect(decoder(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('{"phone":1}');
    expect(decoder(Buffer.from([0x89, 0x50, 0x00, 0x01]))).toBe(null);
  });
});

describe("controlerIndex sur un dépôt jetable", () => {
  let racine: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: racine, stdio: "pipe" });
  const ecrire = (f: string, contenu: string | Buffer) => writeFileSync(join(racine, f), contenu);
  const fichiersRefuses = (secrets: unknown[] = []) => controlerIndex({ racine, secrets }).refus.map((r) => r.fichier);

  beforeEach(() => {
    racine = mkdtempSync(join(tmpdir(), "garde-commit-"));
    git("init", "-q");
  });
  afterEach(() => rmSync(racine, { recursive: true, force: true }));

  it("ne dit rien quand l'index est vide ou sain", () => {
    expect(controlerIndex({ racine, secrets: [] })).toEqual({ refus: [], avertissements: [] });
    ecrire("a.ts", "export const a = 1;\n");
    git("add", "a.ts");
    expect(fichiersRefuses()).toEqual([]);
  });

  it("refuse un fichier exclu par le .gitignore ajouté de force, accepte la liste blanche", () => {
    ecrire(".gitignore", "/data/*\n!/data/reviews.json\n");
    mkdirSync(join(racine, "data"));
    ecrire("data/reviews.json", "[]");
    ecrire("data/bookings-archive-2026.json", "[]");
    git("add", ".gitignore", "data/reviews.json");
    git("add", "-f", "data/bookings-archive-2026.json");
    const { refus } = controlerIndex({ racine, secrets: [] });
    expect(refus.map((r) => r.fichier)).toEqual(["data/bookings-archive-2026.json"]);
    expect(refus[0].motif).toMatch(/gitignore/);
  });

  it("refuse un .env même non ignoré, mais pas son modèle ; nomme un chemin à accents et espaces", () => {
    ecrire(".env.local", "X=1\n");
    ecrire(".env.example", "X=\n");
    mkdirSync(join(racine, "réservations été"));
    ecrire("réservations été/.env", "X=1\n");
    git("add", ".env.local", ".env.example", "réservations été/.env");
    expect(fichiersRefuses().sort()).toEqual([".env.local", "réservations été/.env"]);
  });

  it("refuse un fichier qui contient la valeur d'un secret du poste, sans la citer", () => {
    ecrire(".gitignore", ".env*\n");
    ecrire(".env.local", "CRON_SECRET=0123456789abcdef0123\nSITE_URL=https://www.exemple.fr\n");
    ecrire("route.ts", 'const s = "0123456789abcdef0123"; // https://www.exemple.fr\n');
    git("add", ".gitignore", "route.ts");
    const { refus } = controlerIndex({ racine });
    expect(refus).toEqual([{ fichier: "route.ts", motif: "contient la valeur de CRON_SECRET" }]);
    expect(JSON.stringify(refus)).not.toContain("0123456789abcdef0123");
  });

  it("avertit quand aucun fichier d'environnement n'est trouvé", () => {
    ecrire("a.ts", "x\n");
    git("add", "a.ts");
    expect(controlerIndex({ racine }).avertissements).toEqual([
      "aucun fichier d'environnement trouvé : le contrôle des valeurs de secrets est inactif",
    ]);
  });

  it("lit le .env.local du worktree principal depuis un worktree, et garde-commit.envFile", () => {
    ecrire(".gitignore", ".env*\n");
    ecrire(".env.local", "CRON_SECRET=0123456789abcdef0123\n");
    ecrire("a.ts", "x\n");
    git("add", ".gitignore", "a.ts");
    git("-c", "user.name=t", "-c", "user.email=t@exemple.fr", "commit", "-qm", "init");
    const arbre = mkdtempSync(join(tmpdir(), "garde-arbre-"));
    try {
      git("worktree", "add", "-q", join(arbre, "w"), "-b", "w");
      const w = join(arbre, "w");
      writeFileSync(join(w, "b.ts"), "const s = '0123456789abcdef0123';\n");
      writeFileSync(join(arbre, "voisin.env"), "AUTRE_TOKEN=jeton-du-site-voisin\n");
      writeFileSync(join(w, "c.ts"), "jeton-du-site-voisin\n");
      execFileSync("git", ["add", "b.ts", "c.ts"], { cwd: w });
      execFileSync("git", ["config", "garde-commit.envFile", join(arbre, "voisin.env")], { cwd: w });
      const { refus, avertissements } = controlerIndex({ racine: w });
      expect(avertissements).toEqual([]);
      expect(refus).toEqual([
        { fichier: "b.ts", motif: "contient la valeur de CRON_SECRET" },
        { fichier: "c.ts", motif: "contient la valeur de AUTRE_TOKEN" },
      ]);
    } finally {
      git("worktree", "remove", "--force", join(arbre, "w"));
      rmSync(arbre, { recursive: true, force: true });
    }
  });

  it("garde-commit.ignorer retire une variable publique du contrôle", () => {
    ecrire(".gitignore", ".env*\n");
    ecrire(".env.local", "INDEXNOW_KEY=abcdef0123456789\n");
    ecrire("package.json", '{"indexnow":"--key abcdef0123456789"}\n');
    git("add", ".gitignore", "package.json");
    expect(controlerIndex({ racine }).refus).toHaveLength(1);
    git("config", "garde-commit.ignorer", "INDEXNOW_KEY");
    expect(controlerIndex({ racine })).toEqual({
      refus: [],
      avertissements: [
        "variables exclues par garde-commit.ignorer : INDEXNOW_KEY",
        "aucun secret retenu dans les fichiers d'environnement : le contrôle des valeurs de secrets est inactif",
      ],
    });
  });

  it("lit le contenu indexé, pas la copie de travail", () => {
    ecrire("x.ts", "propre\n");
    git("add", "x.ts");
    ecrire("x.ts", "valeur-tres-secrete\n");
    expect(fichiersRefuses([{ nom: "S", valeur: "valeur-tres-secrete", type: "secret" }])).toEqual([]);
  });

  it("contrôle un fichier renommé sous son nouveau nom", () => {
    ecrire("a.txt", "rien\n");
    git("add", "a.txt");
    git("-c", "user.name=t", "-c", "user.email=t@exemple.fr", "commit", "-qm", "init");
    git("mv", "a.txt", "b.txt");
    ecrire("b.txt", "valeur-tres-secrete\n");
    git("add", "b.txt");
    expect(fichiersRefuses([{ nom: "S", valeur: "valeur-tres-secrete", type: "secret" }])).toEqual(["b.txt"]);
  });

  it("refuse un export UTF-16 et un export renommé en .bak", () => {
    const json = JSON.stringify([1, 2, 3, 4, 5].map((i) => ({ firstName: `P${i}`, phone: `+33${i}` })));
    ecrire("sauvegarde.json.bak", json);
    ecrire("ps.json", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, "utf16le")]));
    git("add", "sauvegarde.json.bak", "ps.json");
    expect(fichiersRefuses().sort()).toEqual(["ps.json", "sauvegarde.json.bak"]);
  });

  it("ignore les fichiers binaires", () => {
    ecrire("img.png", Buffer.from([0x89, 0x50, 0x00, 0x76, 0x61, 0x6c, 0x65, 0x75, 0x72]));
    git("add", "img.png");
    expect(fichiersRefuses([{ nom: "S", valeur: "valeur", type: "secret" }])).toEqual([]);
  });
});

describe("mode CI : --depuis <réf>", () => {
  let racine: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@exemple.fr", ...args], { cwd: racine, encoding: "utf8" }).trim();
  const ecrire = (f: string, contenu: string) => writeFileSync(join(racine, f), contenu);

  beforeEach(() => {
    racine = mkdtempSync(join(tmpdir(), "garde-ci-"));
    git("init", "-q");
    ecrire(".gitignore", "/data/*\n!/data/reviews.json\n");
    ecrire("a.ts", "propre\n");
    ecrire("vieux.json", "[]\n");
    git("add", ".");
    git("commit", "-qm", "base");
  });
  afterEach(() => rmSync(racine, { recursive: true, force: true }));

  it("contrôle les fichiers modifiés depuis la base, lus dans HEAD", () => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "pr");
    ecrire("sauvegarde.json", JSON.stringify([1, 2, 3, 4, 5].map((i) => ({ firstName: `P${i}`, phone: `+33${i}` }))));
    mkdirSync(join(racine, "data"));
    ecrire("data/historique.json", "[]");
    git("add", "sauvegarde.json");
    git("add", "-f", "data/historique.json");
    git("rm", "-q", "vieux.json");
    git("commit", "-qm", "pr");
    ecrire("sauvegarde.json", "[]\n"); // la copie de travail ne compte pas
    const { refus } = controlerIndex({ racine, secrets: [], depuis: base });
    expect(refus.map((r) => r.fichier).sort()).toEqual(["data/historique.json", "sauvegarde.json"]);
  });

  it("attrape un export ajouté puis retiré dans le commit suivant (il reste dans l'historique)", () => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "pr");
    ecrire("fuite.json", JSON.stringify([1, 2, 3, 4, 5].map((i) => ({ firstName: `P${i}`, phone: `+33${i}` }))));
    git("add", "fuite.json");
    git("commit", "-qm", "ajout");
    const fautif = git("rev-parse", "--short=7", "HEAD");
    git("rm", "-q", "fuite.json");
    git("commit", "-qm", "retrait");
    const { refus } = controlerIndex({ racine, secrets: [], depuis: base });
    expect(refus).toEqual([{ fichier: "fuite.json", motif: expect.stringMatching(/export/), commit: fautif }]);
  });

  it("avertit quand le .gitignore change", () => {
    const base = git("rev-parse", "HEAD");
    ecrire(".gitignore", "/data/*\n");
    git("commit", "-qam", "gitignore");
    expect(controlerIndex({ racine, secrets: [], depuis: base }).avertissements).toEqual([
      ".gitignore modifié : le refus des fichiers ignorés se fonde sur la version de HEAD, à relire",
    ]);
  });

  it("ne voit rien quand HEAD est la base", () => {
    expect(controlerIndex({ racine, secrets: [], depuis: "HEAD" }).refus).toEqual([]);
  });

  it("refuse une référence absente ou qui ressemble à une option", () => {
    expect(() => controlerIndex({ racine, secrets: [], depuis: "origin/inexistante" })).toThrow(/rev-parse/);
    expect(() => controlerIndex({ racine, secrets: [], depuis: "--output=x" })).toThrow(/invalide/);
    expect(() => controlerIndex({ racine, secrets: [], depuis: "" })).toThrow(/invalide/);
  });

  it("lit les arguments de la ligne de commande", () => {
    expect(lireArguments([])).toEqual({});
    expect(lireArguments(["--depuis", "origin/main"])).toEqual({ depuis: "origin/main" });
    expect(() => lireArguments(["--depuis"])).toThrow(/inattendus/);
    expect(() => lireArguments(["x"])).toThrow(/inattendus/);
  });
});

describe("le hook déclenché par un vrai git commit", () => {
  let racine: string;
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@exemple.fr", ...args], { cwd: racine, encoding: "utf8" });

  beforeEach(() => {
    racine = mkdtempSync(join(tmpdir(), "garde-hook-"));
    git("init", "-q");
    mkdirSync(join(racine, ".githooks"));
    writeFileSync(join(racine, ".githooks", "pre-commit"), `#!/bin/sh\nexec node "${SCRIPT.replace(/\\/g, "/")}"\n`, { mode: 0o755 });
    git("config", "core.hooksPath", ".githooks");
    writeFileSync(join(racine, ".gitignore"), ".env*\n");
    writeFileSync(join(racine, ".env.local"), "CRON_SECRET=0123456789abcdef0123\n");
    writeFileSync(join(racine, "a.ts"), "propre\n");
    git("add", ".gitignore", "a.ts");
    expect(git("commit", "-qm", "init").status).toBe(0);
  });
  afterEach(() => rmSync(racine, { recursive: true, force: true }));

  it("refuse un commit -a qui ferait fuiter un secret, sans le citer", () => {
    writeFileSync(join(racine, "a.ts"), "const s = '0123456789abcdef0123';\n");
    const r = git("commit", "-a", "-m", "fuite");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("contient la valeur de CRON_SECRET");
    expect(r.stderr).not.toContain("0123456789abcdef0123");
  });

  it("refuse un commit <chemin> (index temporaire) et laisse passer un commit sain", () => {
    writeFileSync(join(racine, "a.ts"), "const s = '0123456789abcdef0123';\n");
    expect(git("commit", "a.ts", "-m", "fuite").status).not.toBe(0);
    writeFileSync(join(racine, "a.ts"), "toujours propre\n");
    expect(git("commit", "-a", "-m", "sain").status).toBe(0);
  });
});
