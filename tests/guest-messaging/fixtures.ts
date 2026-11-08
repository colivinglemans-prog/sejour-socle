import type { MessageTemplate, MessagingBooking } from "../../lib/guest-messaging/types";

const L = (fr: string, en = fr, de = fr, es = fr, it = fr) => ({ fr, en, de, es, it });

/** Réservation fictive — aucune donnée réelle. */
export function booking(over: Partial<MessagingBooking> = {}): MessagingBooking {
  return {
    id: 1001,
    status: "confirmed",
    channel: "Airbnb",
    arrival: "2026-12-10",
    departure: "2026-12-13",
    bookingTime: "2026-11-01T10:00:00Z",
    locale: "fr",
    localeSource: "beds24",
    infoCodes: ["ACCESS_CODE"],
    ledger: [],
    ...over,
  };
}

/** Modèle d'accès : J-5 à 16:00, rattrapé jusqu'au jour d'arrivée 23:00, renvoyé si les dates bougent. */
export const access: MessageTemplate = {
  id: "arrivee",
  label: "Arrivée + code",
  version: 3,
  trigger: { anchor: "arrival", offsetDays: -5, at: "16:00" },
  late: { mode: "send", until: { anchor: "arrival", offsetDays: 0, at: "23:00" } },
  conditions: { requiredInfoItem: "ACCESS_CODE" },
  onAnchorChange: "resend",
  variables: ["code", "guide"],
  optionalVariables: ["prenom"],
  subject: L("Votre arrivée", "Your arrival", "Ihre Ankunft", "Su llegada", "Il tuo arrivo"),
  body: L(
    "Bonjour{{#prenom}} {{prenom}}{{/prenom}},\n\nVotre code : {{code}}\nGuide : {{guide}}",
    "Hello{{#prenom}} {{prenom}}{{/prenom}},\n\nYour code: {{code}}\nGuide: {{guide}}",
    "Hallo{{#prenom}} {{prenom}}{{/prenom}},\n\nIhr Code: {{code}}\nAnleitung: {{guide}}",
    "Hola{{#prenom}} {{prenom}}{{/prenom}},\n\nTu código: {{code}}\nGuía: {{guide}}",
    "Ciao{{#prenom}} {{prenom}}{{/prenom}},\n\nIl tuo codice: {{code}}\nGuida: {{guide}}",
  ),
  fingerprints: ["votre code personnel pour la duree"],
};

/** Modèle de confort : veille du départ à 17:00, sauté au-delà de 6 h de retard. */
export const departure: MessageTemplate = {
  id: "depart",
  label: "Veille du départ",
  version: 1,
  trigger: { anchor: "departure", offsetDays: -1, at: "17:00" },
  late: { mode: "skip", graceHours: 6 },
  conditions: { minNights: 2 },
  onAnchorChange: "ignore",
  variables: [],
  optionalVariables: ["prenom"],
  subject: L("Votre départ", "Your departure", "Ihre Abreise", "Su salida", "La tua partenza"),
  body: L(
    "Bonjour{{#prenom}} {{prenom}}{{/prenom}}, le départ approche !",
    "Hello{{#prenom}} {{prenom}}{{/prenom}}, your departure is approaching!",
    "Hallo{{#prenom}} {{prenom}}{{/prenom}}, Ihre Abreise naht!",
    "Hola{{#prenom}} {{prenom}}{{/prenom}}, ¡se acerca tu salida!",
    "Ciao{{#prenom}} {{prenom}}{{/prenom}}, la partenza si avvicina!",
  ),
  fingerprints: ["le depart approche"],
};
