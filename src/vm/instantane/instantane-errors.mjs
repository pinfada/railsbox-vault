// Refus TYPÉS de l'instantané de reprise (#65, ADR 0024).
//
// Ils forment une famille distincte de `VAULT_STORAGE_*` et de `VAULT_CRYPTO_*` pour une raison qui
// tient en une phrase : **aucun de ces refus n'est une panne, et aucun ne perd de donnée.** Un
// instantané refusé coûte un boot à froid, rien de plus — le volume reste la seule source de vérité.
// Les ranger dans la famille du stockage aurait mis, sous les mêmes codes, des états dont le remède
// est « restaurer une sauvegarde » et des états dont le remède est « ne rien faire ».
//
// Le CODE dit ce qui a été constaté ; il ne prétend pas dire pourquoi. La distinction est celle de
// l'ADR 0024, décision 4 : les cinq écarts de liaison sont posés sur un en-tête NON authentifié,
// donc ce sont des diagnostics, et `ECART_SEQUENCE` dit « l'en-tête DÉCLARE une autre séquence »,
// jamais « un adversaire a reculé le volume ». Comme tous mènent au même remède — écarter — la
// nuance ne coûte aucune sûreté.

export const INSTANTANE_ERROR_CODES = Object.freeze({
  /** Le fichier ne se reconnaît pas : marqueur absent, version inconnue, champ hors bornes. */
  malforme: "VAULT_INSTANTANE_MALFORME",
  /** La marque de complétude manque, ou le corps est plus court que la longueur déclarée. */
  incomplet: "VAULT_INSTANTANE_INCOMPLET",
  /** L'en-tête DÉCLARE un autre identifiant de volume. */
  ecartVolume: "VAULT_INSTANTANE_ECART_VOLUME",
  /** L'en-tête DÉCLARE une autre séquence validée : le volume a été écrit depuis la capture. */
  ecartSequence: "VAULT_INSTANTANE_ECART_SEQUENCE",
  /** L'en-tête DÉCLARE une autre génération validée. */
  ecartGeneration: "VAULT_INSTANTANE_ECART_GENERATION",
  /** L'en-tête DÉCLARE une autre empreinte de région d'authentification. */
  ecartRegion: "VAULT_INSTANTANE_ECART_REGION",
  /** L'en-tête DÉCLARE une autre empreinte d'image de référence. */
  ecartImage: "VAULT_INSTANTANE_ECART_IMAGE",
  /**
   * L'étiquette ne vérifie pas. Comme partout dans ce dépôt, la CAUSE n'est pas établie : un octet
   * altéré, un en-tête forgé, une autre clé et un corps déplacé sont indiscernables. Aucun clair
   * n'est rendu, et surtout aucun zéro.
   */
  sceauRefuse: "VAULT_INSTANTANE_SCEAU_REFUSE",
  /** Le budget de scellements de la clé de volume est atteint (NIST SP 800-38D § 8.3). */
  budgetDeCle: "VAULT_INSTANTANE_BUDGET_DE_CLE",
  /** Une E/S a traversé l'adaptateur pendant la capture : il n'y a pas de capture partielle. */
  quiescenceRompue: "VAULT_INSTANTANE_QUIESCENCE_ROMPUE",
  /** Les conditions de capture ne sont pas réunies (génération ouverte, E/S en vol, panne). */
  captureRefusee: "VAULT_INSTANTANE_CAPTURE_REFUSEE",
});

const CODES_CONNUS = new Set(Object.values(INSTANTANE_ERROR_CODES));

/** Erreur typée de l'instantané : un code stable, un message français, un contexte sérialisable. */
export class InstantaneError extends Error {
  /**
   * @param {string} code une valeur de `INSTANTANE_ERROR_CODES`
   * @param {string} message message destiné à l'exploitant, en français
   * @param {Record<string, unknown>} [context] contexte structuré, sans donnée utilisateur
   */
  constructor(code, message, context = {}) {
    if (!CODES_CONNUS.has(code)) {
      throw new Error(`Code de refus d'instantané inconnu : ${code}`);
    }
    super(message);
    this.name = "InstantaneError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }

  /** Forme transportable par `postMessage` : un refus ne doit pas se perdre au passage du port. */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, context: this.context };
  }
}

/** Vrai si `valeur` est un refus d'instantané portant `code`. */
export function isInstantaneError(valeur, code) {
  return valeur instanceof InstantaneError && (code === undefined || valeur.code === code);
}

/** Le fichier, ou l'appel, ne respecte pas le contrat de forme. C'est un bogue ou un fichier étranger. */
export function malforme(raison, contexte = {}) {
  return new InstantaneError(
    INSTANTANE_ERROR_CODES.malforme,
    `Instantané de reprise refusé : ${raison} Aucun octet n'est restauré ; le remède est un boot à froid, qui ne perd rien.`,
    contexte,
  );
}

/** La capture n'est pas allée jusqu'à sa marque. Écarter, et booter à froid. */
export function incomplet(raison, contexte = {}) {
  return new InstantaneError(
    INSTANTANE_ERROR_CODES.incomplet,
    `Instantané de reprise incomplet : ${raison} Une capture interrompue ne se répare pas — elle est retirée, et le boot à froid s'exécute.`,
    contexte,
  );
}

/** Les cinq écarts de liaison, par le champ qui diverge. Chaque champ a son code. */
const CODE_PAR_CHAMP = Object.freeze({
  volume: INSTANTANE_ERROR_CODES.ecartVolume,
  sequence: INSTANTANE_ERROR_CODES.ecartSequence,
  generation: INSTANTANE_ERROR_CODES.ecartGeneration,
  empreinteRegion: INSTANTANE_ERROR_CODES.ecartRegion,
  empreinteImage: INSTANTANE_ERROR_CODES.ecartImage,
});

/**
 * Un écart entre ce que l'en-tête DÉCLARE et l'état présent.
 *
 * Le champ décide du code, et le message dit ce qui est vrai : la valeur lue n'est pas encore
 * authentifiée à ce point. Le contrôle sert au DIAGNOSTIC et à épargner le déchiffrement de
 * l'instantané entier — pas à la sécurité, qui est tenue par l'étiquette.
 */
export function ecartDeLiaison(champ, { declare, present, volume }) {
  const code = CODE_PAR_CHAMP[champ];
  if (code === undefined) throw new Error(`Champ de liaison sans code de refus : ${champ}`);
  return new InstantaneError(
    code,
    `Instantané du volume « ${volume} » écarté : son en-tête DÉCLARE « ${champ} » = ${declare}, l'état présent porte ${present}. La valeur n'est pas authentifiée à ce point — elle est seulement déclarée —, mais l'écart suffit à savoir que cet instantané ne décrit pas cet état. Il est retiré ; le boot à froid s'exécute et ne perd rien.`,
    { volume, champ, declare: String(declare), present: String(present) },
  );
}

/** L'étiquette ne vérifie pas. La cause n'est pas établie, et le message le dit. */
export function sceauRefuse(contexte = {}) {
  return new InstantaneError(
    INSTANTANE_ERROR_CODES.sceauRefuse,
    `Instantané de reprise refusé : son étiquette ne vérifie pas. Un octet altéré, un en-tête forgé, un corps déplacé ou une autre clé sont indiscernables ici, et aucun clair n'est rendu — surtout pas des zéros. L'instantané est retiré ; le boot à froid s'exécute et ne perd rien.`,
    contexte,
  );
}

/** Le budget de scellements de la clé est atteint. La capture est refusée, pas approximée. */
export function budgetDeCle(contexte = {}) {
  return new InstantaneError(
    INSTANTANE_ERROR_CODES.budgetDeCle,
    `Capture d'instantané refusée : le budget de scellements de la clé de volume est atteint. Aucun scellement de plus n'est fait sous cette clé.`,
    contexte,
  );
}

/** Une E/S a traversé l'adaptateur pendant la capture. Il n'y a pas de capture partielle. */
export function quiescenceRompue({ violations, volume }) {
  return new InstantaneError(
    INSTANTANE_ERROR_CODES.quiescenceRompue,
    `Capture d'instantané du volume « ${volume} » abandonnée : ${violations} E/S ont été présentées à l'adaptateur pendant la quiescence. Un instantané capturé au-dessus d'une E/S décrirait une mémoire qui a vu une écriture que le support n'a pas reçue. Aucun fichier n'est écrit.`,
    { volume, violations },
  );
}

/** Les conditions de capture de l'ADR 0024, décision 6, ne sont pas réunies. */
export function captureRefusee(raison, contexte = {}) {
  return new InstantaneError(
    INSTANTANE_ERROR_CODES.captureRefusee,
    `Capture d'instantané refusée : ${raison} Aucun fichier n'est écrit ; la prochaine ouverture bootera à froid.`,
    contexte,
  );
}
