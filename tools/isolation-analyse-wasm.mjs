// Analyse binaire d'un module WebAssembly, et verdict de l'inventaire d'isolation (#41).
//
// Extrait de `isolation-inventaire.mjs` pour la même raison que `v86-paths.mjs` l'a été de
// `fetch-v86.mjs` : cet outil est un exécutable qui agit dès son import, et le fait qui porte
// l'ADR 0010 doit être vérifiable sous Node sans lire un artefact tiers ni écrire un rapport.
//
// Ce que ce module sait, et qu'aucun `grep` ne sait : un module WebAssembly ne peut recevoir un
// `SharedArrayBuffer` que s'il déclare ou importe une mémoire `shared`. Le drapeau de limites le
// dit — bit 0, présence d'un maximum ; **bit 1, mémoire partagée**. C'est ce bit-là, et lui seul,
// qui rendrait l'isolation multi-origine nécessaire au module.

/**
 * Codes de sortie de `npm run isolation:inventaire`, et de la garde de `npm run vm:check` (#75).
 *
 * Les deux commandes partagent cette table à dessein : un même fait — une mémoire partagée dans
 * v86 épinglé — doit rendre le même code, quel que soit l'outil qui le constate.
 */
export const CODES_DE_SORTIE = Object.freeze({
  succes: 0,
  /** Une mémoire partagée a été trouvée : le fait qui porte l'ADR 0010 ne tient plus. */
  memoirePartagee: 2,
  /** Les artefacts étaient exigés et manquent : la garde n'a rien lu, elle ne garde rien. */
  artefactsAbsents: 3,
});

/**
 * Phrase du refus. Elle est ici, et non dans l'un des deux appelants, pour que l'inventaire du
 * spike #41 et la garde de `vm:check` disent exactement la même chose du même fait.
 */
export const VERDICT_MEMOIRE_PARTAGEE =
  "v86 épinglé déclare ou importe une mémoire WebAssembly PARTAGÉE. Le fait qui porte l'ADR 0010 ne tient plus : la décision de ne pas imposer l'isolation multi-origine doit être rouverte.";

/**
 * Entier LEB128 non signé, avec la position d'arrivée.
 *
 * Le garde sur le décalage n'est pas de la superstition : `<<` et `|=` sont des opérateurs 32 bits
 * en JavaScript. Un varuint32 malformé de plus de cinq octets ferait reboucler le décalage modulo
 * 32 et rendrait un nombre plausible tiré d'octets qui n'en sont pas un. Un inventaire dont la
 * conclusion porte une décision d'architecture doit échouer bruyamment plutôt que deviner.
 */
function lireEntier(octets, position) {
  let resultat = 0;
  let decalage = 0;
  let octet;
  do {
    if (position >= octets.length) {
      throw new Error("Entier LEB128 tronqué : fin du module atteinte.");
    }
    if (decalage > 28) {
      throw new Error("Entier LEB128 malformé : plus de cinq octets pour un varuint32.");
    }
    octet = octets[position];
    position += 1;
    resultat |= (octet & 0x7f) << decalage;
    decalage += 7;
  } while (octet & 0x80);
  return { valeur: resultat >>> 0, position };
}

/** Limites d'une mémoire : drapeau, minimum, et maximum lorsqu'il est annoncé. */
function lireLimites(octets, position) {
  if (position >= octets.length) {
    throw new Error("Limites de mémoire tronquées : fin du module atteinte.");
  }
  const drapeaux = octets[position];
  position += 1;
  const minimum = lireEntier(octets, position);
  position = minimum.position;
  let maximum = null;
  if (drapeaux & 0x01) {
    const lu = lireEntier(octets, position);
    maximum = lu.valeur;
    position = lu.position;
  }
  return {
    position,
    limites: {
      drapeaux: `0x${drapeaux.toString(16).padStart(2, "0")}`,
      partagee: Boolean(drapeaux & 0x02),
      pagesMinimum: minimum.valeur,
      pagesMaximum: maximum,
    },
  };
}

const GENRES_IMPORT = Object.freeze({ fonction: 0x00, table: 0x01, memoire: 0x02, global: 0x03 });
const SECTION_IMPORT = 2;
const SECTION_MEMOIRE = 5;

/** `\0asm` puis la version, sur quatre octets chacun. */
const EN_TETE_WASM = Object.freeze([0x00, 0x61, 0x73, 0x6d]);
const VERSION_WASM = Object.freeze([0x01, 0x00, 0x00, 0x00]);

/** Mémoires importées par la section « import », les autres genres étant sautés. */
function lireImports(octets, position) {
  const memoiresImportees = [];
  const entete = lireEntier(octets, position);
  let curseur = entete.position;
  for (let index = 0; index < entete.valeur; index += 1) {
    const module = lireEntier(octets, curseur);
    curseur = module.position + module.valeur;
    const nom = lireEntier(octets, curseur);
    curseur = nom.position + nom.valeur;
    const genre = octets[curseur];
    curseur += 1;
    if (genre === GENRES_IMPORT.memoire) {
      const lu = lireLimites(octets, curseur);
      memoiresImportees.push(lu.limites);
      curseur = lu.position;
    } else if (genre === GENRES_IMPORT.fonction) {
      curseur = lireEntier(octets, curseur).position;
    } else if (genre === GENRES_IMPORT.table) {
      curseur += 1;
      curseur = lireLimites(octets, curseur).position;
    } else if (genre === GENRES_IMPORT.global) {
      curseur += 2;
    } else {
      throw new Error(`Genre d'import inconnu : ${genre}.`);
    }
  }
  return memoiresImportees;
}

/** Mémoires déclarées par la section « memory ». */
function lireMemoires(octets, position) {
  const memoires = [];
  const entete = lireEntier(octets, position);
  let curseur = entete.position;
  for (let index = 0; index < entete.valeur; index += 1) {
    const lu = lireLimites(octets, curseur);
    memoires.push(lu.limites);
    curseur = lu.position;
  }
  return memoires;
}

/**
 * Sections « memory » et « import » d'un module WebAssembly, sans dépendance externe.
 *
 * @param {Uint8Array} octets
 * @returns {{ memoiresDeclarees: object[], memoiresImportees: object[], memoirePartagee: boolean }}
 */
export function analyserWasm(octets) {
  const debute = (attendu, decalage) =>
    attendu.every((valeur, index) => octets[decalage + index] === valeur);
  if (octets.length < 8 || !debute(EN_TETE_WASM, 0)) {
    throw new Error("Le fichier n'est pas un module WebAssembly.");
  }
  if (!debute(VERSION_WASM, 4)) {
    throw new Error(
      "Version de module WebAssembly inattendue : l'analyse des sections n'est pas garantie.",
    );
  }

  let memoiresDeclarees = [];
  let memoiresImportees = [];
  let position = 8;
  while (position < octets.length) {
    const identifiant = octets[position];
    position += 1;
    const taille = lireEntier(octets, position);
    position = taille.position;
    const finSection = position + taille.valeur;

    if (identifiant === SECTION_MEMOIRE) memoiresDeclarees = lireMemoires(octets, position);
    else if (identifiant === SECTION_IMPORT) memoiresImportees = lireImports(octets, position);

    position = finSection;
  }

  // Déclarer et importer sont deux voies vers la même capacité : le verdict porte sur les deux.
  const memoirePartagee = [...memoiresDeclarees, ...memoiresImportees].some(
    (memoire) => memoire.partagee,
  );
  return { memoiresDeclarees, memoiresImportees, memoirePartagee };
}

/**
 * Code de sortie de l'inventaire.
 *
 * L'ADR 0010 affirme qu'« une décision de ne rien faire doit rester falsifiable » et désigne cet
 * outil comme l'instrument de la falsification. Un instrument qui rend toujours zéro ne falsifie
 * rien : le verdict doit donc atteindre le shell, et l'intégration continue.
 *
 * @param {{ v86: { disponible: boolean, wasm?: { memoirePartagee: boolean } }, exigerV86: boolean }} etat
 */
export function codeDeSortie({ v86, exigerV86 }) {
  if (!v86.disponible) {
    return exigerV86 ? CODES_DE_SORTIE.artefactsAbsents : CODES_DE_SORTIE.succes;
  }
  return v86.wasm?.memoirePartagee ? CODES_DE_SORTIE.memoirePartagee : CODES_DE_SORTIE.succes;
}

/**
 * Verdict de garde sur les octets d'un artefact `v86.wasm`, tel que `npm run vm:check` le rend.
 *
 * Le risque résiduel n°2 de l'ADR 0010 dit ce que cette fonction ferme : le fait qui porte la
 * décision est daté — il vaut pour `v86@0.5.432` — et une montée de version l'invaliderait sans
 * aucun autre signal, les empreintes du manifeste ne regardant pas le drapeau de partage.
 *
 * Trois refus, et aucun silence : une mémoire partagée rouvre la décision ; un artefact absent ou
 * illisible n'est pas un succès, parce qu'une garde qui n'a rien lu ne garde rien. L'analyse lève
 * sur un binaire malformé ; ce refus est rendu comme verdict plutôt que propagé, pour que la
 * commande le rapporte à côté de la vérification d'empreinte au lieu de s'interrompre avant elle.
 *
 * @param {Uint8Array | null} octets contenu de l'artefact, ou `null` s'il n'a pas pu être lu
 * @returns {{ statut: "conforme" | "partagee" | "illisible" | "absent",
 *             codeDeSortie: number, message: string, analyse: object | null }}
 */
export function verdictGardeMemoire(octets) {
  if (octets === null || octets === undefined) {
    return {
      statut: "absent",
      codeDeSortie: CODES_DE_SORTIE.artefactsAbsents,
      message:
        "artefact absent : la garde de mémoire partagée (ADR 0010) n'a rien lu. Exécuter « npm run vm:fetch ».",
      analyse: null,
    };
  }

  let analyse;
  try {
    analyse = analyserWasm(octets);
  } catch (erreur) {
    return {
      statut: "illisible",
      codeDeSortie: CODES_DE_SORTIE.artefactsAbsents,
      message: `artefact illisible, garde de mémoire partagée (ADR 0010) inapplicable : ${erreur.message}`,
      analyse: null,
    };
  }

  if (analyse.memoirePartagee) {
    return {
      statut: "partagee",
      codeDeSortie: CODES_DE_SORTIE.memoirePartagee,
      message: VERDICT_MEMOIRE_PARTAGEE,
      analyse,
    };
  }

  return {
    statut: "conforme",
    codeDeSortie: CODES_DE_SORTIE.succes,
    message: decrireMemoires(analyse),
    analyse,
  };
}

/** Ce que la garde a effectivement lu. Un « conforme » muet ne se distingue pas d'un contrôle mort. */
function decrireMemoires({ memoiresDeclarees, memoiresImportees }) {
  const drapeaux = [...memoiresDeclarees, ...memoiresImportees]
    .map((memoire) => memoire.drapeaux)
    .join(", ");
  return (
    `mémoire WebAssembly non partagée — ${memoiresDeclarees.length} déclarée(s), ` +
    `${memoiresImportees.length} importée(s)${drapeaux === "" ? "" : `, drapeaux ${drapeaux}`}`
  );
}
