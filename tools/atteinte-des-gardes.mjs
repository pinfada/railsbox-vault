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

/**
 * Le texte SANS ses commentaires ni ses littéraux de chaîne : un nom cité dans un commentaire ou un message n'est pas
 * un appel. Approximation (pas de gestion des gabarits imbriqués), suffisante pour des noms de fonctions.
 */
function sansCommentairesNiChaines(texte) {
  return texte
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) =>
      m.replace(/[^\n]/g, " "),
    );
}

function modules(dossier) {
  return readdirSync(join(RACINE, dossier)).flatMap((nom) => {
    const chemin = `${dossier}/${nom}`;
    if (statSync(join(RACINE, chemin)).isDirectory()) return modules(chemin);
    return chemin.endsWith(".mjs") ? [chemin] : [];
  });
}

/**
 * Les fichiers de `public/` que le PRODUIT charge : les Workers de confiance, la page, la coquille, le cadre et le
 * relais. Les pages d'épreuve et de spike (`public/coquille-epreuve/`, `public/spike/`, `public/csp/`, `public/vm/`) n'en
 * font pas partie : un nom qu'elles emploient n'est pas un appel du produit.
 */
function estUnPointDEntreeDuProduit(chemin) {
  return (
    /^public\/(runtime-worker|runtime-worker-deverrouillage|relais-du-worker|main|document-applicatif|derivation-worker)\.mjs$/.test(
      chemin,
    ) || /^public\/(coquille|cadre)\//.test(chemin)
  );
}

/** Le graphe des déclarations de premier niveau, et les noms que le code de `public/` emploie. */
function graphe() {
  const fichiers = [...modules("src"), ...modules("public")];
  const texte = Object.fromEntries(
    fichiers.map((p) => [p, sansCommentairesNiChaines(readFileSync(join(RACINE, p), "utf8"))]),
  );
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
  // Un nom n'est visible d'un fichier que s'il y est DÉCLARÉ ou IMPORTÉ : c'est ce qui écarte les homonymes.
  const visibles = Object.fromEntries(
    Object.entries(texte).map(([fichier, t]) => {
      const noms = new Set();
      for (const m of t.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
        for (const partie of m[1].split(",")) {
          const nom = partie.trim().split(/\s+as\s+/)[0];
          if (nom !== "") noms.add(nom);
        }
      }
      // `import * as accueil` : les noms visibles sont ceux que le fichier emploie sous `accueil.nom`.
      for (const m of t.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
        for (const usage of t.matchAll(
          new RegExp(`\\b${m[1]}\\.([A-Za-z_$][A-Za-z0-9_$]*)`, "g"),
        )) {
          noms.add(usage[1]);
        }
      }
      for (const [nom, lieux] of declarations) {
        if (lieux.some((l) => l.fichier === fichier)) noms.add(nom);
      }
      return [fichier, noms];
    }),
  );
  const aretes = new Map();
  for (const [nom, lieux] of declarations) {
    const voisins = new Set();
    for (const { fichier, d, f } of lieux) {
      for (const id of texte[fichier].slice(d, f).matchAll(IDENT)) {
        if (id[0] !== nom && declarations.has(id[0]) && visibles[fichier].has(id[0])) {
          voisins.add(id[0]);
        }
      }
    }
    aretes.set(nom, voisins);
  }
  const racines = new Map();
  for (const fichier of fichiers.filter(estUnPointDEntreeDuProduit)) {
    for (const id of texte[fichier].matchAll(IDENT)) {
      if (declarations.has(id[0]) && visibles[fichier].has(id[0]) && !racines.has(id[0])) {
        racines.set(id[0], fichier);
      }
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
    const position = readFileSync(join(RACINE, fichier), "utf8").indexOf(avant);
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
