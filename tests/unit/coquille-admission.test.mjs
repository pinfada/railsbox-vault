/**
 * La LISTE D'ADMISSION dérivée, la liste de refus, et les cinq conditions de l'annonce
 * (#161, ADR 0028, décision 2).
 *
 * L'ADR 0002 réserve cette liste à #24 et dit comment l'écrire : « dérivée des besoins réels de
 * l'application, pas devinée ». Une dérivation n'est vérifiable que si ses CITATIONS le sont : ces
 * épreuves exigent donc que chaque geste admis cite un fichier qui existe, et que la ligne citée
 * existe elle aussi. Sans cela, la dérivation serait une phrase, et une phrase se périme.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GESTES_ADMIS,
  GESTES_ECARTES,
  GESTES_REFUSES,
  estGesteAdmis,
  evaluerAnnonce,
  evaluerRequete,
} from "../../src/coquille/admission-applicative.mjs";
import {
  TAILLE_MAXIMALE_DE_CORRELATION,
  TAILLE_MAXIMALE_DU_TYPE_RENDU,
  TYPES_APPLICATIFS,
  TYPES_PRIVILEGIES,
  TYPES_RELAIS,
  correlationAdmise,
  enveloppeDeMessage,
} from "../../src/coquille/contrat-de-messages.mjs";
import {
  CHEMIN_APPLICATIF_PAR_DEFAUT,
  cadreApplicatif,
  cheminApplicatifAdmis,
  origineApplicativeDe,
} from "../../src/coquille/origines-de-la-coquille.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Une requête d'état EN RÈGLE. Depuis la revue de la PR #166, une requête admise porte son
 * identifiant de CORRÉLATION : c'est lui qui apparie N réponses à N requêtes, et qui interdit
 * qu'une question reste muette quand plusieurs sont en vol.
 */
function requeteDEtat(correlation = "c-1") {
  return enveloppeDeMessage(TYPES_APPLICATIFS.etat, { correlation });
}

/** Annonce en règle : le point de départ dont chaque épreuve ne change QU'UNE condition. */
const ANNONCE_EN_REGLE = Object.freeze({
  canalPrivilegiePret: true,
  type: TYPES_APPLICATIFS.annonce,
  origine: "http://localhost:4174",
  fenetreEstLeCadre: true,
  origineAttendue: "http://localhost:4174",
  dejaOctroye: false,
});

// --- La dérivation ------------------------------------------------------------------------------

test("la liste d'admission est COURTE, et chaque geste cite un usage réel", () => {
  assert.ok(GESTES_ADMIS.length >= 1);
  assert.ok(
    GESTES_ADMIS.length <= 3,
    "une liste d'admission qui grossit sans usage cesse d'être une frontière.",
  );
  for (const geste of GESTES_ADMIS) {
    assert.ok(geste.usage.length > 0, `${geste.type} n'est justifié par aucun usage`);
    assert.ok(geste.motif.length > 40, `${geste.type} n'explique pas pourquoi il est admis`);
  }
});

test("chaque usage cité désigne une ligne qui existe ET DIT ce que la citation prétend", async () => {
  // Une dérivation dont les renvois se périment redevient une devinette. La version d'avant
  // vérifiait que la LIGNE existait ; la revue de la PR #166 a relevé qu'un numéro qui existe ne
  // prouve rien — un fichier qui grandit de dix lignes déplace tout sans rien invalider en
  // apparence. La forme est donc celle de la spécification, « chemin:ligne › « fragment » », et
  // c'est le FRAGMENT qui ancre.
  const manquants = [];
  for (const geste of GESTES_ADMIS) {
    for (const usage of geste.usage) {
      const [, chemin, ligne, fragment] =
        usage.match(/^([\w./-]+):(\d+)\s*›\s*«\s*(.+?)\s*»/) ?? [];
      if (!chemin) {
        manquants.push(`${geste.type} : « ${usage} » n'est pas « fichier:ligne › « fragment » »`);
        continue;
      }
      let lignes;
      try {
        lignes = (await readFile(path.join(REPO_ROOT, chemin), "utf8")).split("\n");
      } catch {
        manquants.push(`${chemin} — fichier absent`);
        continue;
      }
      const citee = lignes[Number(ligne) - 1];
      if (citee === undefined) {
        manquants.push(`${chemin}:${ligne} — le fichier fait ${lignes.length} lignes`);
        continue;
      }
      if (!citee.includes(fragment)) {
        manquants.push(
          `${chemin}:${ligne} ne porte plus « ${fragment} » — elle porte « ${citee.trim()} »`,
        );
      }
    }
  }
  assert.deepEqual(manquants, [], "La dérivation cite des renvois périmés.");
});

test("l'ancrage par fragment MORD : une citation déplacée d'une ligne est refusée", async () => {
  // Un balayage à vide passe toujours. Celui-ci est confronté à un renvoi juste et à un renvoi
  // faux, construits à partir du même fichier — sans quoi rien ne dirait qu'il sait refuser.
  const lignes = (
    await readFile(path.join(REPO_ROOT, "src/coquille/refus-de-coquille.mjs"), "utf8")
  ).split("\n");
  const rang = lignes.findIndex((ligne) => ligne.includes("export const CODES_REFUS_COQUILLE"));
  assert.ok(rang > 0, "l'ancre de l'épreuve elle-même a disparu du module.");
  const porte = (numero, fragment) => lignes[numero - 1]?.includes(fragment) ?? false;
  assert.equal(porte(rang + 1, "export const CODES_REFUS_COQUILLE"), true);
  assert.equal(porte(rang + 2, "export const CODES_REFUS_COQUILLE"), false);
});

test("ce qui a été EXAMINÉ puis écarté est écrit, et n'est pas admis", () => {
  assert.ok(
    GESTES_ECARTES.length >= 2,
    "une liste d'admission sans trace de ce qu'on a refusé d'y mettre se relit comme un oubli.",
  );
  for (const ecarte of GESTES_ECARTES) {
    assert.ok(ecarte.motif.length > 60, `« ${ecarte.candidat} » est écarté sans motif opposable`);
  }
  // La taille et l'espace en font partie : la couche budget est un geste de la COQUILLE.
  assert.ok(GESTES_ECARTES.some(({ candidat }) => /taille|espace/i.test(candidat)));
  // Et l'identité d'application, que l'ADR 0018 § 4 interdit d'inventer.
  assert.ok(GESTES_ECARTES.some(({ candidat }) => /identifiant d'application/i.test(candidat)));
});

test("aucun champ du contrat ne nomme une application : l'origine EST l'identité", async () => {
  // ADR 0018 § 4. Le contrôle porte sur la SOURCE des modules de la coquille : un champ ajouté
  // demain — `applicationId`, `appId`, `identifiantApplication` — serait relevé ici.
  const sources = [
    "src/coquille/contrat-de-messages.mjs",
    "src/coquille/admission-applicative.mjs",
    "src/coquille/etat-de-la-coquille.mjs",
    "public/main.mjs",
  ];
  for (const chemin of sources) {
    const contenu = await readFile(path.join(REPO_ROOT, chemin), "utf8");
    // Le motif vise une CLÉ d'objet, jamais la prose : les modules expliquent longuement pourquoi
    // ce champ n'existe pas, et interdire les mots rendrait la décision impossible à documenter.
    assert.ok(
      !/\b(applicationId|appId|identifiantApplication)\s*[:=]/.test(contenu),
      `${chemin} nomme une identité d'application, que l'ADR 0018 § 4 interdit d'inventer.`,
    );
  }
});

// --- La liste de refus --------------------------------------------------------------------------

test("les DIX gestes de la liste de refus de #24 sont là, chacun avec son propre code", () => {
  assert.equal(GESTES_REFUSES.length, 10);
  const codes = GESTES_REFUSES.map(({ code }) => code);
  assert.equal(
    new Set(codes).size,
    10,
    "deux gestes refusés partagent un code : ils deviennent indiscernables.",
  );
  const gestes = GESTES_REFUSES.map(({ geste }) => geste).join(" | ");
  for (const attendu of [
    /KEK/,
    /DEK/,
    /export/i,
    /révoquer/i,
    /ajouter un emplacement/i,
    /moyen de récupération/i,
    /emplacement de volume/i,
    /\.cles/,
    /port privilégié/i,
    /handle/i,
  ]) {
    assert.match(gestes, attendu, `la liste de refus de #24 ne couvre pas ${attendu}`);
  }
});

test("chaque geste refusé reçoit SON code, jamais le refus générique", () => {
  for (const refuse of GESTES_REFUSES) {
    const verdict = evaluerRequete(enveloppeDeMessage(refuse.type));
    assert.equal(verdict.admise, false);
    assert.equal(verdict.code, refuse.code, `${refuse.type} n'a pas reçu son code`);
    assert.equal(verdict.recu, refuse.type);
  }
});

test("le refus ne dépend QUE du type : ce n'est pas un oracle", () => {
  // `evaluerRequete` ne prend aucun état en argument, et ne peut donc pas en consulter. Deux
  // appareils dans des états différents rendent le même code pour le même type.
  assert.equal(evaluerRequete.length, 1);
  const premier = evaluerRequete(enveloppeDeMessage(GESTES_REFUSES[0].type));
  const second = evaluerRequete(enveloppeDeMessage(GESTES_REFUSES[0].type));
  assert.deepEqual(premier, second);
});

test("un type du canal PRIVILÉGIÉ posé sur le port restreint est refusé comme tel", () => {
  const verdict = evaluerRequete(
    enveloppeDeMessage(TYPES_PRIVILEGIES.deverrouiller, { jeton: "x" }),
  );
  assert.equal(verdict.admise, false);
  assert.equal(verdict.code, CODES_REFUS_COQUILLE.portPrivilegie);
});

test("un type du canal de RELAIS posé sur le port restreint est refusé COMME TEL", () => {
  // Trois vocabulaires, trois canaux : un type de relais posé ici n'est pas « inconnu », il est
  // reconnu et refusé pour ce qu'il est. Sans cette garde il retombait dans `typeInconnu`, et la
  // campagne de mutation le laissait survivre (revue d'intégration #203, constat 4).
  for (const type of Object.values(TYPES_RELAIS)) {
    const verdict = evaluerRequete(enveloppeDeMessage(type, { correlation: "r1" }));
    assert.equal(verdict.admise, false, type);
    assert.equal(verdict.code, CODES_REFUS_COQUILLE.canalDeRelaisRefuse, type);
  }
});

test("le seul geste ADMIS en requête est l'état ; l'annonce de barrière ne se demande pas", () => {
  assert.equal(evaluerRequete(requeteDEtat()).admise, true);
  // La barrière est un geste admis du contrat, mais dans l'autre sens : la coquille la POUSSE.
  assert.equal(estGesteAdmis(TYPES_APPLICATIFS.barriere), true);
  const verdict = evaluerRequete(enveloppeDeMessage(TYPES_APPLICATIFS.barriere));
  assert.equal(verdict.admise, false);
  assert.equal(verdict.code, CODES_REFUS_COQUILLE.typeInconnu);
});

test("un type que personne ne nomme reçoit `TYPE_INCONNU`, jamais un silence", () => {
  const verdict = evaluerRequete(enveloppeDeMessage("vault.coquille.geste-invente"));
  assert.equal(verdict.admise, false);
  assert.equal(verdict.code, CODES_REFUS_COQUILLE.typeInconnu);
});

// --- La corrélation, et ce qu'elle ferme (revue de la PR #166) ------------------------------------

test("une requête admise SANS corrélation est refusée : sinon deux réponses se disputeraient une place", () => {
  // Le silence mesuré par la revue : deux requêtes en vol, une seule réponse. Sans identifiant,
  // rien ne peut apparier — et le seul geste que la coquille admette restait muet.
  const verdict = evaluerRequete(enveloppeDeMessage(TYPES_APPLICATIFS.etat));
  assert.equal(verdict.admise, false);
  assert.equal(verdict.code, CODES_REFUS_COQUILLE.correlationAbsente);
});

test("une corrélation qui n'en est pas une est refusée comme absente", () => {
  for (const correlation of [
    42,
    null,
    { objet: true },
    "",
    "espace interdit",
    "point.interdit",
    "x".repeat(65),
  ]) {
    const verdict = evaluerRequete(requeteDEtat(correlation));
    assert.equal(verdict.admise, false, `« ${String(correlation)} » a été admise`);
    assert.equal(verdict.code, CODES_REFUS_COQUILLE.correlationAbsente);
  }
});

test("la corrélation est rendue TELLE QUELLE, et elle est bornée", () => {
  const verdict = evaluerRequete(requeteDEtat("A_b-9"));
  assert.equal(verdict.admise, true);
  assert.equal(verdict.correlation, "A_b-9");
  assert.equal(correlationAdmise("x".repeat(TAILLE_MAXIMALE_DE_CORRELATION)) !== null, true);
  assert.equal(correlationAdmise("x".repeat(TAILLE_MAXIMALE_DE_CORRELATION + 1)), null);
});

test("une requête admise ne porte AUCUN champ hors du contrat", () => {
  // Le décodage était strict sur l'enveloppe et muet sur le reste : la revue a fait servir une
  // réponse à un message portant un champ de deux cent mille caractères. Un champ qu'on accepte
  // sans le lire est un champ que la version suivante lira par accident.
  const verdict = evaluerRequete({ ...requeteDEtat(), charge: "x".repeat(200000) });
  assert.equal(verdict.admise, false);
  assert.equal(verdict.code, CODES_REFUS_COQUILLE.messageMalforme);
});

test("un refus ne rend jamais plus que la borne du type, quoi qu'on lui envoie", () => {
  // Ce qui repart est ce que l'émetteur a envoyé, BORNÉ. Rien de cela n'entre dans le relevé de la
  // coquille, qui ne porte plus que des compteurs (revue de la PR #166, constat 3).
  const verdict = evaluerRequete({
    contrat: "railsbox-vault-coquille",
    version: 1,
    type: `vault.coquille.${"x".repeat(500)}`,
  });
  assert.equal(verdict.admise, false);
  assert.ok(verdict.recu.length <= TAILLE_MAXIMALE_DU_TYPE_RENDU + 1, verdict.recu.length);
});

test("un message illisible reçoit le refus du décodeur, et le refus ne recopie pas le message", () => {
  const verdict = evaluerRequete({ contrat: "autre", version: 1, type: "secret-de-lattaquant" });
  assert.equal(verdict.admise, false);
  assert.equal(verdict.code, CODES_REFUS_COQUILLE.contratRefuse);
  assert.equal(verdict.recu, "secret-de-lattaquant");
});

// --- L'annonce, et ses cinq conditions ------------------------------------------------------------

test("une annonce en règle est acceptée : sans ce témoin, tout refuser ne prouverait rien", () => {
  assert.deepEqual(evaluerAnnonce(ANNONCE_EN_REGLE), { accepte: true, code: null });
});

test("l'ORDRE vient en premier : aucun port avant le canal privilégié", () => {
  const verdict = evaluerAnnonce({ ...ANNONCE_EN_REGLE, canalPrivilegiePret: false });
  assert.deepEqual(verdict, { accepte: false, code: CODES_REFUS_COQUILLE.canalAbsent });
});

test("l'ordre est contrôlé AVANT tout le reste : une annonce fausse à tous égards le dit d'abord", () => {
  // Cet ordre-là n'est pas cosmétique : il dit que la coquille ne promet rien avant d'être capable
  // de le tenir, même à un document qui aurait par ailleurs tout faux.
  const verdict = evaluerAnnonce({
    canalPrivilegiePret: false,
    type: "vault.autre",
    origine: "https://ailleurs.test",
    fenetreEstLeCadre: false,
    origineAttendue: "http://localhost:4174",
    dejaOctroye: true,
  });
  assert.equal(verdict.code, CODES_REFUS_COQUILLE.canalAbsent);
});

test("le TYPE, l'ORIGINE et la FENÊTRE ÉMETTRICE sont trois conditions indépendantes", () => {
  const cas = [
    [{ type: "vault.coquille.autre" }, CODES_REFUS_COQUILLE.annonceType],
    [{ origine: "https://voisin.test" }, CODES_REFUS_COQUILLE.annonceOrigine],
    [{ fenetreEstLeCadre: false }, CODES_REFUS_COQUILLE.annonceFenetre],
  ];
  for (const [ecart, attendu] of cas) {
    const verdict = evaluerAnnonce({ ...ANNONCE_EN_REGLE, ...ecart });
    assert.equal(verdict.accepte, false);
    assert.equal(verdict.code, attendu, `écart ${JSON.stringify(ecart)}`);
  }
});

test("l'UNICITÉ vient en dernier : un second appel bien formé est refusé POUR CE MOTIF", () => {
  const verdict = evaluerAnnonce({ ...ANNONCE_EN_REGLE, dejaOctroye: true });
  assert.deepEqual(verdict, { accepte: false, code: CODES_REFUS_COQUILLE.annonceUnique });
});

test("une origine attendue absente ne laisse RIEN passer", () => {
  // Quand la règle d'origine ne conclut pas, `origineAttendue` vaut `null` : aucune origine réelle
  // ne lui est égale, donc aucune annonce n'est acceptée. Le refus est la valeur par défaut.
  const verdict = evaluerAnnonce({ ...ANNONCE_EN_REGLE, origineAttendue: null });
  assert.equal(verdict.accepte, false);
  assert.equal(verdict.code, CODES_REFUS_COQUILLE.annonceOrigine);
});

// --- La règle d'origine ---------------------------------------------------------------------------

test("l'origine applicative se dérive de celle de la coquille, jamais d'un message", () => {
  assert.equal(origineApplicativeDe("https://vault.exemple"), "https://app.vault.exemple");
  assert.equal(
    origineApplicativeDe("https://coffre.exemple:8443"),
    "https://app.coffre.exemple:8443",
  );
});

test("l'exception LOCALE reprend le couple du spike : `localhost` sur le port suivant", () => {
  assert.equal(origineApplicativeDe("http://127.0.0.1:4173"), "http://localhost:4174");
  assert.equal(origineApplicativeDe("http://127.0.0.1:4193"), "http://localhost:4194");
});

test("une origine que la règle ne sait pas traduire rend `null`, et n'invente rien", () => {
  for (const origine of [
    "https://app.vault.exemple", // déjà applicative : `app.app.…` serait un aveu
    "http://localhost:4173", // un nom de machine sans point n'est pas un domaine
    "pas-une-url",
    "",
  ]) {
    assert.equal(origineApplicativeDe(origine), null, `${origine} a été traduite`);
  }
});

test("le CHEMIN encadré est un paramètre, l'ORIGINE ne l'est jamais", () => {
  assert.equal(cheminApplicatifAdmis("/commandes/42"), "/commandes/42");
  for (const tentative of [
    "//exemple.test/", // relative au schéma : elle déplacerait l'origine
    "https://exemple.test/", // absolue : idem
    "commandes/42", // relative au document
    "\\\\exemple.test\\", // séparateur que certains moteurs normalisent
    // Celui-ci commence bien par une barre oblique : SEUL le refus de la barre inversée le
    // rattrape. Sans ce cas, la campagne de mutation laissait ce mutant vivant — les autres
    // tombaient tous sur l'exigence de la barre initiale (revue de la PR #166, constat 10).
    "/commandes\\..\\secret",
    "",
    null,
    42,
  ]) {
    assert.equal(cheminApplicatifAdmis(tentative), null, `${tentative} a été admis comme chemin`);
  }
});

test("le cadre applicatif joint l'origine dérivée au chemin admis, et retombe sur le défaut", () => {
  assert.deepEqual(cadreApplicatif("http://127.0.0.1:4173"), {
    origineApplicative: "http://localhost:4174",
    url: `http://localhost:4174${CHEMIN_APPLICATIF_PAR_DEFAUT}`,
  });
  assert.deepEqual(cadreApplicatif("http://127.0.0.1:4173", "//ailleurs.test/"), {
    origineApplicative: "http://localhost:4174",
    url: `http://localhost:4174${CHEMIN_APPLICATIF_PAR_DEFAUT}`,
  });
  assert.equal(cadreApplicatif("http://localhost:4173"), null);
});
