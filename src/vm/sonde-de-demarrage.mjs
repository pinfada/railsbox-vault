// La SONDE DE DÉMARRAGE : la VM est prête quand RAILS RÉPOND (#351, ADR 0055).
//
// La coquille attendait `/vault/health` en 200 et en JSON. Seule l'application de référence porte
// cette route : une application extérieure n'était JAMAIS prête, et la personne lisait après cinq
// minutes « L'opération n'a pas abouti, sans cause identifiée ». C'est l'outil qui s'adapte à
// l'application, jamais l'inverse (#272).
//
// ## Ce qui vaut « prêt »
//
// TOUTE réponse HTTP. Le pont série (`serial-bridge.py`) ne rend une réponse que si Puma en a rendu
// une : quand rien n'écoute, il rend une ERREUR (`application-injoignable`, `delai-depasse`). Or
// Puma, en mode simple, charge l'application AVANT d'ouvrir son port. Une réponse, quel que soit son
// statut, dit donc que Rails est chargé et qu'il sert. RailsBox (même propriétaire, MIT) juge de même :
// il attend une réponse HTTP, pas une route.
//
// Le chemin sondé reste `/vault/health` : pour une application qui ne le porte pas, Rails rend sa
// 404 sans passer par aucun contrôleur, ce qui en fait la requête la moins coûteuse qu'on puisse lui
// faire ; et l'application de RÉFÉRENCE y rend sa santé (Ruby, Rails, schéma), que ses épreuves
// relisent. Cette santé est un SUPPLÉMENT, lu quand il est là : rien n'en dépend pour démarrer.
//
// ## Ce qu'un échec dit
//
// La cause RÉELLE, en clair : la dernière erreur de la sonde et ce que l'application a imprimé en
// dernier. Un arrêt de l'application (`[vault] application arretee`, écrit par `guest-init.sh`) fait
// échouer TOUT DE SUITE, sans attendre le délai : attendre cinq minutes une application morte ne
// laisse à la personne que le temps de croire qu'elle est lente.

/** Le chemin sondé : la santé de la référence, une 404 de Rails pour toute autre application. */
export const CHEMIN_DE_LA_SONDE = "/vault/health";

/** La ligne que `guest-init.sh` écrit dans le journal de l'application quand elle s'arrête. */
export const MARQUE_D_ARRET = "[vault] application arretee";

/** Ce qu'une cause peut peser : elle s'affiche dans une alerte, pas dans un journal. */
export const LONGUEUR_MAX_DE_LA_CAUSE = 600;

const LONGUEUR_MAX_D_UNE_LIGNE = 240;

/**
 * Les signatures d'échec qu'une application Rails rencontre en arrivant dans un coffre, du plus
 * précis au plus général. Le texte dit ce qui manque, pas ce que Ruby a imprimé.
 */
const CAUSES_CONNUES = Object.freeze([
  {
    motif: /secret_key_base/i,
    texte: "Rails exige une clé secrète (secret_key_base) et ne l'a pas trouvée.",
  },
  {
    motif: /\r': No such file|ruby\r|bad interpreter/,
    texte: "Un script de l'application a des fins de ligne Windows (CRLF).",
  },
  {
    motif: /Bundler::GemNotFound|Could not find .* in locally installed gems|bundle install/,
    texte: "Une gemme du Gemfile.lock manque dans le paquet.",
  },
  {
    motif: /ActiveRecord::|SQLite3::|database/i,
    texte: "Rails n'a pas pu ouvrir sa base de données.",
  },
]);

/** Une ligne lisible : sans caractère de contrôle, et bornée. */
function lisible(ligne) {
  const propre = String(ligne)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return propre.length <= LONGUEUR_MAX_D_UNE_LIGNE
    ? propre
    : `${propre.slice(0, LONGUEUR_MAX_D_UNE_LIGNE - 1)}…`;
}

/** Ce que la dernière erreur de la sonde dit, en clair. */
function sondeEnClair(derniereErreur) {
  const message = derniereErreur?.message ?? "";
  if (/application-injoignable/.test(message)) return "rien n'écoutait sur son port";
  if (/delai|aucune réponse/i.test(message)) return "elle ne répondait pas à temps";
  return message === "" ? null : lisible(message);
}

/**
 * La CAUSE d'un démarrage qui n'a pas abouti, en une ou deux phrases qu'une personne peut lire.
 *
 * @param {{ arretee?: boolean, delaiS?: number, derniereErreur?: Error | null,
 *           lignes?: readonly string[] }} constat
 * @returns {string}
 */
export function causeDuDemarrage({
  arretee = false,
  delaiS = null,
  derniereErreur = null,
  lignes = [],
}) {
  const parlantes = lignes
    .map(lisible)
    .filter((ligne) => ligne !== "" && !ligne.startsWith(MARQUE_D_ARRET));
  const phrases = [];
  if (arretee) {
    phrases.push("L'application s'est arrêtée pendant son démarrage.");
  } else {
    const sonde = sondeEnClair(derniereErreur);
    const duree = delaiS === null ? "" : ` en ${delaiS} s`;
    phrases.push(`L'application n'a pas répondu${duree}${sonde === null ? "" : ` : ${sonde}`}.`);
  }
  const connue = CAUSES_CONNUES.find(({ motif }) => lignes.some((ligne) => motif.test(ligne)));
  if (connue !== undefined) phrases.push(connue.texte);
  const derniere = parlantes.at(-1);
  if (derniere !== undefined) phrases.push(`Dernière ligne de l'application : « ${derniere} ».`);
  const cause = phrases.join(" ");
  return cause.length <= LONGUEUR_MAX_DE_LA_CAUSE
    ? cause
    : `${cause.slice(0, LONGUEUR_MAX_DE_LA_CAUSE - 1)}…`;
}

/** Un échec de démarrage qui porte sa cause en clair. */
export class DemarrageSansReponse extends Error {
  constructor(message, causeEnClair) {
    super(message);
    this.name = "DemarrageSansReponse";
    this.causeEnClair = causeEnClair;
  }
}

/** La santé publiée par la réponse, si c'est un 200 en JSON ; `null` sinon. */
function santeDe(reponse) {
  if (reponse.statut !== 200) return null;
  try {
    const sante = JSON.parse(new TextDecoder().decode(reponse.corps));
    return sante !== null && typeof sante === "object" ? sante : null;
  } catch {
    // Un 200 qui n'est pas du JSON est une RÉPONSE de Rails : prêt, sans santé à relire.
    return null;
  }
}

/**
 * ATTEND que Rails réponde, et rend la durée mesurée et la santé éventuelle.
 *
 * @param {{ requete: (methode: string, chemin: string, reglages?: object) => Promise<{
 *             statut: number, corps: Uint8Array }>,
 *           lignes: () => readonly string[],
 *           totalTimeoutMs: number, probeTimeoutMs?: number, intervalMs?: number,
 *           pause?: (ms: number) => Promise<void>, maintenant?: () => number }} reglages
 * @returns {Promise<{ durationMs: number, sante: Record<string, any> | null, statut: number }>}
 */
export async function attendreQueRailsReponde({
  requete,
  lignes,
  totalTimeoutMs,
  probeTimeoutMs = 5_000,
  intervalMs = 2_000,
  pause = (ms) => new Promise((resoudre) => setTimeout(resoudre, ms)),
  maintenant = () => Date.now(),
}) {
  const debut = maintenant();
  const estArretee = () => lignes().some((ligne) => String(ligne).includes(MARQUE_D_ARRET));
  let derniereErreur;
  do {
    try {
      const reponse = await requete("GET", CHEMIN_DE_LA_SONDE, { timeoutMs: probeTimeoutMs });
      return { durationMs: maintenant() - debut, sante: santeDe(reponse), statut: reponse.statut };
    } catch (erreur) {
      derniereErreur = erreur instanceof Error ? erreur : new Error(String(erreur));
    }
    if (estArretee()) {
      throw new DemarrageSansReponse(
        `L'application s'est arrêtée ; dernière erreur de la sonde : ${derniereErreur.message}`,
        causeDuDemarrage({ arretee: true, derniereErreur, lignes: lignes() }),
      );
    }
    await pause(intervalMs);
  } while (maintenant() - debut < totalTimeoutMs);
  const delaiS = Math.round(totalTimeoutMs / 1000);
  throw new DemarrageSansReponse(
    `Rails n'a pas répondu à ${CHEMIN_DE_LA_SONDE} en ${delaiS} s ; dernière erreur : ` +
      `${derniereErreur?.message ?? "aucune"}`,
    causeDuDemarrage({ delaiS, derniereErreur, lignes: lignes() }),
  );
}
