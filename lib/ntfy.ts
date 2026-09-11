/**
 * Notifications push via ntfy.sh.
 *
 * `NTFY_TOPIC` contient l'URL complète du topic (ex. `https://ntfy.sh/mon-topic-xyz123`) :
 * un topic ntfy n'a pas d'authentification, son nom **est** le secret, il n'a donc rien à
 * faire dans le code. Souscrire au topic depuis l'application mobile ntfy pour recevoir les
 * notifications.
 */

export interface NtfyOptions {
  title?: string;
  /** 3 = normal, 5 = maximum. */
  priority?: 1 | 2 | 3 | 4 | 5;
  /** Émojis ou mots-clés, ex. `["key", "house"]`. */
  tags?: string[];
  /** URL ouverte au tap sur la notification. */
  click?: string;
}

export async function sendNtfy(message: string, options: NtfyOptions = {}): Promise<void> {
  const url = process.env.NTFY_TOPIC;
  if (!url) {
    console.error("NTFY_TOPIC n'est pas défini, notification push ignorée");
    return;
  }

  const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
  if (options.title) headers["Title"] = encodeRfc2047(options.title);
  if (options.priority) headers["Priority"] = String(options.priority);
  if (options.tags && options.tags.length > 0) headers["Tags"] = options.tags.join(",");
  if (options.click) headers["Click"] = options.click;

  const res = await fetch(url, { method: "POST", headers, body: message, cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ntfy ${res.status}: ${text.slice(0, 200)}`);
  }
}

/**
 * Les en-têtes HTTP de ntfy doivent être en ASCII : un titre accentué part en RFC 2047
 * (UTF-8 encodé en base64). Sans cela, « Arrivée » arrive tronqué ou rejeté.
 */
function encodeRfc2047(value: string): string {
  let isAscii = true;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 127) {
      isAscii = false;
      break;
    }
  }
  if (isAscii) return value;
  const b64 = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}
