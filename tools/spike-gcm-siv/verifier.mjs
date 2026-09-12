/**
 * Vérifie chaque implémentation d'AES-GCM-SIV du spike #185 contre les vecteurs de la RFC 8452.
 *
 *     node tools/spike-gcm-siv/verifier.mjs
 *
 * Une mesure de coût sur une implémentation fausse ne mesure rien. Ce script est donc la barrière
 * du banc : il rejoue les vingt-six vecteurs AES-256 de la RFC (annexes C.2 et C.3) sur la
 * composition WebCrypto du dépôt, sur les vecteurs de conversion POLYVAL/GHASH de l'annexe A, et —
 * si `preparer-candidate.mjs` l'a déposée — sur la candidate tierce.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as compose from "./gcm-siv-webcrypto.mjs";
import { chargerCandidate } from "./candidate/charger.mjs";
import { depuisHex, versHex } from "./octets.mjs";
import { polyval } from "./polyval.mjs";

const racine = new URL("./", import.meta.url);

/** Vecteurs de l'annexe A : ils vérifient la CONVERSION POLYVAL ↔ GHASH, pas seulement le produit. */
const VECTEURS_ANNEXE_A = {
  cleH: "25629347589242761d31f826ba4b757b",
  blocs: "4f4f95668c83dfb6401762bb2d01a262d1a24ddd2721d006bbe45f20d3c9f362",
  attendu: "f7a3b47b846119fae5b7866cf5e5b77e",
};

async function chargerVecteurs() {
  const texte = await readFile(
    fileURLToPath(new URL("vecteurs-rfc8452-aes256.json", racine)),
    "utf8",
  );
  return JSON.parse(texte);
}

function verifierPolyval(echecs) {
  const obtenu = versHex(
    polyval(depuisHex(VECTEURS_ANNEXE_A.cleH), depuisHex(VECTEURS_ANNEXE_A.blocs)),
  );
  if (obtenu !== VECTEURS_ANNEXE_A.attendu) {
    echecs.push(`POLYVAL annexe A : ${obtenu} au lieu de ${VECTEURS_ANNEXE_A.attendu}`);
  }
  return 1;
}

/**
 * Rejoue les vecteurs sur une implémentation donnée, dans les deux sens. Une implémentation qui
 * scelle juste et n'ouvre pas n'est pas vérifiée.
 */
async function verifierImplementation(nom, implementation, vecteurs, echecs) {
  let comptees = 0;
  for (const [rang, vecteur] of vecteurs.entries()) {
    const cle = depuisHex(vecteur.cle);
    const nonce = depuisHex(vecteur.nonce);
    const clair = depuisHex(vecteur.clair);
    const donneesAssociees = depuisHex(vecteur.donneesAssociees ?? "");

    const scelle = await implementation.sceller(cle, nonce, clair, donneesAssociees);
    comptees += 1;
    if (versHex(scelle) !== vecteur.resultat) {
      echecs.push(
        `${nom} / vecteur ${rang} (${vecteur.section}) : scellement ${versHex(scelle)} au lieu de ${vecteur.resultat}`,
      );
      continue;
    }

    const ouvert = await implementation.ouvrir(cle, nonce, scelle, donneesAssociees);
    comptees += 1;
    if (versHex(ouvert) !== vecteur.clair) {
      echecs.push(
        `${nom} / vecteur ${rang} : ouverture ${versHex(ouvert)} au lieu de ${vecteur.clair}`,
      );
      continue;
    }

    // Témoin négatif : un octet changé dans le scellement doit faire refuser l'ouverture. Sans lui,
    // une implémentation qui ignore l'étiquette passerait toutes les lignes ci-dessus.
    const abime = Uint8Array.from(scelle);
    abime[abime.length - 1] ^= 0x01;
    comptees += 1;
    let refuse = false;
    try {
      await implementation.ouvrir(cle, nonce, abime, donneesAssociees);
    } catch {
      refuse = true;
    }
    if (!refuse) echecs.push(`${nom} / vecteur ${rang} : une étiquette abîmée a été ACCEPTÉE`);
  }
  return comptees;
}

async function principal() {
  const { vecteurs, provenance } = await chargerVecteurs();
  const echecs = [];
  let comptees = verifierPolyval(echecs);

  comptees += await verifierImplementation("composition WebCrypto", compose, vecteurs, echecs);

  // L'émission en VAGUES ne doit pas changer un octet : les blocs d'une même suite sont
  // indépendants. C'est ce qui autorise à publier son gain comme un gain d'écriture et non comme
  // une variante d'algorithme (revue de la PR #202, HIGH 2).
  const enVagues = {
    sceller: (cle, nonce, clair, aad) => compose.sceller(cle, nonce, clair, aad, { vagues: true }),
    ouvrir: (cle, nonce, scelle, aad) => compose.ouvrir(cle, nonce, scelle, aad, { vagues: true }),
  };
  comptees += await verifierImplementation("composition en vagues", enVagues, vecteurs, echecs);

  const candidate = await chargerCandidate();
  if (candidate.disponible) {
    comptees += await verifierImplementation(
      `candidate ${candidate.identite}`,
      candidate,
      vecteurs,
      echecs,
    );
  }

  console.log(`vecteurs : ${provenance.source}`);
  console.log(
    `candidate : ${candidate.disponible ? candidate.identite : `absente (${candidate.raison})`}`,
  );
  console.log(`${comptees} vérifications, ${echecs.length} échec(s)`);
  for (const echec of echecs) console.error(`  ✗ ${echec}`);
  if (echecs.length > 0) process.exitCode = 1;
}

await principal();
