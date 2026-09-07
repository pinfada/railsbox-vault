// Le WORKER DE DÉRIVATION de la coquille de produit (#162, ADR 0029, décision 5).
//
// Il fait UNE chose : dériver une KEK d'une phrase, par Argon2id calibré, et la rendre à la page
// sous la forme d'une `CryptoKey` NON EXTRACTIBLE. Puis il meurt.
//
// ## Pourquoi il existe, et pourquoi la file n'était pas le problème
//
// La première rédaction de #162 dérivait la phrase dans le WORKER DE CONFIANCE, en s'appuyant sur la
// décision 5 de l'[ADR 0021](../docs/decisions/0021-derivation-des-cles-de-deverrouillage.md) :
// « Argon2id calibré coûte quelques centaines de millisecondes de calcul continu ; le faire sur le
// fil de la page gèlerait l'interface ». C'est vrai, et cela ne dit pas DANS QUEL Worker.
//
// Le Worker de confiance était le mauvais, et la revue de sécurité de la
// [PR #167](https://github.com/pinfada/railsbox-vault/pull/167) l'a MESURÉ : `argon2Vendu` appelle
// le module WebAssembly de façon SYNCHRONE, si bien que le fil du Worker ne dispatche plus aucun
// message pendant tout le calcul — 1 777 à 2 158 ms sous Firefox. Or ce Worker-là sert aussi la
// question d'ÉTAT que la coquille relaie pour le DOCUMENT APPLICATIF : le seul geste admis restait
// SANS RÉPONSE pendant qu'un utilisateur tapait sa phrase, ce que « un refus typé, jamais un
// silence » interdit, et sur le témoin positif de `SEC-ORIGIN-001` par-dessus le marché.
//
// La première correction avait sorti la question d'état de la FILE de promesses du Worker. Elle ne
// pouvait rien : il n'y a pas de file qui tienne quand le fil lui-même est pris. **Ce fichier est la
// correction juste** — un fil de plus, qui n'a rien d'autre à faire que ce calcul.
//
// ## Ce qu'il ne détient pas, et ne peut pas atteindre
//
// Il ne touche ni l'OPFS, ni l'enveloppe, ni le volume, ni le port privilégié. Il ne connaît que ce
// qu'on lui passe : une phrase, des paramètres publics, une identité d'emplacement. Il n'importe
// aucun module de stockage — `tests/unit/coquille-deverrouillage.test.mjs` le vérifie sur ses
// imports, parce qu'une propriété qui tient à ce qu'un fichier ne fasse pas quelque chose se relit
// mieux qu'elle ne se croit.
//
// **Il MEURT après usage** (`self.close()`), et c'est ce que la décision 7 de l'ADR 0021 permet de
// mieux qu'un effacement : la phrase est une `string` JavaScript, impossible à écraser depuis le
// langage — mais le TAS entier de ce Worker, lui, disparaît avec lui. C'est une fenêtre refermée
// plus franchement que partout ailleurs dans le produit, et c'est un effet du découpage, pas une
// promesse cryptographique : le moteur décide quand il rend la mémoire.
//
// ## Ce qui en sort
//
// Une `CryptoKey` non extractible, par clonage structuré. Jamais des octets : ni la phrase, ni le
// matériau HKDF, ni la KEK développée. La sonde d'exfiltration de
// `tests/browser/coquille-deverrouillage.spec.mjs` fouille les DEUX SENS de ce port comme elle
// fouille ceux des autres.

import {
  CALIBRATION_PHRASE,
  derivateurPhrase,
  parametresDePhrase,
  tirerSelDePhrase,
} from "/src/vm/derivation/derivateur-phrase.mjs";
import { hexEnOctets, octetsEnHex } from "/src/vm/format-chiffre/octets.mjs";

/**
 * Le dérivateur, construit à l'évaluation du module.
 *
 * `argon2Vendu()` ne charge rien à la construction — l'artefact est récupéré au premier hachage, et
 * son empreinte vérifiée alors. Le construire ici évite un aller-retour de plus au moment où
 * l'utilisateur attend.
 */
const DERIVATEUR = derivateurPhrase();

self.addEventListener("message", async (event) => {
  const { id, phrase, parametresHex, identifiantVolume, identifiantEmplacement } = event.data ?? {};
  try {
    // Les paramètres viennent de l'appelant quand l'emplacement EXISTE — ils sont publics, écrits en
    // clair dans le fichier d'enveloppes (ADR 0020) — et sont TIRÉS ici pour un emplacement neuf,
    // sous la calibration de l'ADR 0021. Les laisser choisir à l'appelant dans ce second cas
    // rouvrirait la porte que le plancher de la RFC 9106 ferme.
    const parametres =
      typeof parametresHex === "string" && parametresHex.length > 0
        ? hexEnOctets(parametresHex)
        : parametresDePhrase({ sel: tirerSelDePhrase(), ...CALIBRATION_PHRASE });
    const kek = await DERIVATEUR.deriver({
      parametres,
      identite: { identifiantVolume, identifiantEmplacement },
      geste: { phrase: String(phrase ?? "") },
    });
    // La KEK est une `CryptoKey` non extractible : ce qui franchit ce port est un handle opaque, et
    // les paramètres qui l'accompagnent sont publics par construction.
    self.postMessage({ id, ok: true, kek, parametresHex: octetsEnHex(parametres) });
  } catch (erreur) {
    self.postMessage({
      id,
      ok: false,
      code: typeof erreur?.code === "string" ? erreur.code : null,
      message: erreur?.message ?? String(erreur),
    });
  } finally {
    // Le tas de ce Worker — la phrase comprise — disparaît avec lui. Voir l'en-tête : c'est un effet
    // du découpage, pas une promesse.
    self.close();
  }
});
