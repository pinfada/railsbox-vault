/**
 * L'ANCRE TENUE PAR L'UTILISATEUR (#149, ADR 0027, décision 3).
 *
 * L'ADR 0020 avait posé `versionMinimale` et laissé sa limite écrite noir sur blanc : « un
 * adversaire qui EFFACE la page courante fait retomber le lecteur sur la précédente, donc ressuscite
 * une clé révoquée ». Le paramètre existait ; aucun chemin de production ne le fournissait, si bien
 * que la limite était totale.
 *
 * Cette suite fait deux choses, et la seconde compte autant que la première :
 *
 *  1. **elle prouve que l'ancre mord** — une page ANTÉRIEURE réinstallée, portant un emplacement
 *     révoqué depuis, est refusée par `VAULT_ENVELOPPE_REJEU` sous la version notée sur la feuille
 *     de récupération ;
 *  2. **elle écrit l'AVEU, dans la même épreuve et à la ligne suivante** — sans la feuille
 *     (`versionMinimale: null`), la même page est ACCEPTÉE, et la clé révoquée ouvre le volume.
 *     Les deux assertions côte à côte disent ce que l'ancre achète et ce qu'elle coûte de ne pas
 *     l'avoir. Séparées, la seconde finirait par disparaître d'une suite « qui passe ».
 *
 * Le reste mesure la TRANSMISSION : `versionMinimale` doit traverser les deux ouvreurs de production
 * sans se perdre, et le Worker de confiance doit l'accepter de son appelant. Un paramètre qui existe
 * et que personne ne passe est un paramètre qui n'existe pas.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ajouterEmplacement,
  ouvrirEnveloppe,
  revoquerEmplacement,
} from "../../src/vm/enveloppe-de-cle.mjs";
import {
  ENVELOPPE_ERROR_CODES,
  isEnveloppeError,
} from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { derivateurRecuperation } from "../../src/vm/derivation/derivateur-recuperation.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import {
  ouvrirVolumeParDerivateur,
  ouvrirVolumeParKek,
} from "../../src/vm/ouverture-par-enveloppe.mjs";
import {
  ATTENTES,
  KEK,
  VOLUME_A,
  magasin,
  poserVolume,
  supportDe,
} from "./support-archive-recuperation.mjs";
import { suiteDOctets } from "./support-enveloppe-double.mjs";

const NOM = "coffre";
const KEK_COMPROMISE = suiteDOctets(0x40, 32);

/**
 * Pose un volume, ajoute une seconde clé, la révoque, et rend l'état du fichier d'enveloppes AVANT
 * la révocation — c'est-à-dire ce qu'une copie prise trop tôt, ou un adversaire, réinstallerait.
 */
async function volumeAvecRevocation() {
  const banc = magasin();
  const pose = await poserVolume(banc, { nom: NOM, avecRecuperation: false });
  const support = pose.support;

  const ajout = await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME_A,
    kek: KEK,
    kekNouvelle: KEK_COMPROMISE,
  });
  const avantRevocation = banc.lire(`${NOM}.cles`);

  const inventaire = await ouvrirEnveloppe({
    support,
    identifiantVolume: VOLUME_A,
    kek: KEK_COMPROMISE,
  });
  const revocation = await revoquerEmplacement({
    support,
    identifiantVolume: VOLUME_A,
    kek: KEK,
    identifiantEmplacement: inventaire.identifiantEmplacement,
  });

  assert.equal(ajout.version, 2);
  assert.equal(revocation.version, 3, "c'est CE chiffre que la feuille de récupération porte");
  return { banc, support, avantRevocation, feuille: revocation.version };
}

test("une page antérieure réinstallée est REFUSÉE sous la feuille — et ACCEPTÉE sans elle", async () => {
  const { banc, support, avantRevocation, feuille } = await volumeAvecRevocation();

  // La clé révoquée ne peut plus rien : c'est l'état courant, et il dit non.
  await assert.rejects(
    ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: KEK_COMPROMISE }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.cleRefusee),
  );

  // RETOUR ARRIÈRE : le fichier est ramené à son état d'avant la révocation. Ni l'un ni l'autre des
  // deux fichiers n'est abîmé ; c'est le même produit qui a écrit les deux.
  await banc.ecrire(`${NOM}.cles`, avantRevocation);

  // 1. SOUS LA FEUILLE — la version authentifiée est antérieure au minimum exigé : refus typé.
  await assert.rejects(
    ouvrirEnveloppe({
      support,
      identifiantVolume: VOLUME_A,
      kek: KEK_COMPROMISE,
      versionMinimale: feuille,
    }),
    (erreur) => {
      assert.ok(isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.rejeu));
      return true;
    },
  );

  // 2. L'AVEU — sans la feuille, la même page est acceptée, et la clé RÉVOQUÉE ouvre le volume.
  //    C'est la limite que l'ADR 0020 avait écrite et que l'ADR 0027 chiffre : sans ancre tenue
  //    hors du fichier, une révocation ne résiste pas à qui peut écrire dans l'origine de confiance.
  const ouverte = await ouvrirEnveloppe({
    support,
    identifiantVolume: VOLUME_A,
    kek: KEK_COMPROMISE,
    versionMinimale: null,
  });
  assert.equal(ouverte.version, 2);
  assert.equal(ouverte.dek.byteLength, 32);
});

test("`ouvrirVolumeParKek` transmet la feuille : aucun volume n'est ouvert sous une page rejouée", async () => {
  const { banc, support, avantRevocation, feuille } = await volumeAvecRevocation();
  await banc.ecrire(`${NOM}.cles`, avantRevocation);
  const ouvertures = [];

  await assert.rejects(
    ouvrirVolumeParKek({
      name: NOM,
      kek: KEK_COMPROMISE,
      support,
      expectations: ATTENTES,
      versionMinimale: feuille,
      stat: banc.stat,
      readFile: banc.readFile,
      openVolume: async (options) => {
        ouvertures.push(options.name);
        return { close: async () => {} };
      },
    }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.rejeu),
  );
  assert.deepEqual(ouvertures, [], "un volume a été ouvert sous une enveloppe rejouée");
});

test("`ouvrirVolumeParDerivateur` transmet la feuille jusqu'à l'enveloppe", async () => {
  const banc = magasin();
  const pose = await poserVolume(banc, { nom: NOM });
  const support = supportDe(banc, NOM);

  // La feuille porte une version que le fichier n'a pas atteinte : c'est exactement l'état d'un
  // utilisateur qui a révoqué depuis, sur un fichier ramené en arrière. Le chemin par DÉRIVATEUR
  // doit refuser comme celui par KEK — sans quoi la même page serait refusée par une porte et
  // acceptée par l'autre.
  const courante = await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: KEK });
  const feuille = courante.version + 1;

  await assert.rejects(
    ouvrirVolumeParDerivateur({
      name: NOM,
      derivateur: derivateurRecuperation(),
      geste: { code: pose.code },
      support,
      expectations: ATTENTES,
      versionMinimale: feuille,
      stat: banc.stat,
      readFile: banc.readFile,
      openVolume: (options) =>
        openOpfsVolume({ ...options, openHandle: banc.store.openHandle, transactionnel: false }),
    }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.rejeu),
  );
});

test("le Worker de confiance ACCEPTE la feuille de son appelant et la passe aux ouvreurs", async () => {
  // Un paramètre que le produit accepte mais qu'aucun contexte de confiance ne transmet reste une
  // promesse. Cette épreuve relit le Worker là où la transmission se perdrait, et elle est le
  // pendant, au niveau du banc, de ce que les deux épreuves ci-dessus mesurent à l'exécution.
  const phases = fileURLToPath(
    new URL("../../public/vm/reference-worker-phases-enveloppe.mjs", import.meta.url),
  );
  const contenu = await readFile(phases, "utf8");
  const appels = contenu.match(/ouvrirEnveloppe\(\{[^}]*\}\)/gs) ?? [];
  assert.ok(appels.length > 0, "le Worker n'ouvre plus aucune enveloppe : l'épreuve est caduque");
  for (const appel of appels) {
    assert.match(appel, /versionMinimale/, `un appel du Worker perd la feuille en route : ${appel}`);
  }
  assert.match(
    contenu,
    /versionMinimale = null/,
    "le Worker doit DÉCLARER le paramètre, et son défaut doit être « aucune feuille »",
  );
});
