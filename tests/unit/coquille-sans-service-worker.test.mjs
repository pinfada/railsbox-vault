/**
 * AUCUN SERVICE WORKER sur l'origine de CONFIANCE (#163, ADR 0030, décision 4).
 *
 * La question était ouverte : l'ADR 0010 la posait nommément — « #24 doit dire si un Service Worker
 * injectant COOP est admissible DANS la frontière » —, parce qu'un hébergeur sans en-têtes (GitHub
 * Pages, écarté par l'ADR 0017) laisserait cette porte-là comme seule façon de servir la politique.
 *
 * **Elle est fermée, et le refus est de fond.** Un Service Worker sur l'origine de confiance
 * interposerait du code PRIVILÉGIÉ entre l'hébergeur et la coquille : il verrait passer chaque
 * requête de la coquille, survivrait à la fermeture de l'onglet, et se mettrait à jour par un chemin
 * distinct de celui du reste. La frontière de l'ADR 0002 sépare deux ORIGINES ; elle ne dit rien
 * d'un tiers installé DANS l'une d'elles, et c'est exactement ce que ce refus empêche d'introduire.
 *
 * ## Ce que le balayage parcourt, et pourquoi cette liste-là
 *
 * `SOURCES_COQUILLE` — la table qui décide de ce que l'ARBRE PUBLIÉ contient. Une liste écrite ici
 * aurait divergé de la publication au premier ajout, et elle avait déjà divergé : la première
 * rédaction énumérait quatre fichiers de `public/` et le seul répertoire `src/coquille`, sans
 * récursion. Trois `navigator.serviceWorker.register` réels — dans `src/vm/opfs-block-backend.mjs`,
 * dans un fixture et dans le document applicatif — passaient au vert (constat 4 de la revue de
 * sécurité de la PR #171). `src/vm` est publié ENTIER dans l'arbre `coquille` et importé par le
 * Worker de confiance : il en fait partie, et la table le savait avant l'épreuve.
 *
 * Ce que cette épreuve mesure est donc une ABSENCE, et une absence ne se relit pas — elle se
 * surveille. C'est la forme de `tests/unit/harnais-portes.test.mjs`, dont l'en-tête rappelle qu'« une
 * affirmation que rien ne relit finit toujours par devenir fausse ».
 *
 * Ce qu'elle NE dit PAS : que les Service Workers sont interdits partout. Le territoire APPLICATIF
 * en porte un dans le banc du spike #35 (`public/coquille-epreuve/hostile-sw.mjs`), et c'est son
 * droit : ce que le guest sert lui appartient (ADR 0002). Ce banc n'est pas publié.
 */

import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SOURCES_COQUILLE,
  estPublieParLApplication,
  estPublieParLaCoquille,
} from "../../tools/publier-arborescences.mjs";
import { origineDistincteDuParent } from "../../public/cadre/contrat-du-cadre.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Les appels par lesquels un Service Worker entre dans une origine. Il n'y en a pas d'autre. */
const PORTES = [
  "serviceWorker.register",
  "navigator.serviceWorker",
  "ServiceWorkerContainer",
  "ServiceWorkerRegistration",
];

/** Les extensions qui portent du code. Une licence ou un `.wasm` n'enregistre rien. */
const EXTENSIONS = [".mjs", ".js", ".html"];

/** Une ligne de COMMENTAIRE : ce fichier en écrit, l'ADR 0030 aussi. Ce qui est refusé est un APPEL. */
function estUnAppel(ligne) {
  return !/^\s*(\/\/|\*|<!--|#)/.test(ligne);
}

/** Liste RÉCURSIVEMENT les fichiers de code d'un chemin, qu'il soit fichier ou répertoire. */
async function fichiersDe(relatif) {
  const absolu = path.join(REPO_ROOT, relatif);
  let information;
  try {
    information = await stat(absolu);
  } catch {
    // Une source OPTIONNELLE peut manquer d'un dépôt fraîchement cloné (artefacts v86, image de
    // référence). Son absence n'est pas un défaut de cette épreuve-ci.
    return [];
  }
  if (!information.isDirectory()) {
    return EXTENSIONS.some((extension) => relatif.endsWith(extension)) ? [relatif] : [];
  }
  const trouves = [];
  for (const entree of await readdir(absolu, { withFileTypes: true })) {
    trouves.push(...(await fichiersDe(path.posix.join(relatif, entree.name))));
  }
  return trouves;
}

/**
 * Ce que l'origine de confiance SERT sans le publier : les fixtures et le document applicatif de
 * démonstration, servis par `tools/serve.mjs` depuis la racine `public/`.
 *
 * Ils ne partent dans aucune arborescence — la publication n'emporte que `SOURCES_COQUILLE` —, mais
 * ils s'exécutent sur l'origine de confiance à chaque exécution de la suite navigateur, et un
 * Service Worker enregistré là s'y installerait pour de bon dans le profil qui l'a chargé.
 */
const SERVIS_HORS_PUBLICATION = ["public", "public/coquille-epreuve", "public/cadre"];

/**
 * Les TROIS seuls fichiers exemptés, et le motif est le même pour les trois : ils MESURENT ce qu'un
 * Service Worker applicatif obtient (spike #35, `tests/browser/coquille-frontiere.spec.mjs`). Les
 * balayer ferait rougir l'épreuve sur la mesure qui justifie le refus.
 *
 * Ils sont nommés UN PAR UN plutôt que par un préfixe : `public/coquille-epreuve/` contient aussi
 * les fixtures de COOP, qui n'ont aucune raison d'y échapper, et une exemption par répertoire aurait
 * couvert le prochain fichier qu'on y dépose sans que personne ne le décide.
 */
const BANCS_HOSTILES = [
  "public/coquille-epreuve/hostile-sw.mjs",
  "public/coquille-epreuve/hostile.mjs",
  "public/coquille-epreuve/hostile-topologie.mjs",
];

/**
 * La COQUILLE DE CADRE (#192, ADR 0038) : les trois fichiers qui portent, ou nomment, un Service
 * Worker — et qui n'en installent AUCUN sur l'origine de confiance.
 *
 * Ils sont exemptés du balayage textuel, et remplacés par une surveillance PLUS FORTE, écrite juste
 * en dessous : chacun doit être publié par l'arbre APPLICATIF et par lui seul. Un balayage qui
 * chercherait un mot dans un fichier ne dit rien de l'origine qui le sert ; cette exigence-là, si.
 *
 * Le raisonnement est celui de l'ADR 0002, inchangé : « le document applicatif peut enregistrer un
 * Service Worker sur SA portée », et l'ADR 0030 décision 4 le refuse sur l'origine de CONFIANCE. Une
 * garde de plus tient la promesse à l'exécution, là où une table ne le peut pas :
 * `origineDistincteDuParent` (`public/cadre/contrat-du-cadre.mjs`) refuse d'installer quoi que ce
 * soit quand le document encadré est de MÊME origine que la coquille — c'est-à-dire sous le témoin
 * positif de `tests/browser/coquille-frontiere.spec.mjs`, la seule topologie où l'origine de
 * confiance encadre elle-même le document applicatif.
 */
const COQUILLE_DE_CADRE = [
  "public/service-worker-du-cadre.mjs",
  "public/cadre/courtier-du-cadre.mjs",
  "public/cadre/contrat-du-cadre.mjs",
];

/** Les fichiers de code d'un répertoire, SANS descendre : ses sous-répertoires sont nommés à part. */
async function fichiersDuRang(relatif) {
  const entrees = await readdir(path.join(REPO_ROOT, relatif), { withFileTypes: true });
  return entrees
    .filter((entree) => !entree.isDirectory())
    .map((entree) => path.posix.join(relatif, entree.name))
    .filter((chemin) => EXTENSIONS.some((extension) => chemin.endsWith(extension)));
}

/**
 * Tout ce que l'origine de confiance sert : l'arbre publié, RÉCURSIVEMENT, plus ce qu'elle sert sans
 * le publier. Deux natures, une seule règle.
 */
async function fichiersPublies() {
  const trouves = [];
  for (const { depuis } of SOURCES_COQUILLE) trouves.push(...(await fichiersDe(depuis)));
  for (const rang of SERVIS_HORS_PUBLICATION) trouves.push(...(await fichiersDuRang(rang)));
  return [...new Set(trouves)].filter(
    (chemin) => !BANCS_HOSTILES.includes(chemin) && !COQUILLE_DE_CADRE.includes(chemin),
  );
}

test("le balayage porte sur ce que l'arbre PUBLIÉ contient, et il descend dans les sous-répertoires", async () => {
  const fichiers = await fichiersPublies();
  // Trois témoins nommés, dont un de SOUS-RÉPERTOIRE : sans lui, une liste plate passerait au vert
  // en ne regardant que les fichiers de premier rang — le défaut exact de la première rédaction.
  assert.ok(fichiers.includes("public/main.mjs"), "le module de page est balayé");
  assert.ok(fichiers.includes("src/vm/opfs-block-backend.mjs"), "src/vm est balayé");
  assert.ok(
    fichiers.includes("src/vm/derivation/derivateur-phrase.mjs"),
    "un SOUS-RÉPERTOIRE de src/vm est balayé",
  );
  // Et le banc hostile n'y est PAS : il n'est pas publié, et c'est lui qui mesure ce qu'un Service
  // Worker applicatif obtient. L'inclure ferait rougir l'épreuve sur la mesure qui justifie le refus.
  assert.ok(!fichiers.includes("public/coquille-epreuve/hostile-sw.mjs"));
  // Et ce que l'origine SERT sans le publier y est : les fixtures s'exécutent sur elle à chaque
  // exécution de la suite navigateur, et un Service Worker enregistré là s'installe pour de bon.
  assert.ok(fichiers.includes("public/document-applicatif.mjs"));
  assert.ok(fichiers.includes("public/coquille-epreuve/ouvrante.mjs"));
  // Et la coquille de cadre N'Y EST PAS : elle est exemptée par nom, et surveillée par l'épreuve
  // suivante, qui est plus forte qu'un balayage de mots.
  assert.ok(!fichiers.includes("public/cadre/courtier-du-cadre.mjs"));
  assert.ok(!fichiers.includes("public/service-worker-du-cadre.mjs"));
});

test("la COQUILLE DE CADRE n'est publiée que par l'origine APPLICATIVE", () => {
  // C'est la surveillance qui remplace le balayage pour ces trois fichiers-là, et elle mesure ce
  // qui compte vraiment : non pas « le mot y est-il écrit », mais « quelle origine le sert ». Un
  // Service Worker n'existe que là où quelqu'un le SERT.
  for (const fichier of COQUILLE_DE_CADRE) {
    assert.equal(
      estPublieParLApplication(fichier),
      true,
      `${fichier} n'est publié par aucun arbre : la coquille de cadre serait introuvable en production`,
    );
    assert.equal(
      estPublieParLaCoquille(fichier),
      false,
      `${fichier} est publié par l'origine de CONFIANCE : l'ADR 0030 décision 4 l'interdit`,
    );
  }
});

test("la garde d'installation REFUSE la même origine, et n'accepte que la frontière réelle", () => {
  // Une exemption sans garde serait une porte ouverte. Celle-ci est mesurée sur les trois cas :
  // pas de parent, parent de même origine, parent inaccessible (donc d'une autre origine).
  const sansParent = { location: { origin: "https://app.exemple" } };
  sansParent.parent = sansParent;
  assert.equal(
    origineDistincteDuParent(sansParent),
    false,
    "un document de premier rang n'encadre rien",
  );

  const memeOrigine = {
    location: { origin: "https://exemple" },
    parent: { location: { origin: "https://exemple" } },
  };
  assert.equal(origineDistincteDuParent(memeOrigine), false, "le témoin positif n'installe rien");

  const interOrigine = {
    location: { origin: "https://app.exemple" },
    get parent() {
      return {
        get location() {
          throw new DOMException("cross-origin", "SecurityError");
        },
      };
    },
  };
  assert.equal(
    origineDistincteDuParent(interOrigine),
    true,
    "une lecture qui JETTE est la preuve que les origines diffèrent — et c'est le navigateur qui le dit",
  );
});

test("aucun module publié par l'origine de confiance n'installe de Service Worker", async () => {
  const fautifs = [];
  for (const chemin of await fichiersPublies()) {
    const contenu = await readFile(path.join(REPO_ROOT, chemin), "utf8");
    for (const porte of PORTES) {
      const appels = contenu
        .split("\n")
        .filter((ligne) => ligne.includes(porte) && estUnAppel(ligne));
      if (appels.length > 0) fautifs.push(`${chemin} › ${porte}`);
    }
  }
  assert.deepEqual(
    fautifs,
    [],
    "Un Service Worker sur l'origine de confiance est INADMISSIBLE (ADR 0030, décision 4).",
  );
});

test("le balayage MORD : il reconnaît un enregistrement qu'on lui présente, et pas un commentaire", () => {
  // Un balayage à vide passe toujours. Celui-ci est confronté au texte qu'il doit refuser, et au
  // même texte en commentaire — sans quoi rien ne dirait qu'il sait faire la différence.
  const appel = 'navigator.serviceWorker.register("/sw.mjs");';
  assert.equal(estUnAppel(appel), true);
  assert.equal(estUnAppel(`// ${appel}`), false);
  assert.equal(estUnAppel(` * ${appel}`), false);
  assert.ok(PORTES.some((porte) => appel.includes(porte)));
});

test("le refus est ÉCRIT là où un relecteur le cherchera", async () => {
  // Une décision qui ne vit que dans une épreuve est une décision qu'on redécouvre. Elle est dans
  // l'ADR de la tranche et dans `SECURITY.md`, et cette ligne-ci refuse qu'elle en disparaisse.
  const adr = await readFile(
    path.join(REPO_ROOT, "docs/decisions/0030-cycle-de-vie-assemble-dans-la-coquille.md"),
    "utf8",
  );
  assert.match(adr, /Service Worker/);
  assert.match(adr, /INADMISSIBLE|inadmissible/);
  const securite = await readFile(path.join(REPO_ROOT, "SECURITY.md"), "utf8");
  assert.match(securite, /Aucun Service Worker sur l'origine de confiance/);
});

test("le DESCRIPTEUR d'application est déclaré dans l'arbre publié, et il ne peut pas en sortir", async () => {
  // Sans cette ligne, la coquille PUBLIÉE recevrait un 404 sur son descripteur et se déclarerait
  // `applicationAbsente` en production — un cas que `publier:check` ne verrait pas, puisqu'il
  // tolère l'arbre incomplet. Le relecteur l'a relevé à côté du vert par vacuité de la CI.
  const declares = SOURCES_COQUILLE.map(({ depuis }) => depuis);
  assert.ok(declares.includes("artifacts/application.json"), "le descripteur est publié");
  // Ce qu'il NOMME n'y est PAS, et c'est écrit : 926 Mio d'artefacts feraient passer `npm run check`
  // de deux minutes à des dizaines, puisque la chaîne recopie et hache tout ce qu'elle émet. Les
  // déposer sur l'origine de confiance est une obligation d'exploitant (#124–#126), et la
  // conséquence — une coquille publiée qui échoue à l'installation plutôt qu'à la lecture — est
  // nommée dans l'ADR 0030 § Limites.
  assert.ok(!declares.includes("artifacts/reference-image"));
});
