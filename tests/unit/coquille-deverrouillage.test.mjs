/**
 * Les GARDES du déverrouillage dans la coquille (#162, ADR 0029).
 *
 * Ce que cette suite mesure, et que le navigateur ne mesure pas : les décisions PURES — l'annonce
 * d'attente et sa table, le contrôle en direct de la saisie, l'ancre de version et son aveu, la
 * feuille, la lecture de l'inventaire, et la seule dérogation à `sansCapacite`. Elles vivent dans
 * `src/coquille/` précisément pour cela : une garde écrite dans `public/main.mjs` ne serait
 * éprouvable que par un moteur, donc jamais par la campagne de mutation.
 *
 * Ce qu'elle ne mesure PAS, et qui relève de `tests/browser/coquille-deverrouillage.spec.mjs` :
 * qu'Argon2id calcule, que l'OPFS réponde, que la passkey existe, et que rien du secret ne se
 * dépose. Les deux se complètent — l'une dit que la décision sait rougir, l'autre qu'elle porte sur
 * quelque chose.
 *
 * Ce qu'elle ne lit PAS non plus : `docs/`. Les cliquets qui confrontent le code à un document
 * vivent dans `coquille-deverrouillage-dossier.test.mjs`, et la séparation est ce qui rend CE
 * fichier rejouable par la campagne de mutation — dont l'atelier ne recopie ni `docs/`, ni
 * `SECURITY.md`, ni `README.md`. Une épreuve qui y échouerait ferait rendre NON APPLICABLE à
 * toutes les gardes qu'elle accompagne.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ATTENTE_MESUREE,
  MOTEURS_MESURES,
  MOTEUR_PAR_DEFAUT,
  MOYENS_ANNONCES,
  TEXTE_EN_COURS,
  annonceDAttente,
  moteurProbable,
} from "../../src/coquille/attente-annoncee.mjs";
import {
  CHAMP_DE_LA_KEK,
  CONTRAT_COQUILLE,
  REPONSES_PRIVILEGIEES,
  TYPES_APPLICATIFS,
  TYPES_PRIVILEGIES,
  enveloppeDeMessage,
  enveloppePrivilegiee,
} from "../../src/coquille/contrat-de-messages.mjs";
import {
  AVERTISSEMENT_SANS_RECUPERATION,
  AVEU_SANS_ANCRE,
  REPLI_DU_REJEU,
  TEXTE_TROP_ANCIEN,
  ancreOpposee,
  feuilleDeRecuperation,
  versionANoter,
} from "../../src/coquille/feuille-de-recuperation.mjs";
import {
  CONDUITES,
  ancreSaisie,
  conduiteDeRefus,
} from "../../src/coquille/interface-de-deverrouillage.mjs";
import {
  MOYENS_SERVIS,
  NOMS_SERVIS,
  exigerKekDeLaPage,
  moyenParNom,
  moyensProposes,
} from "../../src/coquille/moyens-de-deverrouillage.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { VERDICTS, decouper, etatDeLaSaisie } from "../../src/coquille/saisie-du-code.mjs";
import {
  SYMBOLES_TOTAL,
  encoderCode,
  tirerCodeDeRecuperation,
} from "../../src/vm/derivation/code-de-recuperation.mjs";
import { DERIVATION_ERROR_CODES } from "../../src/vm/derivation/derivation-errors.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function lire(relatif) {
  return readFile(path.join(REPO_ROOT, relatif), "utf8");
}

/** Un code VALIDE, tiré par le produit. Il n'est écrit nulle part, comme dans le produit. */
function unCode() {
  return encoderCode(tirerCodeDeRecuperation());
}

/** Une `CryptoKey` de forme, sans WebCrypto : la garde regarde le CONSTRUCTEUR et `extractable`. */
function fausseCle({ extractable }) {
  class CryptoKey {
    constructor() {
      this.extractable = extractable;
      this.type = "secret";
    }
  }
  return new CryptoKey();
}

// --- L'attente annoncée -----------------------------------------------------------------------

test("le moteur le plus lent est celui du DÉFAUT : un inconnu n'est jamais annoncé optimiste", () => {
  const pires = Object.entries(ATTENTE_MESUREE).map(([moteur, mesure]) => [
    moteur,
    Math.max(...mesure.p95Ms),
  ]);
  const leplusLent = pires.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  assert.equal(
    MOTEUR_PAR_DEFAUT,
    leplusLent,
    "annoncer l'attente du moteur le plus RAPIDE à un moteur inconnu ferait passer une attente réelle pour une panne.",
  );
});

test("la détection de moteur ne prend pas un Chromium pour un WebKit", () => {
  // L'erreur classique : Chromium porte « Safari/537.36 » dans son agent, et un test qui chercherait
  // Safari d'abord annoncerait 458 ms là où il en faut 446. Elle ne casse rien — c'est un nombre
  // affiché — mais elle ferait mentir une annonce qui se veut mesurée.
  const chrome =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
  const safari =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15";
  const firefox =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0";
  assert.equal(moteurProbable(chrome), "chromium");
  assert.equal(moteurProbable(safari), "webkit");
  assert.equal(moteurProbable(firefox), "firefox");
  assert.equal(moteurProbable(undefined), MOTEUR_PAR_DEFAUT);
  assert.equal(moteurProbable("un agent que personne ne connaît"), MOTEUR_PAR_DEFAUT);
});

test("SEULE la phrase annonce une attente ; le code et la passkey n'annoncent rien", () => {
  assert.deepEqual([...MOYENS_ANNONCES], ["phrase"]);
  for (const moyen of ["recuperation", "webauthn-prf"]) {
    assert.equal(
      annonceDAttente({ moyen, moteur: "firefox" }),
      null,
      `${moyen} coûte des millisecondes : annoncer une attente qui n'existe pas dilue celle qui compte.`,
    );
  }
  const annonce = annonceDAttente({ moyen: "phrase", moteur: "firefox" });
  assert.equal(annonce.attenteMs, 2207);
  assert.match(annonce.texte, /2\.2 seconde/);
  assert.match(TEXTE_EN_COURS, /en cours/i);
});

test("l'annonce retient le p95 le plus HAUT des deux exécutions, jamais le p50", () => {
  // Annoncer une médiane est faux une fois sur deux, et toujours dans le sens qui déçoit : la
  // moitié des ouvertures dureraient plus longtemps que ce que la coquille vient de promettre.
  for (const moteur of MOTEURS_MESURES) {
    const annonce = annonceDAttente({ moyen: "phrase", moteur });
    assert.equal(annonce.attenteMs, Math.max(...ATTENTE_MESUREE[moteur].p95Ms));
    assert.ok(annonce.attenteMs > Math.max(...ATTENTE_MESUREE[moteur].p50Ms));
  }
});

test("un moteur inconnu retombe sur le défaut, et emploie SES nombres", () => {
  // La campagne de mutation a fait survivre un mutant ici, et le service qu'elle rend est celui-là :
  // l'épreuve ne vérifiait que le NOM rendu, si bien que remplacer le repli par le moteur le plus
  // RAPIDE la laissait verte — la coquille aurait annoncé « firefox » en affichant les 446 ms de
  // Chromium. Le nom et les nombres viennent de deux expressions distinctes ; les deux sont
  // désormais confrontés.
  const annonce = annonceDAttente({ moyen: "phrase", moteur: "un-moteur-de-2030" });
  assert.equal(annonce.moteur, MOTEUR_PAR_DEFAUT);
  assert.equal(annonce.attenteMs, Math.max(...ATTENTE_MESUREE[MOTEUR_PAR_DEFAUT].p95Ms));
  assert.match(annonce.texte, /2\.2 seconde/);
});

// --- Le contrôle EN DIRECT de la saisie du code -------------------------------------------------

test("un code complet et cohérent est ENVOYABLE ; rien d'autre ne l'est", () => {
  const code = unCode();
  const etat = etatDeLaSaisie(code);
  assert.equal(etat.verdict, VERDICTS.pret);
  assert.equal(etat.envoyable, true);
  assert.equal(etat.decoupe, code, "la découpe doit rendre exactement ce que le produit a écrit.");
});

test("l'AIDE À LA SAISIE ramène une forme humaine sur la forme du produit", () => {
  // Minuscules, espaces au lieu des tirets, « o » et « l » pour les chiffres qu'ils imitent : ce
  // qu'un utilisateur retape d'une feuille de papier. La découpe lui rend ce que le produit avait
  // écrit — voir la différence est plus utile que lire une règle de saisie.
  const code = unCode();
  const humain = code.toLowerCase().replaceAll("-", " ").replaceAll("0", "o").replaceAll("1", "l");
  const etat = etatDeLaSaisie(humain);
  assert.equal(etat.envoyable, true);
  assert.equal(etat.decoupe, code);
});

test("une saisie INCOMPLÈTE n'est pas un refus : elle dit où l'on en est", () => {
  const code = unCode();
  const etat = etatDeLaSaisie(code.slice(0, 9));
  assert.equal(etat.verdict, VERDICTS.incomplet);
  assert.equal(etat.envoyable, false);
  assert.equal(etat.code, null, "un refus à chaque frappe n'est plus lu au troisième code.");
  assert.match(etat.message, /sur 28/);
});

test("une somme de contrôle FAUSSE ferme l'envoi, sous son code, AVANT toute dérivation", () => {
  const code = unCode();
  const dernier = code.at(-1) === "0" ? "1" : "0";
  const etat = etatDeLaSaisie(`${code.slice(0, -1)}${dernier}`);
  assert.equal(etat.verdict, VERDICTS.malRecopie);
  assert.equal(etat.envoyable, false);
  assert.equal(etat.code, DERIVATION_ERROR_CODES.codeMalRecopie);
  assert.notEqual(
    etat.code,
    ENVELOPPE_ERROR_CODES.cleRefusee,
    "« mal recopié » et « clé refusée » n'ont pas le même remède : les confondre envoie chercher au mauvais endroit.",
  );
});

test("un signe hors alphabet est NOMMÉ, et rien d'autre de la saisie ne l'est", () => {
  const etat = etatDeLaSaisie("ABCD-EFG!");
  assert.equal(etat.verdict, VERDICTS.malRecopie);
  assert.match(etat.message, /« ! »/);
  assert.ok(!etat.message.includes("ABCD"), "le message ne recopie pas la saisie.");
});

test("un chiffre PLEINE CHASSE est refusé : c'est la forme NFC, pas une forme de compatibilité", () => {
  // Le cas qui distingue les quatre formes de normalisation. NFKC le ramènerait sur « 0 » et
  // ferait accepter un code que le décodeur refuse — deux verdicts pour une même saisie.
  const etat = etatDeLaSaisie("０123-4567-89AB-CDEF-GHJK-MNPQ-RSTV");
  assert.equal(etat.verdict, VERDICTS.malRecopie);
});

test("une saisie VIDE dit quoi faire, sans rien refuser", () => {
  const etat = etatDeLaSaisie("");
  assert.equal(etat.verdict, VERDICTS.vide);
  assert.equal(etat.envoyable, false);
  assert.equal(etat.code, null);
  assert.match(etat.message, new RegExp(String(SYMBOLES_TOTAL)));
});

test("une saisie TROP LONGUE est refusée POUR SA LONGUEUR, jamais tronquée", () => {
  // Second survivant de la campagne : sans la borne haute, une saisie de trente-deux symboles
  // tombait sur la somme de contrôle — qui refuse tout ce qui ne fait pas vingt-huit symboles — et
  // rendait le MÊME verdict. L'épreuve était donc verte sur les deux chemins. Ce qui les distingue
  // est le MOTIF rendu à l'utilisateur, et c'est lui qui compte : « il y en a de trop » envoie
  // effacer, « la somme ne vérifie pas » envoie relire.
  const etat = etatDeLaSaisie(`${unCode()}-ZZZZ`);
  assert.equal(etat.verdict, VERDICTS.malRecopie);
  assert.equal(etat.envoyable, false);
  assert.equal(etat.symbolesLus, SYMBOLES_TOTAL + 4);
  assert.match(etat.message, /de trop/);
  assert.doesNotMatch(etat.message, /somme de contrôle/);
});

test("la découpe est SEPT groupes de quatre, et elle ne l'est que là", () => {
  const code = unCode();
  assert.equal(decouper(etatDeLaSaisie(code).decoupe ? [] : []), "");
  assert.equal(code.split("-").length, 7);
  assert.deepEqual(
    code.split("-").map((groupe) => groupe.length),
    [4, 4, 4, 4, 4, 4, 4],
  );
});

// --- L'ancre de version, et son AVEU -------------------------------------------------------------

test("un champ de version VIDE est accepté, et l'aveu est AFFICHÉ", () => {
  // La seconde moitié de la décision 3 de l'ADR 0027 — « rien n'est exigé, ET RIEN N'EST PROMIS » —
  // est celle qui disparaît des interfaces, parce qu'elle n'apporte rien à qui veut juste ouvrir
  // son coffre. Elle est donc éprouvée séparément, et l'épreuve navigateur la cherche à l'écran.
  const lue = ancreSaisie("");
  assert.equal(lue.version, null);
  assert.equal(lue.valide, true);
  assert.equal(lue.aveu, AVEU_SANS_ANCRE);
  assert.match(AVEU_SANS_ANCRE, /n'est PAS opposé/);
  assert.match(AVEU_SANS_ANCRE, /révoquée/);
});

test("une version saisie devient `versionMinimale`, et la coquille dit ce qu'elle ferme", () => {
  const lue = ancreSaisie(" 12 ");
  assert.equal(lue.version, 12);
  assert.equal(lue.valide, true);
  assert.equal(lue.aveu, ancreOpposee(12));
  assert.match(lue.aveu, /VAULT_ENVELOPPE_REJEU/);
  assert.match(lue.aveu, /support/, "l'étendue de la promesse est dite avec la promesse.");
});

test("une version qui n'est pas un entier est REFUSÉE, jamais corrigée", () => {
  for (const saisie of ["0", "-3", "12a", "1.5", "abc", "1e3"]) {
    const lue = ancreSaisie(saisie);
    assert.equal(lue.valide, false, `« ${saisie} » a été accepté.`);
    assert.equal(lue.version, null);
  }
});

test("`VAULT_ENVELOPPE_REJEU` nomme SES DEUX replis, dont le geste explicite", () => {
  assert.equal(CONDUITES[ENVELOPPE_ERROR_CODES.rejeu], REPLI_DU_REJEU);
  assert.match(REPLI_DU_REJEU, /relisez la version/i);
  assert.match(REPLI_DU_REJEU, /videz le champ/i);
  assert.match(REPLI_DU_REJEU, /renoncez/i, "le second repli doit dire ce qu'il coûte.");
});

// --- La feuille de récupération -------------------------------------------------------------------

test("la FEUILLE porte le code ET la version : les deux, ou aucun", () => {
  const code = unCode();
  const feuille = feuilleDeRecuperation({ code, version: 7 });
  assert.equal(feuille.code, code);
  assert.equal(feuille.version, 7);
  assert.equal(feuille.groupes.length, 7);
  assert.match(feuille.consigne, /version d'enveloppe : 7/i);
  assert.match(feuille.consigne, /seconde fois/, "le rendu unique est dit à l'utilisateur.");
});

test("une feuille sans version, ou sans code, est REFUSÉE : une moitié ne secourt rien", () => {
  assert.throws(() => feuilleDeRecuperation({ code: unCode(), version: 0 }));
  assert.throws(() => feuilleDeRecuperation({ code: unCode(), version: null }));
  assert.throws(() => feuilleDeRecuperation({ code: "", version: 1 }));
});

test("la version À NOTER se dit après un geste NOMMÉ, jamais à chaque ouverture", () => {
  const texte = versionANoter({ version: 4, geste: "Moyen de récupération créé" });
  assert.match(texte, /Moyen de récupération créé/);
  assert.match(texte, /désormais 4/);
  assert.match(texte, /ANTÉRIEURE/, "elle doit dire CONTRE QUOI elle protège.");
  assert.throws(() => versionANoter({ version: 0, geste: "x" }));
});

test("`recovery: null` a son AVERTISSEMENT, et il précède l'archive plutôt qu'il ne la suit", () => {
  assert.match(AVERTISSEMENT_SANS_RECUPERATION, /AUCUN moyen de récupération/);
  assert.match(AVERTISSEMENT_SANS_RECUPERATION, /nulle part ailleurs/);
});

// --- Les moyens, lus de l'inventaire ---------------------------------------------------------------

test("la coquille ne propose QUE ce que l'enveloppe porte", () => {
  const propose = moyensProposes({
    versionEnveloppe: 3,
    emplacements: [
      { typeKek: TYPES_KEK.phrase, identifiantEmplacement: "aa" },
      { typeKek: TYPES_KEK.recuperation, identifiantEmplacement: "bb" },
    ],
  });
  assert.deepEqual(
    propose.moyens.map((moyen) => moyen.nom),
    ["phrase", "recuperation"],
  );
  assert.equal(propose.aUnMoyenDeRecuperation, true);
  assert.equal(propose.avertissement, null);
  assert.equal(propose.versionEnveloppe, 3);
});

test("un type INCONNU est dit « trop ancien », et n'empêche pas les autres de servir", () => {
  // La compatibilité du point 5 du contrat de #22 : un emplacement d'un type inconnu ne fait pas
  // échouer une enveloppe qui en porte un autre, servable. Mais il est DIT.
  const propose = moyensProposes({
    versionEnveloppe: 9,
    emplacements: [
      { typeKek: 99, identifiantEmplacement: "zz" },
      { typeKek: TYPES_KEK.phrase, identifiantEmplacement: "aa" },
    ],
  });
  assert.deepEqual(
    propose.moyens.map((moyen) => moyen.nom),
    ["phrase"],
  );
  assert.deepEqual([...propose.inconnus], [{ typeKek: 99, nom: null }]);
  assert.equal(propose.avertissement, TEXTE_TROP_ANCIEN);
  assert.match(TEXTE_TROP_ANCIEN, /plus récente/);
  assert.match(TEXTE_TROP_ANCIEN, /Rien n'a été tenté/);
});

test("le type `harnais` n'est PAS un moyen servi : la porte a quitté le chemin de produit", () => {
  // Décision 1 de l'ADR 0029. Ce n'est pas une omission de table : une enveloppe qui ne porterait
  // qu'un emplacement de harnais est annoncée non servable, exactement comme un type venu du futur.
  assert.equal(MOYENS_SERVIS[TYPES_KEK.harnais], undefined);
  assert.deepEqual(NOMS_SERVIS, ["phrase", "recuperation", "webauthn-prf"]);
  const propose = moyensProposes({
    versionEnveloppe: 1,
    emplacements: [{ typeKek: TYPES_KEK.harnais, identifiantEmplacement: "hh" }],
  });
  assert.deepEqual(propose.moyens, []);
  assert.deepEqual([...propose.inconnus], [{ typeKek: TYPES_KEK.harnais, nom: "harnais" }]);
});

test("un même type présent deux fois ne fait qu'un seul moyen proposé", () => {
  const propose = moyensProposes({
    versionEnveloppe: 2,
    emplacements: [
      { typeKek: TYPES_KEK.phrase, identifiantEmplacement: "aa" },
      { typeKek: TYPES_KEK.phrase, identifiantEmplacement: "bb" },
    ],
  });
  assert.equal(propose.moyens.length, 1);
  assert.equal(propose.moyens[0].identifiantEmplacement, "aa");
});

test("chaque moyen dit OÙ il se dérive, et le Worker de CONFIANCE n'en dérive qu'un", () => {
  // La phrase se dérivait dans le Worker de confiance ; elle se dérive désormais dans un Worker
  // DÉDIÉ que la page crée (ADR 0029, décision 5 réécrite). Le motif est mesuré, pas esthétique :
  // Argon2id est un appel WebAssembly SYNCHRONE, et le fil qui le porte ne dispatche plus aucun
  // message pendant deux secondes — y compris la question d'état que la coquille relaie pour le
  // document applicatif.
  assert.equal(
    moyenParNom("phrase").derivePar,
    "page",
    "Argon2id ne doit plus bloquer le fil du Worker de confiance : c'est le constat 2 de la revue de la PR #167.",
  );
  assert.equal(
    moyenParNom("webauthn-prf").derivePar,
    "page",
    "`navigator.credentials` n'existe pas dans un Worker : la décision 5 de l'ADR 0021 est un fait de plate-forme.",
  );
  assert.equal(
    moyenParNom("recuperation").derivePar,
    "worker",
    "HKDF coûte zéro à deux millisecondes : le dériver ailleurs ferait voyager le code une fois de plus pour rien.",
  );
  assert.equal(moyenParNom("un-moyen-inventé"), null);
});

test("une KEK NON EXTRACTIBLE ARRIVE au Worker de confiance ; rien d'autre n'y arrive", () => {
  // La moitié ARRIVANTE de la dérogation à `sansCapacite`. Elle n'avait ni épreuve ni mutant — la
  // revue de sécurité de la PR #167 l'a relevé —, alors même que l'ADR affirmait qu'elle ne faisait
  // pas double emploi avec la moitié PARTANTE. Les deux conditions se manquent différemment, et les
  // deux sont donc éprouvées séparément.
  const opaque = fausseCle({ extractable: false });
  assert.equal(exigerKekDeLaPage(opaque), opaque);

  assert.throws(
    () => exigerKekDeLaPage(fausseCle({ extractable: true })),
    (erreur) =>
      erreur.code === CODES_REFUS_COQUILLE.capaciteDansUnMessage &&
      /EXTRACTIBLE/.test(erreur.message),
    "une CryptoKey extractible est un secret que du code peut relire.",
  );
  for (const valeur of [new Uint8Array(32), "00ff", { extractable: false }, 42, null, undefined]) {
    assert.throws(
      () => exigerKekDeLaPage(valeur),
      (erreur) => erreur.code === CODES_REFUS_COQUILLE.capaciteDansUnMessage,
      `« ${String(valeur)} » a été pris pour une KEK.`,
    );
  }
});

test("le Worker de DÉRIVATION ne peut atteindre ni le stockage, ni l'enveloppe, ni le volume", async () => {
  // Une propriété qui tient à ce qu'un fichier ne fasse PAS quelque chose se relit mieux qu'elle ne
  // se croit. Ce Worker ne connaît que ce qu'on lui passe : une phrase, des paramètres publics, une
  // identité d'emplacement. Le balayage vise les IMPORTS, pas les mentions — son en-tête explique
  // longuement ce qu'il ne touche pas, et lui interdire les mots rendrait la garde indocumentable.
  const source = await lire("public/derivation-worker.mjs");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((occurrence) => occurrence[1]);
  assert.deepEqual(
    imports.sort(),
    ["/src/vm/derivation/derivateur-phrase.mjs", "/src/vm/format-chiffre/octets.mjs"],
    "Le Worker de dérivation ne doit importer que de quoi dériver une phrase.",
  );
  // Et il MEURT après usage : son tas — la phrase comprise — s'en va avec lui (ADR 0029, déc. 5).
  assert.match(source, /self\.close\(\)/);
});

// --- La seule dérogation à `sansCapacite` ---------------------------------------------------------

test("une KEK NON EXTRACTIBLE franchit le canal privilégié, et rien d'autre ne franchit avec elle", () => {
  const message = enveloppePrivilegiee(TYPES_PRIVILEGIES.deverrouiller, {
    [CHAMP_DE_LA_KEK]: fausseCle({ extractable: false }),
    moyen: "webauthn-prf",
    correlation: "c1",
  });
  assert.equal(message.type, TYPES_PRIVILEGIES.deverrouiller);
  assert.equal(message.moyen, "webauthn-prf");
  assert.ok(message[CHAMP_DE_LA_KEK] !== undefined);
});

test("une KEK EXTRACTIBLE est REFUSÉE : la dérogation serait aussi large que l'interdit", () => {
  assert.throws(
    () =>
      enveloppePrivilegiee(TYPES_PRIVILEGIES.deverrouiller, {
        [CHAMP_DE_LA_KEK]: fausseCle({ extractable: true }),
      }),
    (erreur) => erreur.code === CODES_REFUS_COQUILLE.capaciteDansUnMessage,
  );
});

test("la dérogation ne vaut PAS pour un type applicatif : aucune clé ne part vers l'application", () => {
  // C'est la propriété de fond, et elle tient par CONSTRUCTION plutôt que par convention : la
  // fonction qui admet une capacité refuse d'emblée les types du port restreint.
  for (const type of Object.values(TYPES_APPLICATIFS)) {
    assert.throws(
      () => enveloppePrivilegiee(type, { [CHAMP_DE_LA_KEK]: fausseCle({ extractable: false }) }),
      /canal privilégié/,
      `${type} a pu porter une capacité.`,
    );
  }
});

test("le champ `kek` n'accepte QUE une CryptoKey : ni octets, ni chaîne, ni objet approchant", () => {
  for (const valeur of [new Uint8Array(32), "00ff", { extractable: false }, 42, null]) {
    assert.throws(
      () => enveloppePrivilegiee(TYPES_PRIVILEGIES.deverrouiller, { [CHAMP_DE_LA_KEK]: valeur }),
      `« ${String(valeur)} » a franchi le port comme une KEK.`,
    );
  }
});

test("le RESTE du corps reste soumis à `sansCapacite`, KEK ou pas", () => {
  assert.throws(
    () =>
      enveloppePrivilegiee(TYPES_PRIVILEGIES.deverrouiller, {
        [CHAMP_DE_LA_KEK]: fausseCle({ extractable: false }),
        parametres: new Uint8Array(4),
      }),
    (erreur) => erreur.code === CODES_REFUS_COQUILLE.capaciteDansUnMessage,
  );
});

test("un corps ne recouvre JAMAIS l'identité du contrat, sur les deux portes", () => {
  // Troisième survivant de la campagne, et le plus instructif : la garde vit dans
  // `enveloppeDeMessage`, et aucune épreuve ne l'y attaquait — `enveloppePrivilegiee` la rappelle
  // sur le reste du corps, si bien que la retirer de la première laissait tout vert. C'est
  // exactement le défaut qui a coûté une demi-heure de #162 : une réponse d'inventaire portant sa
  // version d'enveloppe sous le nom `version` recouvrait celle du CONTRAT, et le décodeur d'en face
  // refusait un message pourtant bien formé.
  for (const champ of ["contrat", "version", "type"]) {
    assert.throws(
      () => enveloppeDeMessage(TYPES_PRIVILEGIES.inventaireReponse, { [champ]: 3 }),
      new RegExp(`« ${champ} »`),
      `un corps portant « ${champ} » a été accepté par enveloppeDeMessage.`,
    );
    assert.throws(
      () => enveloppePrivilegiee(TYPES_PRIVILEGIES.deverrouiller, { [champ]: 3 }),
      new RegExp(`« ${champ} »`),
      `un corps portant « ${champ} » a été accepté par enveloppePrivilegiee.`,
    );
    assert.throws(
      () =>
        enveloppePrivilegiee(TYPES_PRIVILEGIES.deverrouiller, {
          [CHAMP_DE_LA_KEK]: fausseCle({ extractable: false }),
          [champ]: 3,
        }),
      new RegExp(`« ${champ} »`),
      `un corps portant « ${champ} » a été accepté à côté d'une KEK.`,
    );
  }
  // Et le message NORMAL porte bien l'identité du contrat, elle et pas une autre : sans ce témoin,
  // une garde qui refuserait tout serait verte aussi.
  const message = enveloppeDeMessage(TYPES_PRIVILEGIES.inventaireReponse, { versionEnveloppe: 3 });
  assert.equal(message.contrat, CONTRAT_COQUILLE.id);
  assert.equal(message.version, CONTRAT_COQUILLE.version);
  assert.equal(message.versionEnveloppe, 3);
});

test("TOUTE réponse du canal privilégié est appariable : aucune ne peut rester en suspens", () => {
  // La classe de défauts que cette liste ferme, et qui a mordu DEUX fois en écrivant #162 : un type
  // de réponse que l'appelant n'apparie pas fait attendre la page pour toujours — pas d'erreur, pas
  // de refus, pas de journal, seulement un geste qui n'aboutit jamais. La liste est DÉRIVÉE de la
  // table des types ; cette épreuve dit ce qu'elle doit contenir, nommément.
  assert.deepEqual(
    [...REPONSES_PRIVILEGIEES].sort(),
    [
      // Les deux gestes du cycle de vie assemblé (#163) : démarrer l'application, fermer le coffre.
      // Ils entrent dans cette liste au même titre que les autres — un boot de deux minutes qui
      // resterait en suspens serait la plus longue des attentes muettes.
      TYPES_PRIVILEGIES.applicationReponse,
      TYPES_PRIVILEGIES.deverrouillageReponse,
      TYPES_PRIVILEGIES.etatReponse,
      TYPES_PRIVILEGIES.fermetureReponse,
      TYPES_PRIVILEGIES.inventaireReponse,
      TYPES_PRIVILEGIES.preparationReponse,
      TYPES_PRIVILEGIES.recuperationRendue,
      TYPES_PRIVILEGIES.refus,
    ].sort(),
  );

  // Et la propriété qui compte, dite autrement : CHAQUE type qui n'est ni une demande, ni
  // l'établissement du canal, ni une annonce poussée, est appariable. Un type de réponse ajouté
  // demain sans entrer dans la liste fait rougir ici, et non chez un utilisateur.
  const demandes = new Set([
    TYPES_PRIVILEGIES.canal,
    TYPES_PRIVILEGIES.etat,
    TYPES_PRIVILEGIES.inventaire,
    TYPES_PRIVILEGIES.preparation,
    TYPES_PRIVILEGIES.deverrouiller,
    TYPES_PRIVILEGIES.creerRecuperation,
    TYPES_PRIVILEGIES.application,
    TYPES_PRIVILEGIES.fermeture,
    TYPES_PRIVILEGIES.barriere,
  ]);
  for (const type of Object.values(TYPES_PRIVILEGIES)) {
    assert.equal(
      REPONSES_PRIVILEGIEES.has(type),
      !demandes.has(type),
      `« ${type} » n'est ni une demande connue, ni une réponse appariable : une des deux listes est en retard.`,
    );
  }
});

test("un message privilégié SANS kek passe par la porte ordinaire, inchangée", () => {
  const message = enveloppePrivilegiee(TYPES_PRIVILEGIES.etat, { correlation: "c9" });
  assert.equal(message.type, TYPES_PRIVILEGIES.etat);
  assert.equal(message.correlation, "c9");
  assert.throws(() => enveloppePrivilegiee(TYPES_PRIVILEGIES.etat, { fuite: new Uint8Array(1) }));
});

// --- Les conduites rendues à l'utilisateur ---------------------------------------------------------

test("chaque refus qu'un geste d'utilisateur peut provoquer a SA conduite, et son code", () => {
  const attendus = [
    ENVELOPPE_ERROR_CODES.cleRefusee,
    ENVELOPPE_ERROR_CODES.rejeu,
    ENVELOPPE_ERROR_CODES.absente,
    DERIVATION_ERROR_CODES.codeMalRecopie,
    DERIVATION_ERROR_CODES.codeDejaRendu,
    DERIVATION_ERROR_CODES.prfIndisponible,
    DERIVATION_ERROR_CODES.prfIgnoree,
    DERIVATION_ERROR_CODES.annulee,
  ];
  for (const code of attendus) {
    assert.ok(CONDUITES[code], `${code} n'a pas de conduite.`);
    // Le CODE accompagne toujours la phrase : un code est cherchable, une phrase ne l'est pas.
    assert.ok(conduiteDeRefus(code, null).includes(code));
  }
});

test("les trois refus de PRF restent DISTINCTS à l'écran, comme ils le sont dans le code", () => {
  // Conduites (a), (b) et (c) de l'ADR 0021. Les fondre en « la passkey a échoué » ferait chercher
  // un autre authentificateur là où il faut un autre moyen, et l'inverse.
  const trois = [
    DERIVATION_ERROR_CODES.prfIndisponible,
    DERIVATION_ERROR_CODES.prfIgnoree,
    DERIVATION_ERROR_CODES.annulee,
  ].map((code) => CONDUITES[code]);
  assert.equal(new Set(trois).size, 3);
});

test("un code INCONNU est rendu tel quel, jamais remplacé par « une erreur est survenue »", () => {
  const rendu = conduiteDeRefus("VAULT_QUELQUE_CHOSE_DE_NEUF", "message du produit");
  assert.match(rendu, /VAULT_QUELQUE_CHOSE_DE_NEUF/);
  assert.match(rendu, /message du produit/);
});

// --- Ce que l'interface n'écrit JAMAIS --------------------------------------------------------------

test("aucun module de la coquille n'écrit dans un stockage, ni dans le presse-papiers", async () => {
  // Le balayage vise les APPELS, pas les mentions : les en-têtes expliquent longuement pourquoi le
  // code n'entre nulle part, et leur interdire les mots rendrait la garde impossible à documenter.
  const interdits = [
    /\blocalStorage\s*\.\s*setItem\s*\(/,
    /\bsessionStorage\s*\.\s*setItem\s*\(/,
    /\bdocument\s*\.\s*cookie\s*=/,
    /\bindexedDB\s*\.\s*open\s*\(/,
    /\bcaches\s*\.\s*open\s*\(/,
    /navigator\s*\.\s*clipboard/,
    /\bwriteText\s*\(/,
  ];
  // Les DEUX Workers y sont entrés avec la revue de la PR #167 : le balayage omettait exactement
  // les fichiers qui TIENNENT le code et la phrase, ce qui en faisait une garde sur les seuls
  // endroits où le risque était le plus faible.
  for (const fichier of [
    "src/coquille/interface-de-deverrouillage.mjs",
    "src/coquille/saisie-du-code.mjs",
    "src/coquille/feuille-de-recuperation.mjs",
    "src/coquille/moyens-de-deverrouillage.mjs",
    "public/main.mjs",
    "public/index.html",
    "public/runtime-worker.mjs",
    "public/derivation-worker.mjs",
  ]) {
    const contenu = await lire(fichier);
    for (const motif of interdits) {
      assert.ok(!motif.test(contenu), `${fichier} appelle ${motif} : le secret y survivrait.`);
    }
  }
});

test("le balayage des écritures MORD : il reconnaît un dépôt qu'on lui présente", () => {
  // Un balayage à vide passe toujours. Celui-ci est confronté au texte qu'il doit refuser et à la
  // prose qu'il doit laisser passer.
  const motif = /\blocalStorage\s*\.\s*setItem\s*\(/;
  assert.ok(motif.test('localStorage.setItem("vault-code", code);'));
  assert.ok(!motif.test("// rien n'entre dans localStorage, et surtout pas le code"));
});
