/**
 * MODÈLE DE RÉFÉRENCE de la dérivation (#22, ADR 0021), écrit pour les épreuves seules.
 *
 * Il vit sous `tests/` et non sous `src/`, contrairement au modèle de l'enveloppe (ADR 0020) : ce
 * qu'il transcrit n'est pas un format sur disque mais deux appels de WebCrypto, et le seul service
 * qu'il rend est d'être une SECONDE transcription — indépendante — de ce que l'ADR 0021 décrit.
 *
 * Deux fonctions, et elles ne partagent AUCUN code avec le produit :
 *
 *  - `infoDeReference` réécrit l'encodage de l'info HKDF à la main, octet par octet, sans appeler
 *    `chainePrefixee` ni `entierEnOctets`. C'est la seule façon qu'un désaccord d'encodage se voie :
 *    deux appels du même encodeur s'accordent toujours, y compris quand il est faux ;
 *  - `okmDeReference` dérive les trente-deux octets par `deriveBits`, là où le produit dérive une
 *    `CryptoKey` NON EXTRACTIBLE par `deriveKey`. Le modèle a donc le droit de voir les octets, et
 *    le produit ne l'a pas — c'est exactement l'écart que l'épreuve « scellée sous l'une, ouverte
 *    sous l'autre » mesure sans jamais extraire la clé de production.
 */

/** Écrit un entier non signé gros-boutiste sur `largeur` octets, à la main. */
function entier(valeur, largeur) {
  const octets = new Uint8Array(largeur);
  let reste = valeur;
  for (let index = largeur - 1; index >= 0; index -= 1) {
    octets[index] = reste % 256;
    reste = Math.floor(reste / 256);
  }
  if (reste !== 0) throw new RangeError(`${valeur} ne tient pas sur ${largeur} octets.`);
  return octets;
}

/** Une chaîne UTF-8 précédée de sa longueur sur deux octets. */
function prefixee(texte) {
  const utf8 = new TextEncoder().encode(texte);
  const octets = new Uint8Array(2 + utf8.byteLength);
  octets.set(entier(utf8.byteLength, 2), 0);
  octets.set(utf8, 2);
  return octets;
}

function coller(morceaux) {
  let total = 0;
  for (const morceau of morceaux) total += morceau.byteLength;
  const rendu = new Uint8Array(total);
  let curseur = 0;
  for (const morceau of morceaux) {
    rendu.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  return rendu;
}

/**
 * L'INFO que HKDF reçoit : étiquette de domaine, identifiant de volume, identifiant d'emplacement,
 * version de dérivation. Transcription indépendante de l'ADR 0021, décision 2.
 *
 * @param {{ identifiantVolume: string, identifiantEmplacement: string, version: number }} identite
 */
export function infoDeReference({ identifiantVolume, identifiantEmplacement, version }) {
  return coller([
    prefixee("railsbox-vault/derivation/v1/kek"),
    prefixee(identifiantVolume),
    prefixee(identifiantEmplacement),
    entier(version, 4),
  ]);
}

/**
 * Les trente-deux octets qu'HKDF-SHA-256 rend. Le produit n'en rend jamais que la `CryptoKey`.
 *
 * @param {{ materiau: Uint8Array, sel: Uint8Array, info: Uint8Array }} appel
 */
export async function okmDeReference({ materiau, sel, info }) {
  const base = await crypto.subtle.importKey("raw", materiau, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: sel, info },
    base,
    256,
  );
  return new Uint8Array(bits);
}
