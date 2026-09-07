// La DÉRIVATION que la PAGE fait elle-même (#162, ADR 0029, décision 5 réécrite).
//
// Extraite de `public/main.mjs` par #163 : la page a gagné le cycle de vie assemblé, et un module de
// page qui porterait à la fois l'ordre des huit étapes, la mort du Worker et deux dérivations de clé
// ne se relirait plus d'un bloc. Rien n'y est changé — mêmes gestes, mêmes bornes, mêmes motifs ;
// seul l'accès au canal privilégié est devenu un paramètre au lieu d'une variable de module.
//
// Ce que ce module fait, et pourquoi il ne vit pas dans le Worker de confiance :
//
//  - **la phrase** est dérivée dans un Worker DÉDIÉ que la page crée. Argon2id est un appel
//    WebAssembly SYNCHRONE : le porter dans le Worker de confiance laissait le document applicatif
//    sans réponse pendant deux secondes sur le moteur le plus lent ;
//  - **la passkey** est dérivée DANS la page : `navigator.credentials` n'existe pas dans un Worker.
//
// Dans les deux cas, ce qui repart vers le Worker de confiance est une `CryptoKey` NON EXTRACTIBLE,
// par la même porte et sous la même garde (`enveloppePrivilegiee`). Ni la phrase, ni la sortie PRF,
// ni les octets d'une KEK ne quittent ce module.

import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { DELAI_PASSKEY_MS } from "./moyens-de-deverrouillage.mjs";
import {
  derivateurWebauthnPrf,
  enregistrerEmplacementPrf,
} from "../vm/derivation/derivateur-webauthn-prf.mjs";
import { TYPES_KEK } from "../vm/enveloppe/identite-enveloppe.mjs";
import { octetsEnHex } from "../vm/format-chiffre/octets.mjs";

/**
 * Les deux dérivations, liées au canal privilégié qu'on leur donne.
 *
 * `demanderAuWorker` est passé plutôt qu'importé : ce module ne connaît ni le Worker, ni le port, ni
 * la corrélation — il connaît une question et sa réponse. C'est aussi ce qui le rend appelable par
 * une épreuve sans navigateur.
 *
 * @param {{ demanderAuWorker: (type: string, corps?: object) => Promise<any>,
 *           urlDuWorker: URL }} liaison
 */
export function derivationsDeLaPage({ demanderAuWorker, urlDuWorker }) {
  return Object.freeze({
    deriverPhrase: (appel) => deriverPhrase({ ...appel, demanderAuWorker, urlDuWorker }),
    deriverPasskey: (appel) => deriverPasskey({ ...appel, demanderAuWorker }),
  });
}

/**
 * DÉRIVE la KEK d'une phrase dans un WORKER DÉDIÉ, et rend ce que le Worker de confiance attend.
 *
 * C'est la décision 5 de l'ADR 0029, réécrite après la revue de sécurité de la PR #167. Argon2id est
 * un appel WebAssembly SYNCHRONE : le fil qui le porte ne dispatche plus aucun message pendant deux
 * secondes sur le moteur le plus lent. Le porter dans le Worker de CONFIANCE laissait donc le
 * document applicatif sans réponse — et la première correction, qui sortait la question d'état de la
 * file de promesses de ce Worker, ne pouvait rien : il n'y a pas de file qui tienne quand le fil est
 * pris.
 *
 * **C'est la PAGE qui crée ce Worker, et non le Worker de confiance.** Les deux étaient possibles ;
 * celui-ci a trois motifs, dont un seul suffirait :
 *
 *  - il ne demande AUCUNE capacité nouvelle. Un Worker imbriqué en exigerait une que
 *    `docs/compatibility.md` ne mesure sur aucun des trois moteurs, et #162 n'a pas à ajouter une
 *    ligne au dossier de portabilité pour un calcul ;
 *  - il donne UNE seule forme aux deux moyens dérivés hors du Worker de confiance. La passkey l'est
 *    déjà, parce que `navigator.credentials` n'existe que dans un document ; la phrase le devient, et
 *    le Worker de confiance reçoit dans les deux cas exactement la même chose — une `CryptoKey` non
 *    extractible, par la même porte, sous la même garde ;
 *  - il RÉDUIT ce que le Worker de confiance fait. Il gardait un calcul qui n'avait besoin d'aucun
 *    de ses handles : ni l'OPFS, ni l'enveloppe, ni la clé de volume n'entrent dans une dérivation.
 *
 * Ce qui ne change pas : la phrase ne quitte pas l'origine de CONFIANCE. Elle franchit un port de
 * plus, à l'intérieur de la même origine — c'est la limite 4 de l'ADR 0021, inchangée dans sa nature
 * et dite une fois de plus.
 */
async function deriverPhrase({ inventaire, phrase, demanderAuWorker, urlDuWorker }) {
  const existant = (inventaire?.emplacements ?? []).find(
    (emplacement) => emplacement.typeKek === TYPES_KEK.phrase,
  );
  const identite =
    existant === undefined
      ? await demanderAuWorker("preparation", { moyen: "phrase" })
      : {
          identifiantVolume: inventaire.identifiantVolume,
          identifiantEmplacement: existant.identifiantEmplacement,
          parametresHex: existant.parametresHex,
        };
  const rendu = await dansLeWorkerDeDerivation(urlDuWorker, { ...identite, phrase });
  return {
    kek: rendu.kek,
    parametresHex: rendu.parametresHex,
    identifiantEmplacement: identite.identifiantEmplacement,
  };
}

/**
 * Fait tourner UN Worker de dérivation, et le laisse mourir.
 *
 * Un Worker par geste : il se ferme lui-même après avoir répondu (`self.close()`), et son tas — la
 * phrase comprise — s'en va avec lui. C'est plus franc qu'un effacement, que le langage ne permet
 * pas sur une `string` (ADR 0021, décision 7), et c'est un effet du découpage plutôt qu'une promesse.
 * `terminate()` est appelé de ce côté-ci aussi : un Worker qui n'a pas répondu ne doit pas survivre à
 * l'attente de sa réponse.
 */
function dansLeWorkerDeDerivation(urlDuWorker, appel) {
  const worker = new Worker(urlDuWorker, {
    type: "module",
    name: "vault-derivation",
  });
  return new Promise((rendre, refuser) => {
    const finir = (geste) => {
      worker.terminate();
      geste();
    };
    worker.addEventListener("message", (event) => {
      const rendu = event.data ?? {};
      if (rendu.ok) return finir(() => rendre(rendu));
      finir(() =>
        refuser(
          Object.assign(new Error(rendu.message ?? "dérivation refusée"), { code: rendu.code }),
        ),
      );
    });
    worker.addEventListener("error", (event) => {
      finir(() =>
        refuser(
          Object.assign(new Error(`Le Worker de dérivation a échoué : ${event.message}`), {
            code: CODES_REFUS_COQUILLE.typeInconnu,
          }),
        ),
      );
    });
    worker.postMessage(appel);
  });
}

/**
 * DÉRIVE la KEK d'une passkey, DANS LA PAGE, et rend ce que le Worker attend.
 *
 * `navigator.credentials` n'existe pas dans un Worker (ADR 0021, décision 5) : cet appel DOIT
 * partir d'un document, et c'est la seule dérivation que la coquille fasse elle-même. Ce qui repart
 * vers le Worker est la `CryptoKey` NON EXTRACTIBLE ; la sortie PRF brute ne quitte jamais cette
 * page, et aucune variable de ce module ne la retient.
 *
 * Deux chemins, et ils ne se confondent pas :
 *
 *  - le coffre EXISTE et porte un emplacement `webauthn-prf` : une ASSERTION refait la KEK sous les
 *    paramètres publics déjà écrits, que le Worker a rendus en hexadécimal ;
 *  - le coffre n'existe pas : un ENREGISTREMENT crée la passkey, et la page rend les paramètres
 *    publics avec la clé, pour que le Worker pose l'enveloppe sous exactement cet emplacement.
 */
async function deriverPasskey({ inventaire, demanderAuWorker }) {
  const existant = (inventaire?.emplacements ?? []).find(
    (emplacement) => emplacement.typeKek === TYPES_KEK["webauthn-prf"],
  );
  const derivateur = derivateurWebauthnPrf();
  if (existant !== undefined) {
    const kek = await derivateur.deriver({
      parametres: octetsDeLHex(existant.parametresHex),
      identite: {
        identifiantVolume: inventaire.identifiantVolume,
        identifiantEmplacement: existant.identifiantEmplacement,
      },
      // La BORNE est celle de la coquille, aux DEUX appels. Sans elle, un moteur sans
      // authentificateur laisse la promesse en suspens une MINUTE — le défaut de la première
      // exécution de #162 en intégration continue : `#deverrouillage-refus` restait vide pendant que
      // la page attendait le délai par défaut du module.
      geste: { delaiMs: DELAI_PASSKEY_MS },
    });
    return { kek };
  }
  const enregistre = await enregistrerEmplacementPrf({
    rpId: location.hostname,
    nomUtilisateur: "vault",
    identifiantUtilisateur: crypto.getRandomValues(new Uint8Array(16)),
    delaiMs: DELAI_PASSKEY_MS,
  });
  // L'identité de l'emplacement est DEMANDÉE au Worker de confiance, et non recopiée ici : la KEK y
  // est liée par son info HKDF (ADR 0021), et l'identifiant de volume que le Worker pose est la
  // seule vérité sur ce point. La page en tenait une COPIE, avec un cliquet pour la surveiller ; la
  // demander est plus court, et ne peut pas diverger.
  const prepare = await demanderAuWorker("preparation", { moyen: "webauthn-prf" });
  const kek = await derivateur.deriver({
    parametres: enregistre.parametres,
    identite: {
      identifiantVolume: prepare.identifiantVolume,
      identifiantEmplacement: prepare.identifiantEmplacement,
    },
    geste: {},
  });
  return {
    kek,
    parametresHex: octetsEnHex(enregistre.parametres),
    identifiantEmplacement: prepare.identifiantEmplacement,
  };
}

/** Relit une chaîne hexadécimale en octets. La page n'importe pas le décodeur du format pour cela. */
function octetsDeLHex(hex) {
  return Uint8Array.from(String(hex).match(/../g) ?? [], (paire) => Number.parseInt(paire, 16));
}
