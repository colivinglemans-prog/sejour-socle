/**
 * Transport e-mail SMTP pour les réservations directes — le même pour les deux sites.
 *
 * Monté au socle parce que les deux sites ont fait le même choix (douanier : « une
 * implémentation n'entre que si les deux sites choisissent le même fournisseur ») : envoi par le
 * **SMTP authentifié de leur propre domaine** (OVH / Zimbra), depuis leur adresse `contact@`. Ce
 * choix ne touche pas au DNS : le SPF des deux domaines autorise déjà les serveurs OVH, alors
 * qu'un service transactionnel exigerait de le modifier.
 *
 * Les valeurs (hôte, identifiants, adresse) restent chez chaque site, en variables
 * d'environnement : ce module ne lit rien de `process.env`.
 *
 * Précautions (tonton-tuyau, cerbere) :
 * - runtime Node seulement (`export const runtime = "nodejs"` sur la route qui l'appelle) ;
 * - délais courts (10 s) : la fonction a une durée maximale, et cron-job.org coupe à 30 s ;
 * - port 465 en TLS direct, ou 587 avec STARTTLS obligatoire ;
 * - l'expéditeur est l'adresse authentifiée — OVH refuse sinon ;
 * - texte brut seulement, destinataire unique déjà validé par `realGuestEmail` ;
 * - une copie cachée optionnelle à l'hôte, faute de dossier « Envoyés » côté SMTP ;
 * - **aucune erreur brute ne sort** : celles de nodemailer citent l'adresse du destinataire. On
 *   ne garde que le code SMTP, dans une `SmtpError` sans texte.
 *
 * `nodemailer` est une dépendance du **site** (chargée à la demande) : le socle ne l'impose pas
 * à un site qui n'enverrait pas d'e-mail.
 */
import type { EmailTransport } from "./types";
import { realGuestEmail } from "./channel-rules";

export interface SmtpConfig {
  host: string;
  /** 465 (TLS direct, par défaut) ou 587 (STARTTLS). */
  port?: number;
  user: string;
  pass: string;
  /** Adresse d'expédition — celle du compte authentifié. Défaut : `user`. */
  from?: string;
  /** Nom affiché de l'expéditeur (jamais une donnée du voyageur). */
  fromName?: string;
  /** Copie cachée à l'hôte. */
  bcc?: string;
}

/** Erreur d'envoi sans texte : un code SMTP au plus. */
export class SmtpError extends Error {
  constructor(readonly status: number | undefined) {
    super(status ? `SMTP ${status}` : "SMTP");
    this.name = "SmtpError";
  }
}

/** Lit la configuration dans un objet de variables ; `null` si elle est incomplète. */
export function smtpConfigFrom(env: Record<string, string | undefined>, prefix = "SMTP_"): SmtpConfig | null {
  const get = (k: string) => env[prefix + k]?.trim() || undefined;
  const host = get("HOST");
  const user = get("USER");
  const pass = get("PASS");
  if (!host || !user || !pass) return null;
  const port = Number(get("PORT") ?? 465);
  return { host, user, pass, port: Number.isFinite(port) ? port : 465, from: get("FROM"), fromName: get("FROM_NAME"), bcc: get("BCC") };
}

export function createSmtpTransport(config: SmtpConfig): EmailTransport {
  const port = config.port ?? 465;
  return {
    async send({ to, subject, text }) {
      const recipient = realGuestEmail(to);
      if (!recipient) throw new SmtpError(undefined);
      // Chargé à la demande : la dépendance appartient au site.
      const nodemailer = (await import("nodemailer")).default;
      const transporter = nodemailer.createTransport({
        host: config.host,
        port,
        secure: port === 465,
        requireTLS: port !== 465,
        auth: { user: config.user, pass: config.pass },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
      });
      const from = config.from ?? config.user;
      try {
        await transporter.sendMail({
          // Champs séparés, jamais un en-tête construit à la main.
          from: config.fromName ? { name: config.fromName, address: from } : from,
          to: recipient,
          bcc: config.bcc && realGuestEmail(config.bcc) ? config.bcc : undefined,
          subject,
          text,
        });
      } catch (e) {
        const code = typeof e === "object" && e !== null && "responseCode" in e ? Number((e as { responseCode: unknown }).responseCode) : undefined;
        throw new SmtpError(Number.isFinite(code) ? code : undefined);
      } finally {
        transporter.close();
      }
    },
  };
}

/**
 * Adresse qui reçoit les copies du mode `test` : `MESSAGES_TEST_TO`, à défaut l'expéditeur
 * (`SMTP_FROM`, puis `SMTP_USER`) — la boîte `contact@` du site. `undefined` si aucune n'est une
 * adresse valable : les modèles en `test` sont alors bloqués (`no-test-transport`).
 */
export function testRecipientFrom(env: Record<string, string | undefined>, prefix = "SMTP_"): string | undefined {
  for (const v of [env.MESSAGES_TEST_TO, env[prefix + "FROM"], env[prefix + "USER"]]) {
    const ok = realGuestEmail(v?.trim());
    if (ok) return ok;
  }
  return undefined;
}
