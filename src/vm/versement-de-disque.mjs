// VERSEMENT d'un disque applicatif dans un volume, en flux.
//
// Extrait de `public/vm/reference-worker-phases-volume.mjs` par #163 : le banc n'est plus seul à
// verser un disque dans OPFS. La coquille de produit INSTALLE l'application dans son volume au
// premier démarrage (ADR 0030, décision 1, étape 3), et une seconde copie de cette boucle aurait
// divergé de la première au premier correctif — le versement est exactement le genre de geste dont
// une divergence ne se voit qu'une fois le disque tronqué.
//
// Ce module ne décide rien : il ne crée aucun volume, n'en ferme aucun, n'écrit aucun manifeste.
// L'atomicité de la création — « un volume naît ANONYME, son manifeste n'est inscrit qu'une fois le
// disque écrit et flushé » — appartient à l'appelant, des deux côtés.

import { creerCederLaMain } from "./ceder-la-main.mjs";

/** Taille d'une tranche d'écriture : un mébioctet, multiple de tout secteur du dépôt. */
const TRANCHE_D_ECRITURE_OCTETS = 1 << 20;

/** La prochaine frontière ABSOLUE de tranche strictement après `position`. */
function alignementSuivant(position) {
  return (Math.floor(position / TRANCHE_D_ECRITURE_OCTETS) + 1) * TRANCHE_D_ECRITURE_OCTETS;
}

/**
 * Verse une réponse HTTP dans le backend, morceau par morceau, et franchit une barrière à la fin.
 *
 * Aucun morceau n'est conservé : c'est ce qui borne la surmémoire du versement, quelle que soit la
 * taille du disque — un demi-gibioctet passe sans qu'un tampon d'un demi-gibioctet existe jamais.
 *
 * Rend le nombre d'octets RÉELLEMENT écrits, que l'appelant confronte à la taille annoncée : un flux
 * tronqué ne doit pas produire un volume qui se croit complet.
 *
 * ## Et l'EMPREINTE de ce qui a été écrit (#181, revue de sécurité de la PR #184)
 *
 * Le versement RELÂCHE le fichier, et la datation de création le rouvre : entre les deux, personne
 * ne le tient. L'empreinte est prise ICI, c'est-à-dire **encore sous l'exclusivité du versement**, et
 * c'est tout ce qui la distingue d'une relecture quelconque — elle constate ce que CE geste a laissé,
 * à un instant où aucun tiers n'a pu écrire. `daterLaCreation` la confronte à ce qu'il trouve avant
 * d'écrire la racine initiale ; sans elle, la datation bénirait des octets sans savoir d'où ils
 * viennent.
 *
 * Un backend qui ne sait pas la calculer — l'ACCÈS BRUT d'un volume au format antérieur, qui n'a ni
 * en-tête ni région à hacher — rend `null`, et ce chemin-là ne date aucune création.
 *
 * La fermeture du backend n'est PAS faite ici : elle appartient au `finally` de l'appelant, qui doit
 * fermer même quand le flux échoue. L'empreinte, elle, doit être prise AVANT cette fermeture, et
 * c'est pourquoi elle est prise ici plutôt que laissée à l'appelant.
 *
 * @param {{ write: (offset: number, octets: Uint8Array) => Promise<unknown>,
 *           flush: () => Promise<unknown>,
 *           empreinteDuFichier?: () => Promise<string> }} backend
 * @param {string} url
 * @returns {Promise<{ ecrits: number, empreinte: string | null,
 *                     scellements: { volume: number, journal: number } | null }>}
 */
export async function verserFluxDansVolume(backend, url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok || response.body === null) {
    throw new Error(`Disque applicatif ${url} indisponible (${response.status}).`);
  }
  const reader = response.body.getReader();
  // Un flux déjà en mémoire se lit en microtâches : la boucle cède la main entre deux tranches, pour
  // que le battement du Worker continue de battre pendant le versement (#192, I1).
  const cederLaMain = creerCederLaMain();
  let offset = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value.byteLength === 0) continue;
    // Un morceau du flux peut peser des dizaines de mébioctets, et son chiffrement est synchrone : il
    // est écrit par TRANCHES alignées sur une frontière absolue d'un mébioctet — donc de secteur —,
    // si bien qu'aucun secteur n'est coupé par une tranche et qu'aucun octet écrit ne change.
    for (let lu = 0; lu < value.byteLength;) {
      const fin = Math.min(value.byteLength, alignementSuivant(offset + lu) - offset);
      await backend.write(offset + lu, value.subarray(lu, fin));
      lu = fin;
      await cederLaMain();
    }
    offset += value.byteLength;
  }
  await backend.flush();
  const empreinte =
    typeof backend.empreinteDuFichier === "function" ? await backend.empreinteDuFichier() : null;
  // Le COMPTE des scellements, rendu pour la même raison que l'empreinte : cette session se ferme
  // sans écrire de racine, et ce qu'elle a consommé sous la clé du volume ne vit nulle part
  // ailleurs. La datation le REPORTE ; sans lui, elle ne reprendrait que le compteur de la
  // naissance et perdrait tout le versement (revue de format de la PR #186, constat 2).
  const scellements = backend.scellementsCumules ?? null;
  return { ecrits: offset, empreinte, scellements };
}
