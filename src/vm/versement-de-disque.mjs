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
 * @returns {Promise<{ ecrits: number, empreinte: string | null }>}
 */
export async function verserFluxDansVolume(backend, url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok || response.body === null) {
    throw new Error(`Disque applicatif ${url} indisponible (${response.status}).`);
  }
  const reader = response.body.getReader();
  let offset = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value.byteLength === 0) continue;
    await backend.write(offset, value);
    offset += value.byteLength;
  }
  await backend.flush();
  const empreinte =
    typeof backend.empreinteDuFichier === "function" ? await backend.empreinteDuFichier() : null;
  return { ecrits: offset, empreinte };
}
