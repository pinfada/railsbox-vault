/**
 * Le CLIQUET des conduites du parcours (#193, ADR 0040 ; revue de la PR #213, constats 4, 5, 9 et 11).
 *
 * Les codes sont énumérés PAR CONSTRUCTION, depuis les tables exportées de chaque famille — coquille,
 * stockage, enveloppe, dérivation, archive, import — et jamais depuis une liste recopiée. Chacun est
 * soit sur le chemin, avec sa conduite et son classement, soit écarté par un motif « inatteignable
 * depuis le parcours parce que … ». Tout texte montré à la personne — écrans, messages, conduites — se
 * lit sans vocabulaire interne, et le filtre MORD. Un code neuf qui n'entre dans aucune des deux listes
 * rougit ici : c'est la forme du cliquet du § 10 (`dossier-de-revue.test.mjs`).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ARCHIVE_ERROR_CODES } from "../../src/vm/archive-errors.mjs";
import { DERIVATION_ERROR_CODES } from "../../src/vm/derivation/derivation-errors.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { IMPORT_ERROR_CODES } from "../../src/vm/import-errors.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";
import { CONDUITES, ancreSaisie } from "../../src/coquille/interface-de-deverrouillage.mjs";
import { CONDUITES_DE_PORTABILITE } from "../../src/coquille/gestes-de-portabilite.mjs";
import { TOUS_LES_CODES_DE_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import {
  CLASSEMENT_DES_CONDUITES,
  CLASSES_DE_CONDUITE,
  CODES_DU_CHEMIN,
  CODES_HORS_DU_CHEMIN,
  CONDUITES_DU_PARCOURS,
  CONDUITE_GENERIQUE,
  REFUS_SANS_CODE,
  TOUS_LES_CODES_DU_CHEMIN,
  conduiteDUnRefusSansCode,
  conduiteHumaine,
} from "../../src/coquille/conduites-du-parcours.mjs";
import {
  ECRANS,
  LIMITE_DE_FIREFOX,
  MESSAGES,
  REFUS_D_INVENTAIRE,
  STATUTS,
  texteDAttenteDeLaPhrase,
} from "../../src/coquille/parcours.mjs";

const lire = (chemin) => readFile(new URL(`../../${chemin}`, import.meta.url), "utf8");

/** Les huit gestes du chemin que la DoR nomme, et aucun autre. */
const GESTES = [
  "deverrouillage",
  "cycle",
  "relais",
  "installationInterrompue",
  "verrouillage",
  "sauvegarde",
  "restauration",
  "revocation",
];

/** Les FAMILLES de codes, lues de leurs tables exportées : c'est la construction du cliquet. */
const FAMILLES = Object.freeze({
  coquille: TOUS_LES_CODES_DE_COQUILLE,
  stockage: Object.values(STORAGE_ERROR_CODES),
  enveloppe: Object.values(ENVELOPPE_ERROR_CODES),
  derivation: Object.values(DERIVATION_ERROR_CODES),
  archive: Object.values(ARCHIVE_ERROR_CODES),
  import: Object.values(IMPORT_ERROR_CODES),
});

const TOUS_LES_CODES_CONNUS = new Set(Object.values(FAMILLES).flat());

/**
 * Ce qu'un texte pour une personne ne porte jamais : un numéro d'issue, un nom de fichier, un code, le
 * vocabulaire du format (« voisin », « racine », « enveloppe », « secteur », « génération »,
 * « plancher », « rejeu », « sceau »), ou celui du moteur (« Worker », « OPFS », « guest », « VM »,
 * « dérivation », « coquille »). Relue avec la revue de la PR #213 (constat 11).
 */
const VOCABULAIRE_INTERNE = [
  /#\d/,
  /\.(mjs|md|json|html)\b/,
  /\bvoisins?\b/i,
  /\bracines?\b/i,
  /VAULT_/,
  /\bWorker\b/i,
  /\bOPFS\b/,
  /\bKEK\b|\bDEK\b/,
  /\bhandle\b/i,
  /\benveloppes?\b/i,
  /\bmanifeste\b/i,
  /\bADR\b/,
  /\bcoquille\b/i,
  /\bguest\b|\bVM\b/,
  /\bsecteurs?\b/i,
  /g[ée]n[ée]rations?\b/i,
  /\bplancher\b/i,
  /\brejeu\b/i,
  /\bsceaux?\b/i,
  /\bd[ée]rivations?\b/i,
  /\bvolumes?\b/i,
  /\bquiesc/i,
];

/** Tous les textes que le parcours montre, un par un, avec leur provenance. */
function textesMontres() {
  const textes = [];
  for (const [id, ecran] of Object.entries(ECRANS)) {
    for (const champ of ["titre", "ceQuiVaSePasser", "attendu", "attente"]) {
      if (ecran[champ] !== null) textes.push([`ECRANS.${id}.${champ}`, ecran[champ]]);
    }
  }
  for (const [nom, message] of Object.entries(MESSAGES)) {
    const texte = typeof message === "function" ? message("N", "N") : message;
    textes.push([`MESSAGES.${nom}`, texte]);
  }
  for (const [nom, statut] of Object.entries(STATUTS)) textes.push([`STATUTS.${nom}`, statut]);
  for (const [code, conduite] of Object.entries(CONDUITES_DU_PARCOURS))
    textes.push([code, conduite]);
  for (const [nom, { conduite }] of Object.entries(REFUS_SANS_CODE)) {
    textes.push([`REFUS_SANS_CODE.${nom}`, conduite]);
  }
  textes.push(["LIMITE_DE_FIREFOX", LIMITE_DE_FIREFOX]);
  textes.push(["CONDUITE_GENERIQUE", CONDUITE_GENERIQUE]);
  textes.push(["attente de la phrase", texteDAttenteDeLaPhrase("N")]);
  return textes;
}

test("le chemin couvre les huit gestes de la DoR, et chacun a au moins un code", () => {
  assert.deepEqual(Object.keys(CODES_DU_CHEMIN).sort(), [...GESTES].sort());
  for (const geste of GESTES) assert.ok(CODES_DU_CHEMIN[geste].length > 0, geste);
});

test("chaque code du chemin est un VRAI code du dépôt : une faute de frappe ne passe pas", () => {
  for (const code of TOUS_LES_CODES_DU_CHEMIN) {
    assert.ok(TOUS_LES_CODES_CONNUS.has(code), `${code} n'existe dans aucune table de codes`);
  }
  for (const code of Object.keys(CODES_HORS_DU_CHEMIN)) {
    assert.ok(TOUS_LES_CODES_CONNUS.has(code), `${code} (hors du chemin) n'existe pas`);
  }
});

test("CLIQUET PAR CONSTRUCTION : chaque code de chaque famille est sur le chemin ou écarté avec son motif", () => {
  for (const [famille, codes] of Object.entries(FAMILLES)) {
    assert.ok(codes.length > 0, `${famille} : la table exportée est vide`);
    const nonClasses = codes.filter(
      (code) => !TOUS_LES_CODES_DU_CHEMIN.includes(code) && !(code in CODES_HORS_DU_CHEMIN),
    );
    assert.deepEqual(
      nonClasses,
      [],
      `${famille} : un code neuf doit entrer dans le chemin ou en être écarté`,
    );
  }
  const lesDeux = Object.keys(CODES_HORS_DU_CHEMIN).filter((code) =>
    TOUS_LES_CODES_DU_CHEMIN.includes(code),
  );
  assert.deepEqual(lesDeux, [], "un code ne peut pas être à la fois sur le chemin et écarté");
  for (const [code, motif] of Object.entries(CODES_HORS_DU_CHEMIN)) {
    const trouve = /^inatteignable depuis le parcours parce que (.{15,})$/.exec(motif);
    assert.ok(trouve !== null, `${code} : l'exclusion dit POURQUOI elle est inatteignable`);
  }
});

test("CLIQUET : chaque code du chemin a une conduite écrite pour une personne, et un classement", () => {
  const sansConduite = TOUS_LES_CODES_DU_CHEMIN.filter((code) => !(code in CONDUITES_DU_PARCOURS));
  assert.deepEqual(sansConduite, []);
  const classes = Object.values(CLASSES_DE_CONDUITE);
  for (const code of TOUS_LES_CODES_DU_CHEMIN) {
    assert.ok(classes.includes(CLASSEMENT_DES_CONDUITES[code]), `${code} : classement`);
  }
  for (const [nom, refus] of Object.entries(REFUS_SANS_CODE)) {
    assert.ok(classes.includes(refus.classe), `${nom} : classement`);
  }
});

test("aucune conduite orpheline : chaque conduite sert un code du chemin", () => {
  const orphelines = Object.keys(CONDUITES_DU_PARCOURS).filter(
    (code) => !TOUS_LES_CODES_DU_CHEMIN.includes(code),
  );
  assert.deepEqual(orphelines, []);
});

test("CLIQUET : les conduites que la coquille avait déjà écrites sont toutes sur le chemin", () => {
  for (const code of [...Object.keys(CONDUITES), ...Object.keys(CONDUITES_DE_PORTABILITE)]) {
    assert.ok(
      TOUS_LES_CODES_DU_CHEMIN.includes(code),
      `${code} a une conduite technique, pas humaine`,
    );
  }
  for (const code of REFUS_D_INVENTAIRE) {
    assert.ok(CODES_DU_CHEMIN.deverrouillage.includes(code), `${code} : refus d'inventaire`);
  }
});

test("CONSTAT 11 : tout texte montré à la personne se lit sans vocabulaire interne", () => {
  const fautes = [];
  for (const [provenance, texte] of textesMontres()) {
    for (const motif of VOCABULAIRE_INTERNE) {
      if (motif.test(texte)) fautes.push(`${provenance} : ${motif}`);
    }
  }
  assert.deepEqual(fautes, []);
});

test("le filtre du vocabulaire MORD : il reconnaît ce qu'il doit refuser", () => {
  const exemples = [
    "voir #193",
    "le fichier parcours.mjs",
    "un voisin orphelin",
    "la racine initiale",
    "VAULT_ENVELOPPE_REJEU",
    "le Worker de confiance",
    "l'enveloppe de clés",
    "la coquille refuse",
    "un secteur de la génération est refusé",
    "le plancher de rejeu",
    "le sceau refusé",
    "la dérivation calcule",
    "le volume est incomplet",
  ];
  for (const exemple of exemples) {
    assert.ok(
      VOCABULAIRE_INTERNE.some((motif) => motif.test(exemple)),
      `le filtre laisse passer « ${exemple} »`,
    );
  }
  // Chaque mot nommé par la revue mord SEUL : un filtre qui ne mordrait qu'en groupe se tromperait.
  for (const mot of ["secteur", "génération", "generation", "Worker", "coquille"]) {
    assert.ok(
      VOCABULAIRE_INTERNE.some((motif) => motif.test(`un ${mot} ici`)),
      mot,
    );
  }
  assert.ok(!VOCABULAIRE_INTERNE.some((motif) => motif.test("Rien n'a été perdu.")));
});

test("CONSTAT 5 : un refus sans code reçoit une conduite humaine, jamais le texte technique", () => {
  const ancre = ancreSaisie("abc").aveu;
  assert.ok(ancre.startsWith(REFUS_SANS_CODE.versionMalTapee.source), "la source a dérivé");
  assert.equal(conduiteDUnRefusSansCode(ancre), REFUS_SANS_CODE.versionMalTapee.conduite);
  assert.doesNotMatch(conduiteDUnRefusSansCode(ancre), /coquille/);
  assert.equal(conduiteDUnRefusSansCode("un texte que personne n'a prévu"), CONDUITE_GENERIQUE);
  assert.equal(conduiteDUnRefusSansCode(""), CONDUITE_GENERIQUE);
});

test("CONSTAT 5 : les textes reconnus sont toujours ceux que les modules écrivent", async () => {
  const portabilite = await lire("src/coquille/gestes-de-portabilite.mjs");
  assert.ok(portabilite.includes(`"${REFUS_SANS_CODE.archiveNonChoisie.source}"`));
  assert.equal(
    conduiteDUnRefusSansCode(REFUS_SANS_CODE.archiveNonChoisie.source),
    REFUS_SANS_CODE.archiveNonChoisie.conduite,
  );
});

test("CONSTAT 9 : aucune conduite n'envoie vers Firefox", () => {
  for (const [provenance, texte] of textesMontres()) {
    if (provenance === "LIMITE_DE_FIREFOX" || provenance.startsWith("ECRANS.travailler-sans"))
      continue;
    assert.doesNotMatch(texte, /Firefox/, provenance);
  }
});

test("un code inconnu n'invente pas de conduite : il renvoie au détail technique", () => {
  assert.equal(conduiteHumaine("VAULT_INEXISTANT"), CONDUITE_GENERIQUE);
  assert.match(conduiteHumaine(null), /détail technique/);
  assert.equal(
    conduiteHumaine(ENVELOPPE_ERROR_CODES.cleRefusee),
    CONDUITES_DU_PARCOURS[ENVELOPPE_ERROR_CODES.cleRefusee],
  );
  assert.equal(
    conduiteHumaine(STORAGE_ERROR_CODES.geometryMismatch),
    CONDUITES_DU_PARCOURS[STORAGE_ERROR_CODES.geometryMismatch],
    "un code du stockage remonté par le démarrage a SA conduite (constat 4)",
  );
});

test("les trois échecs les plus probables ont la conduite que l'E2E attend", () => {
  assert.match(conduiteHumaine(ENVELOPPE_ERROR_CODES.cleRefusee), /n'ouvre pas ce coffre/);
  assert.match(conduiteHumaine(DERIVATION_ERROR_CODES.codeMalRecopie), /faute de recopie/);
  assert.match(conduiteHumaine(ARCHIVE_ERROR_CODES.digestMismatch), /abîmée ou modifiée/);
});

test("un code déjà rendu dit qu'un NOUVEAU est possible, et que l'ancien reste valable (#214)", () => {
  // L'épreuve disait l'inverse jusqu'à #214, et elle avait raison de le dire : un second « créer »
  // posait alors un emplacement que l'ouverture ne savait pas essayer, si bien que le code promis
  // était refusé. L'ouverture les essaie tous ; la phrase redevient VRAIE, et elle est due.
  const conduite = conduiteHumaine(DERIVATION_ERROR_CODES.codeDejaRendu);
  assert.match(conduite, /NOUVEAU code/);
  assert.match(conduite, /tant que personne ne le retire/);
});
