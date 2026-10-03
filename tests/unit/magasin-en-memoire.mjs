// Double en mémoire des primitives OPFS du magasin d'artefacts (#247).

/** Primitives en mémoire ; `lectures` relève la taille de chaque lecture d'artefact. */
export function primitivesEnMemoire() {
  const fichiers = new Map();
  const lectures = [];
  const ecritures = [];
  return {
    fichiers,
    lectures,
    ecritures,
    async taille(nom) {
      return fichiers.has(nom) ? fichiers.get(nom).byteLength : null;
    },
    async lire(nom, position, cible) {
      if (!nom.endsWith(".tranches")) lectures.push(cible.byteLength);
      const source = fichiers.get(nom) ?? new Uint8Array(0);
      const morceau = source.subarray(position, position + cible.byteLength);
      cible.set(morceau);
      return morceau.byteLength;
    },
    async ecrire(nom, position, octets) {
      ecritures.push(nom);
      const avant = fichiers.get(nom) ?? new Uint8Array(0);
      const apres = new Uint8Array(Math.max(avant.byteLength, position + octets.byteLength));
      apres.set(avant);
      apres.set(octets, position);
      fichiers.set(nom, apres);
    },
    async renommer(de, vers) {
      fichiers.set(vers, fichiers.get(de));
      fichiers.delete(de);
    },
    async supprimer(nom) {
      fichiers.delete(nom);
    },
    async lister() {
      return [...fichiers.keys()];
    },
  };
}
