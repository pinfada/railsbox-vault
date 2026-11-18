// L'ATTEINTE des gardes mutées : chaque mutant porte-t-il sur du code que le PRODUIT exécute ? (#247, D1g ;
// revue de #298, second tour, constat 2.)
//
// Une campagne de mutation prouve qu'une épreuve rougit quand on retire une garde — pas que la garde est celle du
// chemin de production. Le mutant de « la réserve complète » portait sur `reserveTientTout`, que seule une épreuve
// appelait : le boot recalculait la condition ailleurs, et la campagne comptait un mutant tué sans rien dire du boot.
//
// Ce module relève, pour chaque mutation, la déclaration de premier niveau qui contient le texte retiré, puis cherche
// un CHEMIN d'appel depuis le code que le navigateur charge (`public/`) jusqu'à elle, dans le graphe des
// déclarations de `src/` et `public/` (arête A → B : le nom B figure dans le texte de A). C'est une approximation par
// les NOMS : elle écarte les gardes que seul un test appelle, pas celles qu'un appel mal câblé laisserait inertes.
// Les mutations d'un fichier de `tools/` (la fabrication du descripteur) relèvent de l'outil `image:manifest`, pas du
// navigateur : elles sont rendues à part.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("../", import.meta.url));
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;

function modules(dossier) {
  return readdirSync(join(RACINE, dossier)).flatMap((nom) => {
    const chemin = `${dossier}/${nom}`;
    if (statSync(join(RACINE, chemin)).isDirectory()) return modules(chemin);
    return chemin.endsWith(".mjs") ? [chemin] : [];
  });
}

/** Le graphe des déclarations de premier niveau, et les noms que le code de `public/` emploie. */
function graphe() {
  const fichiers = [...modules("src"), ...modules("public")];
  const texte = Object.fromEntries(fichiers.map((p) => [p, readFileSync(join(RACINE, p), "utf8")]));
  const declarations = new Map();
  const debut =
    /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z0-9_$]+)|const\s+([A-Za-z0-9_$]+)\s*=|class\s+([A-Za-z0-9_$]+))/gm;
  for (const [fichier, t] of Object.entries(texte)) {
    const positions = [...t.matchAll(debut)].map((m) => [m[1] ?? m[2] ?? m[3], m.index]);
    positions.forEach(([nom, d], i) => {
      const f = i + 1 < positions.length ? positions[i + 1][1] : t.length;
      if (!declarations.has(nom)) declarations.set(nom, []);
      declarations.get(nom).push({ fichier, d, f });
    });
  }
  const aretes = new Map();
  for (const [nom, lieux] of declarations) {
    const voisins = new Set();
    for (const { fichier, d, f } of lieux) {
      for (const id of texte[fichier].slice(d, f).matchAll(IDENT)) {
        if (id[0] !== nom && declarations.has(id[0])) voisins.add(id[0]);
      }
    }
    aretes.set(nom, voisins);
  }
  const racines = new Map();
  for (const fichier of fichiers.filter((p) => p.startsWith("public/"))) {
    for (const id of texte[fichier].matchAll(IDENT)) {
      if (declarations.has(id[0]) && !racines.has(id[0])) racines.set(id[0], fichier);
    }
  }
  const pere = new Map([...racines.keys()].map((nom) => [nom, null]));
  const file = [...pere.keys()];
  while (file.length > 0) {
    const nom = file.shift();
    for (const voisin of aretes.get(nom) ?? []) {
      if (!pere.has(voisin)) {
        pere.set(voisin, nom);
        file.push(voisin);
      }
    }
  }
  return { declarations, racines, pere };
}

/**
 * @param {{ fichier: string, avant: string }[]} mutations
 * @returns {{ statut: "atteint" | "outil" | "inerte", declaration: string | null, chemin: string }[]}
 */
export function atteinteDesMutations(mutations) {
  const { declarations, racines, pere } = graphe();
  return mutations.map(({ fichier, avant }) => {
    if (fichier.startsWith("tools/"))
      return { statut: "outil", declaration: null, chemin: fichier };
    const t = readFileSync(join(RACINE, fichier), "utf8");
    const position = t.indexOf(avant);
    let declaration = null;
    for (const [nom, lieux] of declarations) {
      if (lieux.some((l) => l.fichier === fichier && l.d <= position && position < l.f)) {
        declaration = nom;
      }
    }
    if (declaration === null || !pere.has(declaration)) {
      return { statut: "inerte", declaration, chemin: "" };
    }
    const chaine = [];
    for (let nom = declaration; nom !== null; nom = pere.get(nom)) chaine.unshift(nom);
    return {
      statut: "atteint",
      declaration,
      chemin: `${racines.get(chaine[0])} → ${chaine.join(" → ")}`,
    };
  });
}
