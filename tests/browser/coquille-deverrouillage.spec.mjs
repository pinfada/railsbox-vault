// Le DÉVERROUILLAGE depuis la COQUILLE DE PRODUIT, sur les trois moteurs (#162, ADR 0029).
//
// C'est la suite que `SEC-RECOVERY-001` attendait. Sa réserve disait : « le mécanisme est éprouvé
// de bout en bout ; la réserve qui reste est qu'aucun chemin de production ne l'offre à un
// UTILISATEUR (#24) ». Ici, le chemin de production EST l'objet de la mesure — `public/index.html`,
// `public/main.mjs`, `public/runtime-worker.mjs` —, et les gestes sont ceux d'un utilisateur : on
// tape dans un champ, on clique sur un bouton, on lit ce que la page affiche.
//
// ## Ce qu'elle établit, et que `deverrouillage-frontiere.spec.mjs` n'établit pas
//
// Celle-là mesure les BANCS de #22 : un Worker de banc, une page de banc, des scénarios appelés
// depuis `page.evaluate`. Elle a prouvé qu'Argon2id calcule juste, qu'une phrase ouvre un volume
// réel, et que rien du secret ne se dépose. Elle n'a jamais prouvé qu'un UTILISATEUR pouvait faire
// ces gestes, parce qu'aucun chemin ne les lui offrait.
//
//  1. **les trois moyens ouvrent depuis la coquille** — phrase, code de récupération, passkey ;
//  2. **l'attente est annoncée AVANT d'être subie** — l'annonce est peinte pendant que la
//     dérivation calcule, et les deux délais sont mesurés depuis le geste ;
//  3. **le code est rendu UNE fois** — la feuille porte le code et la version d'enveloppe, et un
//     second geste rend `VAULT_DERIVATION_CODE_DEJA_RENDU` ;
//  4. **l'ancre de version est une SAISIE** — transmise au Worker et opposée ; vide, la coquille
//     AVOUE ce qu'elle ne protège plus ;
//  5. **le code mal recopié est refusé AVANT toute dérivation** — le Worker ne le voit jamais ;
//  6. **le jeton du harnais n'a plus aucun chemin de produit** ;
//  7. **rien du secret ne se dépose** — la SONDE de #22, étendue à la coquille : appât, six
//     stockages, OPFS en texte et en hexadécimal, les DEUX SENS du port privilégié ET du port
//     restreint, pour la phrase, le code sous ses deux formes, ses octets et son matériau HKDF.
//
// ## La sonde est instrumentée par l'ÉPREUVE, jamais par le produit
//
// Le banc de #22 tient lui-même un journal de ce qui franchit son port : `reponses` et `envois`
// sont des tableaux du module de page. Ce chemin-ci ne peut pas se le permettre — un journal du
// canal privilégié dans la coquille de produit serait un endroit de plus où le code de récupération
// survit, dans un tableau que personne ne pense à effacer, et il aurait fallu l'exclure de la sonde
// pour que la sonde passe.
//
// L'enregistreur est donc posé par `page.addInitScript`, AVANT tout script de la page, sur
// `MessagePort.prototype`. Il est strictement plus fort que le journal du banc : il voit tout ce
// qui franchit un port, y compris ce que le produit n'a pas retenu. Et il ne vit que dans
// l'épreuve — l'arbre publié ne le porte pas.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test } from "../support/test.mjs";

import { ATTENTE_MESUREE } from "../../src/coquille/attente-annoncee.mjs";
import { DELAI_PASSKEY_MS } from "../../src/coquille/moyens-de-deverrouillage.mjs";
import {
  AVERTISSEMENT_SANS_RECUPERATION,
  AVEU_SANS_ANCRE,
} from "../../src/coquille/feuille-de-recuperation.mjs";
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { SHELL_ORIGIN, SHELL_PORT } from "../../src/spike/origin-topology.mjs";
import {
  CODE_OCTETS,
  decoderCode,
  encoderCode,
} from "../../src/vm/derivation/code-de-recuperation.mjs";
import { DERIVATION_ERROR_CODES } from "../../src/vm/derivation/derivation-errors.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { HARNAIS_CLE_JETON } from "../../src/vm/cle-de-volume.mjs";
import { sonder } from "./sonde-des-stockages.mjs";

/** La phrase des épreuves. Elle est PUBLIQUE et sans valeur : c'est un marqueur, pas un secret. */
const PHRASE = "marqueur-de-phrase-de-la-coquille-162-cheval-batterie-agrafe-correcte";

/** L'appât de la sonde : la même forme qu'un secret, pour prouver que la fouille trouve. */
const APPAT = "appat-de-sonde-162-ce-texte-doit-etre-trouve";

/**
 * Les nœuds où le code de récupération est DÉLIBÉRÉMENT écrit, retirés avant la fouille du DOM.
 *
 * La sonde vérifie qu'il n'a pas ESSAIMÉ ailleurs dans la page, pas qu'il n'est nulle part : la
 * feuille est le seul endroit où il vive, et c'est sa raison d'être.
 */
const NOEUDS_DU_CODE = Object.freeze(["feuille-code", "feuille-consigne"]);

/** Délai large et EXPLICITE : Firefox paie deux secondes par dérivation, et douze projets tournent. */
const DELAI = 60000;

/**
 * Le budget que le document applicatif s'accorde sur le port restreint, RELU de la fixture.
 *
 * C'est le chiffre qui décide si une lenteur est un SILENCE, et c'est donc lui que la mesure de
 * famine oppose au Worker de confiance. Le recopier ici en ferait deux, qui divergeraient.
 */
const DELAI_DU_PORT_HOSTILE = Number(
  (await readFile(new URL("../../public/coquille-epreuve/hostile.mjs", import.meta.url), "utf8"))
    .match(/const DELAI_PORT_MS = (\d+);/)
    .at(1),
);

/**
 * Pose l'enregistreur de ports AVANT tout script de la page.
 *
 * Il patche `MessagePort.prototype` : `postMessage` pour le sens page → Worker, et
 * `addEventListener` pour envelopper les écouteurs et voir le sens Worker → page. Une `CryptoKey`
 * n'a pas de représentation textuelle — c'est précisément la propriété mesurée : elle passe sans se
 * lire, et le sérialiseur la remplace par une étiquette.
 */
async function installerLEnregistreur(page) {
  await page.addInitScript(() => {
    const trafic = { envois: [], recus: [] };
    globalThis.__traficDesPorts = trafic;
    const texte = (valeur) => {
      try {
        return JSON.stringify(valeur, (_cle, brut) =>
          brut instanceof CryptoKey ? `[CryptoKey extractable=${brut.extractable}]` : brut,
        );
      } catch (erreur) {
        return `[non sérialisable ${erreur?.name ?? "Error"}]`;
      }
    };
    const posteur = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (donnee, ...reste) {
      trafic.envois.push(texte(donnee));
      return posteur.call(this, donnee, ...reste);
    };
    // Le PORT PRIVILÉGIÉ, retenu au premier `start()` : c'est celui que la coquille ouvre vers son
    // Worker de confiance, et le seul que la sonde ci-dessous interroge.
    const demarrer = MessagePort.prototype.start;
    MessagePort.prototype.start = function (...reste) {
      if (globalThis.__portPrivilegie === undefined) globalThis.__portPrivilegie = this;
      return demarrer.call(this, ...reste);
    };
    const inscrire = MessagePort.prototype.addEventListener;
    MessagePort.prototype.addEventListener = function (nom, ecouteur, ...reste) {
      if (nom !== "message" || typeof ecouteur !== "function") {
        return inscrire.call(this, nom, ecouteur, ...reste);
      }
      return inscrire.call(
        this,
        nom,
        (evenement) => {
          trafic.recus.push(texte(evenement.data));
          return ecouteur(evenement);
        },
        ...reste,
      );
    };

    // Une question d'ÉTAT posée depuis la page, sur le canal privilégié — celui-là même que la
    // dérivation bloquait. Elle emprunte le port que la coquille a établi, sans rien changer au
    // produit : l'enregistreur ci-dessus le retient au passage, et la mesure de famine s'en sert.
    globalThis.__interrogerLaCoquille = () =>
      new Promise((rendre) => {
        const port = globalThis.__portPrivilegie;
        if (port === undefined) return rendre(null);
        const correlation = `sonde-${globalThis.__sonde++}`;
        const ecouteur = (evenement) => {
          if (evenement.data?.correlation !== correlation) return;
          port.removeEventListener("message", ecouteur);
          rendre(evenement.data);
        };
        port.addEventListener("message", ecouteur);
        port.postMessage({
          contrat: "railsbox-vault-coquille",
          version: 1,
          type: "vault.coquille.etat-prive",
          correlation,
        });
      });
    globalThis.__sonde = 0;

    // L'ANNONCE, observée plutôt que surprise en vol.
    //
    // Elle est peinte avant la dérivation et effacée dès que la réponse arrive : la chercher par un
    // sondage mesurerait la vitesse du moteur plutôt que l'ordre des gestes, et sur un moteur où le
    // geste échoue vite — WebKit, sans OPFS synchrone — la fenêtre se referme en quelques
    // millisecondes. Un `MutationObserver` retient TOUT ce qui a été écrit là, si bien que
    // l'épreuve juge une trace et non un instant.
    globalThis.__annoncesPeintes = [];
    addEventListener("DOMContentLoaded", () => {
      const noeud = document.querySelector("#deverrouillage-attente");
      if (noeud === null) return;
      new MutationObserver(() => {
        const texte = noeud.textContent;
        if (texte !== "") globalThis.__annoncesPeintes.push(texte);
      }).observe(noeud, { childList: true, characterData: true, subtree: true });
    });
  });
}

/**
 * Ouvre la coquille de produit et attend que son interface soit MONTÉE. Aucun paramètre, aucun jeton.
 *
 * Ce qu'on attend n'est PAS `data-coquille="prete"`, et l'écart a un motif : « prête » dit que le
 * cadre applicatif a été créé, ce qui suppose une origine applicative dérivable. Les épreuves de
 * passkey joignent la coquille par `localhost` — WebAuthn refuse une IP comme `rpId` —, et de cet
 * hôte-là la dérivation de l'ADR 0002 ne rend rien : la coquille se termine alors en `sans-cadre`,
 * ce qui est sa conduite juste et n'a rien à voir avec le déverrouillage. Le signal de disponibilité
 * du déverrouillage est donc l'interface elle-même.
 *
 * `commit` plutôt que le `load` par défaut, et ce n'est pas une commodité : le `load` du document de
 * la coquille attend le CADRE APPLICATIF, créé dynamiquement sur une autre origine, alors que ce que
 * l'épreuve attend est l'interface — la ligne suivante, qui est une vraie attente. Ce couplage a
 * produit des expirations sur Firefox, relevées par la revue de sécurité de la PR #177 et par le
 * gate ; il n'apportait rien à aucune épreuve de cette suite.
 */
async function ouvrirLaCoquille(page, parametres = {}, origine = SHELL_ORIGIN) {
  const url = new URL("/index.html", origine);
  for (const [nom, valeur] of Object.entries(parametres)) url.searchParams.set(nom, valeur);
  await page.goto(url.toString(), { waitUntil: "commit" });
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
}

/** Recharge la coquille et attend le même signal. Les épreuves rouvrent souvent. */
async function rouvrirLaCoquille(page) {
  await page.reload();
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
}

async function releve(page) {
  return JSON.parse(await page.locator("#coquille-rapport").textContent());
}

async function releveDeLInterface(page) {
  return JSON.parse(await page.locator("#deverrouillage-releve").textContent());
}

/**
 * Ce moteur sait-il ouvrir un volume ?
 *
 * WebKit n'offre pas l'accès synchrone à l'OPFS dans un Worker (`docs/compatibility.md` : « refusé
 * (OPFS absent) »). L'absence est rendue comme un ÉTAT — `indisponible` — et non comme un refus de
 * geste, parce que ce n'est pas le geste qui a échoué. Les épreuves qui touchent un volume EXIGENT
 * alors cet état ; un succès y ferait échouer la suite autant qu'un plantage.
 */
async function porte(page) {
  // La PHRASE est présentée : un champ vide rendrait `VAULT_DERIVATION_PHRASE_REFUSEE` — « une
  // phrase absente n'est pas une phrase fausse » —, et la sonde mesurerait ce refus-là au lieu de
  // la capacité du moteur.
  await page.locator("#saisie-phrase").fill(PHRASE);
  await page.locator("#ouvrir-par-phrase").click();
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: DELAI })
    .not.toBe(ETATS_DU_VOLUME.verrouille);
  return (await releve(page)).etat !== ETATS_DU_VOLUME.indisponible;
}

/**
 * L'ÉTAT que ce moteur peut atteindre, et ce qu'un scénario de volume doit alors EXIGER de lui.
 *
 * WebKit n'offre pas l'accès synchrone à l'OPFS dans un Worker (`docs/compatibility.md` : « refusé
 * (OPFS absent) »). La convention du dépôt est celle de `deverrouillage-frontiere.spec.mjs` : un
 * scénario qui touche un volume EXIGE là-bas un refus TYPÉ — jamais un succès, jamais un plantage,
 * et jamais un `test.skip` qui maquillerait la limite en silence.
 *
 * Ce qui est exigé quand le volume est hors d'atteinte : l'état DIT l'absence (`indisponible`, et
 * non `verrouille` — l'un dit « il faut un geste », l'autre « ce moteur ne sait pas »), et le geste
 * qui suit rend son refus typé. Cette fonction porte les deux moitiés, pour qu'aucune épreuve de la
 * suite ne puisse l'oublier.
 */
async function exigerLaLimiteDuMoteur(page, info, nom) {
  const rapport = await releve(page);
  if (rapport.etat !== ETATS_DU_VOLUME.indisponible) return false;
  await attacher(info, `limite-${nom}`, {
    moteur: info.project.name,
    etat: rapport.etat,
    limite:
      "Ce moteur n'offre pas l'accès synchrone à l'OPFS dans un Worker : aucun volume n'est " +
      "atteignable. L'absence est rendue comme un ÉTAT, et le geste qui la rencontre rend un refus " +
      "TYPÉ. La limite est écrite, pas maquillée.",
  });
  // Le geste qui EXIGE un volume ouvert rend son refus typé, ici comme ailleurs : c'est ce qui
  // distingue « ce moteur ne sait pas » d'un plantage, et c'est ce que la convention demande.
  await page.locator("#creer-recuperation").click();
  await expect(page.locator("#deverrouillage-refus")).toContainText(
    CODES_REFUS_COQUILLE.volumeVerrouille,
    { timeout: DELAI },
  );
  return true;
}

/**
 * L'état qu'un moteur SANS volume atteignable doit publier, et celui de tous les autres.
 *
 * Les deux sont affirmés, jamais l'un au détriment de l'autre : `not.toBe(ouvert)` aurait laissé
 * passer les deux, et exiger `verrouille` partout fait rougir WebKit sur sa conduite juste. C'est
 * le défaut qu'une exécution en intégration continue a relevé sur `8d09085`.
 */
async function exigerLEtatFerme(page) {
  const etat = (await releve(page)).etat;
  expect([ETATS_DU_VOLUME.verrouille, ETATS_DU_VOLUME.indisponible]).toContain(etat);
  return etat;
}

/** Ouvre le coffre par la phrase : on tape, on clique, on attend l'état. Le geste d'un utilisateur. */
async function ouvrirParLaPhrase(page, phrase = PHRASE) {
  await page.locator("#saisie-phrase").fill(phrase);
  await page.locator("#ouvrir-par-phrase").click();
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: DELAI })
    .not.toBe(ETATS_DU_VOLUME.verrouille);
  return (await releve(page)).etat;
}

/** Crée le moyen de récupération et rend ce que la FEUILLE affiche. */
async function creerLaFeuille(page) {
  await page.locator("#creer-recuperation").click();
  await expect(page.locator("#feuille-code")).not.toBeEmpty({ timeout: DELAI });
  return {
    code: (await page.locator("#feuille-code").textContent()).trim(),
    version: (await page.locator("#feuille-version").textContent()).trim(),
    consigne: (await page.locator("#feuille-consigne").textContent()).trim(),
  };
}

function attacher(testInfo, nom, contenu) {
  return testInfo.attach(`coquille-deverrouillage-${nom}-${testInfo.project.name}.json`, {
    body: JSON.stringify(contenu, null, 2),
    contentType: "application/json",
  });
}

test.beforeEach(async ({ page }) => {
  await installerLEnregistreur(page);
});

// --- (a) La phrase, et l'attente ANNONCÉE avant d'être subie ---------------------------------------

test("une PHRASE ouvre le coffre depuis la coquille, et l'attente est annoncée AVANT", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page);
  // La coquille reste « prête » au sens de #161 : le cadre applicatif est créé, et le déverrouillage
  // n'y change rien. C'est la garantie que cette tranche n'a pas déplacé l'ordre du cycle de vie.
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: DELAI });
  // Rien n'est ouvert au chargement : la coquille se dit « prête » quand son canal privilégié est
  // établi, pas quand un coffre l'est. C'est ce qui distingue #162 de #161, où un paramètre d'URL
  // déverrouillait au démarrage.
  // « pas ouvert », et non « verrouillé » : sur WebKit, la lecture de l'inventaire constate déjà
  // l'absence d'OPFS synchrone dans un Worker et rend `indisponible` — AVANT tout geste, et c'est
  // la conduite juste. L'ADR 0028 distingue les deux : l'un dit « il faut un geste », l'autre dit
  // « ce moteur ne sait pas », et les confondre ferait demander une phrase qui n'ouvrirait rien.
  expect((await releve(page)).etat).not.toBe(ETATS_DU_VOLUME.ouvert);
  await expect(page.locator("#deverrouillage-moyens")).toContainText("Aucun coffre");

  await page.locator("#saisie-phrase").fill(PHRASE);
  await page.locator("#ouvrir-par-phrase").click();

  await expect
    .poll(async () => (await releve(page)).etat, { timeout: DELAI })
    .not.toBe(ETATS_DU_VOLUME.verrouille);

  const rapport = await releve(page);
  const interne = await releveDeLInterface(page);
  const annonces = await page.evaluate(() => globalThis.__annoncesPeintes);
  await attacher(info, "phrase", {
    moteur: info.project.name,
    etat: rapport.etat,
    mesures: rapport.mesures,
    annoncesPeintes: annonces.length,
    interface: interne,
  });

  // L'ANNONCE a été PEINTE, sur les trois moteurs, et elle porte l'ordre de grandeur mesuré. C'est
  // la propriété que la tranche livre : l'attente est annoncée avant d'être subie. L'observateur
  // retient ce qui a été écrit dans le nœud, si bien que l'assertion ne dépend d'aucun instant.
  expect(annonces.some((texte) => texte.includes("coûteuse"))).toBe(true);
  expect(annonces.some((texte) => texte.includes("Dérivation en cours"))).toBe(true);

  if (rapport.etat === ETATS_DU_VOLUME.indisponible) {
    // WebKit : l'état DIT l'absence — l'OPFS synchrone manque au Worker —, et le geste n'est pas
    // compté comme un échec de phrase. L'annonce a tout de même été faite, ci-dessus : la coquille
    // ne sait pas d'avance que ce moteur répondra vite.
    expect(rapport.mesures.annonceApresLeGesteMs).not.toBeNull();
    return;
  }
  expect(rapport.etat).toBe(ETATS_DU_VOLUME.ouvert);
  expect(rapport.journal).toContain("volume-ouvert");

  // Les DEUX délais publiés, depuis le GESTE. L'annonce doit arriver avant l'ouverture : c'est la
  // seule chose que cette mesure affirme, et elle n'affirme aucun seuil — un seuil posé sur un
  // exécutant partagé mesurerait la machine.
  expect(rapport.mesures.annonceApresLeGesteMs).toBeGreaterThanOrEqual(0);
  expect(rapport.mesures.deverrouillageMs).toBeGreaterThanOrEqual(
    rapport.mesures.annonceApresLeGesteMs,
  );
  // L'annonce retenue est celle du moteur reconnu, prise dans la table de l'ADR 0021.
  expect(interne.attenteAnnoncee).toBe(Math.max(...ATTENTE_MESUREE[interne.moteur].p95Ms));
  expect(interne.moyensProposes).toContain("phrase");
});

test("une phrase FAUSSE est refusée par l'enveloppe, sous un code distinct, et rien n'est modifié", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page);
  await ouvrirParLaPhrase(page);
  if (await exigerLaLimiteDuMoteur(page, info, "phrase-fausse")) return;

  await rouvrirLaCoquille(page);
  await page.locator("#saisie-phrase").fill(`${PHRASE}-pas`);
  await page.locator("#ouvrir-par-phrase").click();
  await expect(page.locator("#deverrouillage-refus")).toContainText(
    ENVELOPPE_ERROR_CODES.cleRefusee,
    { timeout: DELAI },
  );
  // Le refus vient de l'ENVELOPPE, jamais du dérivateur : un dérivateur ne sait pas qu'une phrase
  // est fausse, il rend une AUTRE clé. La distinction est celle de l'ADR 0021, rendue à l'écran.
  await expect(page.locator("#deverrouillage-refus")).not.toContainText(
    DERIVATION_ERROR_CODES.codeMalRecopie,
  );
  expect((await releve(page)).etat).toBe(ETATS_DU_VOLUME.verrouille);
});

/**
 * LA FAMINE, mesurée : le Worker de confiance répond PENDANT une dérivation.
 *
 * C'est le constat 2 de la revue de sécurité de la PR #167, et l'épreuve que la décision 5 réécrite
 * doit désormais tenir. Le défaut, mesuré alors : `argon2Vendu` appelle le module WebAssembly de
 * façon SYNCHRONE, si bien que le fil du Worker de confiance ne dispatchait plus AUCUN message
 * pendant tout le calcul — 1 777 à 2 158 ms sous Firefox. Or ce Worker sert aussi la question
 * d'ÉTAT que la coquille relaie pour le document applicatif : le seul geste admis restait sans
 * réponse pendant qu'un utilisateur tapait sa phrase.
 *
 * La première correction avait sorti cette question de la FILE de promesses du Worker. Elle ne
 * pouvait rien : il n'y a pas de file qui tienne quand le fil est pris. La correction juste est
 * architecturale — la dérivation vit dans un Worker DÉDIÉ —, et c'est ce que cette mesure vérifie.
 *
 * Ce qui est AFFIRMÉ : pendant la dérivation, la question d'état revient sous le délai que la
 * fixture accorde au port restreint. Ce qui est PUBLIÉ, sans seuil : les quantiles au repos et
 * pendant. Un seuil sur les quantiles mesurerait la charge de l'exécutant.
 */
test("le Worker de confiance répond PENDANT une dérivation : la famine est levée", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page);
  if (await exigerLaLimiteDuMoteur(page, info, "famine")) return;

  // Le budget est celui que le document applicatif s'accorde lui-même sur le port restreint
  // (`public/coquille-epreuve/hostile.mjs`). Il est RELU plutôt que recopié : c'est le chiffre qui
  // décide si une lenteur est un silence, et deux écritures divergeraient.
  const budget = DELAI_DU_PORT_HOSTILE;

  const mesurer = (tours) =>
    page.evaluate(async (combien) => {
      const echantillons = [];
      for (let tour = 0; tour < combien; tour += 1) {
        const debut = performance.now();
        await globalThis.__interrogerLaCoquille();
        echantillons.push(performance.now() - debut);
      }
      echantillons.sort((gauche, droite) => gauche - droite);
      const rang = (part) =>
        echantillons[Math.min(echantillons.length - 1, Math.floor(part * echantillons.length))];
      return {
        tours: combien,
        p50Ms: Math.round(rang(0.5) * 10) / 10,
        p95Ms: Math.round(rang(0.95) * 10) / 10,
        maxMs: Math.round(echantillons.at(-1) * 10) / 10,
      };
    }, tours);

  const repos = await mesurer(20);

  // La dérivation est LANCÉE, et n'est pas attendue : ce qui est mesuré est ce qui se passe pendant
  // qu'elle calcule.
  await page.locator("#saisie-phrase").fill(PHRASE);
  const ouverture = page.locator("#ouvrir-par-phrase").click();
  await expect(page.locator("#deverrouillage-attente")).toContainText("coûteuse", {
    timeout: DELAI,
  });
  const pendant = await mesurer(20);
  await ouverture;
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: DELAI })
    .toBe(ETATS_DU_VOLUME.ouvert);

  await attacher(info, "famine", { moteur: info.project.name, budgetMs: budget, repos, pendant });
  // La mesure est ÉCRITE sur la sortie, comme celles de `deverrouillage-frontiere.spec.mjs` : c'est
  // ainsi que le dépôt publie un ordre de grandeur qu'un ADR reprend.
  process.stdout.write(
    `MESURE ${info.project.name} : état au repos p50 ${repos.p50Ms} ms, p95 ${repos.p95Ms} ms, max ${repos.maxMs} ms ; ` +
      `PENDANT une dérivation p50 ${pendant.p50Ms} ms, p95 ${pendant.p95Ms} ms, max ${pendant.maxMs} ms ` +
      `(budget du port restreint : ${budget} ms)
`,
  );

  // Le TÉMOIN de la mesure : sans requêtes servies, « rapide » ne voudrait rien dire.
  expect(repos.tours).toBe(20);
  expect(pendant.tours).toBe(20);
  // Ce que l'épreuve AFFIRME, et c'est la propriété : le MAXIMUM observé pendant la dérivation reste
  // sous le budget du port restreint. Avant la correction, ce maximum valait la dérivation entière.
  expect(
    pendant.maxMs,
    `la question d'état a mis ${pendant.maxMs} ms pendant une dérivation : le fil du Worker de confiance est repris`,
  ).toBeLessThan(budget);
});

/**
 * LE SECOND CLIC, qui est le chemin d'ÉCHEC de `deverrouiller` (constats 5 et 6 de la revue #167).
 *
 * Un geste ordinaire, pas un scénario : l'utilisateur ouvre son coffre, puis clique une seconde fois
 * sur « Ouvrir par la phrase ». Deux défauts vivaient là, et le second cachait le premier :
 *
 *  - `openOpfsVolume` levait `VAULT_STORAGE_BUSY` — le backend précédent était ÉCRASÉ sans être
 *    fermé, si bien que le handle exclusif restait tenu par un objet que plus personne ne
 *    référençait, sur le volume que l'utilisateur venait d'ouvrir lui-même ;
 *  - et cette levée passait AVANT `dek.fill(0)` : les octets en clair de la clé de volume restaient
 *    dans le tas du Worker de confiance. La correction est un `try/finally`, et ce clic-ci est ce
 *    qui l'atteint.
 *
 * Ce que l'épreuve peut voir de l'extérieur : le coffre reste OUVERT, aucun refus n'est affiché, et
 * une barrière de plus est acquittée. L'effacement de la DEK, lui, n'est pas observable depuis une
 * page — c'est `tools/muter-gardes-coquille.mjs` qui montre que le `finally` sait rougir.
 */
test("un SECOND déverrouillage sur un coffre déjà ouvert le rouvre proprement", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page);
  await ouvrirParLaPhrase(page);
  if (await exigerLaLimiteDuMoteur(page, info, "second-clic")) return;
  const premier = await releve(page);
  expect(premier.etat).toBe(ETATS_DU_VOLUME.ouvert);

  await page.locator("#saisie-phrase").fill(PHRASE);
  await page.locator("#ouvrir-par-phrase").click();
  await expect
    .poll(async () => (await releve(page)).barrieres, { timeout: DELAI })
    .toBeGreaterThan(premier.barrieres);

  const second = await releve(page);
  await attacher(info, "second-clic", {
    moteur: info.project.name,
    premier: { etat: premier.etat, barrieres: premier.barrieres },
    second: { etat: second.etat, barrieres: second.barrieres },
    refus: await page.locator("#deverrouillage-refus").textContent(),
  });

  // Aucun refus, et surtout pas `VAULT_STORAGE_BUSY` : le backend précédent est fermé avant que le
  // suivant ne s'ouvre. Ce code n'est d'ailleurs dans aucune conduite — il n'a rien à dire à un
  // utilisateur, parce qu'il ne doit plus lui arriver.
  await expect(page.locator("#deverrouillage-refus")).toBeEmpty();
  expect(second.etat).toBe(ETATS_DU_VOLUME.ouvert);
});

// --- (b) et (c) Le CODE de récupération : rendu une fois, saisi sous forme humaine -----------------

test("le code est rendu UNE fois avec sa version, et un second geste est refusé", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page);
  await ouvrirParLaPhrase(page);
  if (await exigerLaLimiteDuMoteur(page, info, "feuille")) return;

  // AVANT toute création : le coffre n'a aucun moyen de récupération, et la coquille le DIT. C'est
  // l'avertissement de `recovery: null` (ADR 0027, limite 6), montré là où la coquille le peut.
  await expect(page.locator("#deverrouillage-sans-recuperation")).toContainText(
    AVERTISSEMENT_SANS_RECUPERATION.slice(0, 40),
  );

  const feuille = await creerLaFeuille(page);
  await attacher(info, "feuille", {
    moteur: info.project.name,
    // Le CODE n'est pas attaché : un relevé de test finit dans un artefact de CI, et un secret rendu
    // une fois n'a rien à y faire. Sa forme suffit à juger.
    forme: feuille.code.replace(/[0-9A-Z]/g, "X"),
    version: feuille.version,
  });

  expect(feuille.code, "vingt-huit symboles en sept groupes de quatre").toMatch(
    /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/,
  );
  // La FEUILLE, c'est-à-dire les deux ensemble : sans la version, l'ancre reste vide et le plancher
  // de rejeu inopposable (ADR 0027, décision 3).
  expect(feuille.version).toMatch(/Version d'enveloppe : \d+/);
  expect(feuille.consigne).toContain("seconde fois");
  await expect(page.locator("#version-a-noter")).toContainText("Corrigez-la sur votre feuille");
  // Et l'avertissement de `recovery: null` a disparu : il y a désormais un moyen.
  await expect(page.locator("#deverrouillage-sans-recuperation")).toBeEmpty();

  // SECOND geste : un refus typé, jamais la chaîne. La garde est celle du PORTEUR de l'ADR 0025,
  // exercée ici depuis un chemin de produit.
  await page.locator("#creer-recuperation").click();
  await expect(page.locator("#deverrouillage-refus")).toContainText(
    DERIVATION_ERROR_CODES.codeDejaRendu,
    { timeout: DELAI },
  );
  expect((await page.locator("#feuille-code").textContent()).trim()).toBe(feuille.code);
});

test("le code, saisi sous une forme HUMAINE, rouvre le coffre depuis la coquille", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page);
  await ouvrirParLaPhrase(page);
  if (await exigerLaLimiteDuMoteur(page, info, "code-humain")) return;
  const feuille = await creerLaFeuille(page);

  await rouvrirLaCoquille(page);
  await expect(page.locator("#deverrouillage-moyens")).toContainText("code de récupération");

  // Minuscules, espaces au lieu des tirets, « o » et « l » pour les chiffres qu'ils imitent : ce
  // qu'un utilisateur retape d'une feuille de papier, et non ce que le produit a rendu.
  const humain = feuille.code
    .toLowerCase()
    .replaceAll("-", " ")
    .replaceAll("0", "o")
    .replaceAll("1", "l");
  await page.locator("#saisie-code").fill(humain);
  // L'AIDE À LA SAISIE : la découpe rend à l'utilisateur ce que le produit avait écrit.
  await expect(page.locator("#code-decoupe")).toHaveText(feuille.code);
  await expect(page.locator("#ouvrir-par-code")).toBeEnabled();

  // Le code n'annonce AUCUNE attente : il coûte des millisecondes, pas des secondes.
  await page.locator("#ouvrir-par-code").click();
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: DELAI })
    .toBe(ETATS_DU_VOLUME.ouvert);
  const rapport = await releve(page);
  await attacher(info, "code", { moteur: info.project.name, mesures: rapport.mesures });
  expect((await releveDeLInterface(page)).attenteAnnoncee).toBeNull();
  await expect(page.locator("#deverrouillage-attente")).toBeEmpty();
  // Et le champ a été VIDÉ : le code ne reste pas dans le DOM après l'envoi.
  await expect(page.locator("#saisie-code")).toHaveValue("");
});

// --- (f) « mal recopié » tombe AVANT toute dérivation ---------------------------------------------

test("un code MAL RECOPIÉ est refusé avant tout envoi : le Worker ne le voit jamais", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page);
  await ouvrirParLaPhrase(page);
  if (await exigerLaLimiteDuMoteur(page, info, "code-mal-recopie")) return;
  const feuille = await creerLaFeuille(page);
  await rouvrirLaCoquille(page);

  const dernier = feuille.code.at(-1) === "0" ? "1" : "0";
  const abime = `${feuille.code.slice(0, -1)}${dernier}`;
  await page.locator("#saisie-code").fill(abime);

  await expect(page.locator("#code-verdict")).toContainText("somme de contrôle");
  await expect(page.locator("#ouvrir-par-code")).toBeDisabled();

  // Le VERDICT du produit : rien n'est parti. Le trafic des ports ne porte pas le code abîmé, et
  // c'est ce qui distingue « refusé avant de dériver » de « refusé après ».
  const trafic = await page.evaluate(() => globalThis.__traficDesPorts.envois.join("\n"));
  expect(trafic.includes(abime)).toBe(false);
  expect(trafic.includes(abime.replaceAll("-", ""))).toBe(false);
});

// --- (e) L'ancre de version : saisie, transmise, opposée ; vide, AVOUÉE ----------------------------

test("la version SAISIE est transmise et OPPOSÉE ; une enveloppe antérieure est refusée", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page);
  await ouvrirParLaPhrase(page);
  if (await exigerLaLimiteDuMoteur(page, info, "ancre")) return;
  // La VERSION d'enveloppe réelle, lue de la coquille — et non le nombre de moyens proposés, que la
  // première rédaction avait pris pour elle (constat 12 de la revue de la PR #167). C'est elle que
  // les deux moitiés de l'épreuve encadrent : une version notée TROP HAUT refuse, la même version
  // notée JUSTE ouvre.
  const versionReelle = (await page.locator("#deverrouillage-moyens").textContent()).match(
    /version d'enveloppe (\d+)/,
  );
  expect(
    versionReelle,
    "la coquille doit dire la version d'enveloppe qu'elle a ouverte",
  ).not.toBeNull();
  const version = Number(versionReelle[1]);
  expect(version).toBeGreaterThan(0);

  await rouvrirLaCoquille(page);

  // Une version notée PLUS HAUTE que celle de l'enveloppe : c'est exactement le cas de la limite 4
  // de l'ADR 0027 — « une version recopiée TROP HAUT refuse une enveloppe saine, et le refus doit
  // dire quoi faire ». C'est aussi la preuve que `versionMinimale` a bien voyagé jusqu'au Worker :
  // sans transmission, l'enveloppe s'ouvrirait sans rien dire.
  await page.locator("#ancre-version").fill("9999");
  await expect(page.locator("#ancre-aveu")).toContainText("Version 9999 exigée");
  await page.locator("#saisie-phrase").fill(PHRASE);
  await page.locator("#ouvrir-par-phrase").click();
  await expect(page.locator("#deverrouillage-refus")).toContainText(ENVELOPPE_ERROR_CODES.rejeu, {
    timeout: DELAI,
  });
  // Le REPLI est nommé, dans ses deux moitiés, dont le geste explicite.
  await expect(page.locator("#deverrouillage-refus")).toContainText("relisez la version");
  await expect(page.locator("#deverrouillage-refus")).toContainText("videz le champ");
  expect((await releve(page)).etat).toBe(ETATS_DU_VOLUME.verrouille);

  // La version JUSTE, elle, ouvre : c'est la moitié qui donne son sens au refus ci-dessus. Sans
  // elle, « 9999 refuse » pourrait vouloir dire « toute version refuse ».
  await page.locator("#ancre-version").fill(String(version));
  await page.locator("#saisie-phrase").fill(PHRASE);
  await page.locator("#ouvrir-par-phrase").click();
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: DELAI })
    .toBe(ETATS_DU_VOLUME.ouvert);
  expect((await releveDeLInterface(page)).versionExigee).toBe(version);

  // Le champ vidé, le MÊME geste ouvre — et la coquille AVOUE ce qu'elle ne protège plus.
  await rouvrirLaCoquille(page);
  await page.locator("#ancre-version").fill("");
  await expect(page.locator("#ancre-aveu")).toHaveText(AVEU_SANS_ANCRE);
  await page.locator("#saisie-phrase").fill(PHRASE);
  await page.locator("#ouvrir-par-phrase").click();
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: DELAI })
    .toBe(ETATS_DU_VOLUME.ouvert);
  await attacher(info, "ancre", {
    moteur: info.project.name,
    versionExigee: (await releveDeLInterface(page)).versionExigee,
  });
  expect((await releveDeLInterface(page)).versionExigee).toBeNull();
});

// --- (g) Le jeton du harnais n'a plus AUCUN chemin de produit ---------------------------------------

test("le jeton du harnais ne déverrouille plus rien : l'appelant de PRODUIT n'existe plus", async ({
  page,
}) => {
  // #161 lisait ce paramètre et ouvrait le volume. La décision 1 de l'ADR 0029 le retire ; ce que
  // cette épreuve mesure est que le paramètre est désormais INERTE — pas ignoré silencieusement au
  // profit d'un autre chemin, mais sans effet sur l'état.
  await ouvrirLaCoquille(page, { "deverrouillage-harnais": HARNAIS_CLE_JETON });
  const rapport = await releve(page);
  // L'état est celui d'un coffre FERMÉ, et les deux formes sont affirmées : `verrouille` là où un
  // volume est atteignable, `indisponible` là où le moteur n'offre pas d'OPFS synchrone dans un
  // Worker. Exiger `verrouille` partout faisait rougir WebKit sur sa conduite juste — c'est le
  // défaut relevé en intégration continue sur `8d09085`, invisible en local parce que la bascule
  // dépendait de l'instant où le document applicatif posait SA question d'état.
  await exigerLEtatFerme(page);
  expect(
    Object.keys(rapport),
    "le relevé ne doit plus porter le témoin d'un déverrouillage par harnais",
  ).not.toContain("deverrouillageParHarnais");
  const trafic = await page.evaluate(() => globalThis.__traficDesPorts.envois.join("\n"));
  expect(trafic.includes(HARNAIS_CLE_JETON)).toBe(false);
});

// --- (d) La SONDE d'exfiltration, étendue à la coquille ---------------------------------------
//
// La fouille elle-même vit dans `sonde-des-stockages.mjs`, partagée avec #170 : deux copies
// auraient divergé au premier stockage ajouté, et la plus ancienne serait restée verte en
// fouillant moins.

test("AUCUN octet du secret ne se dépose, hors les canaux NOMMÉS de la coquille", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page);
  await ouvrirParLaPhrase(page);
  if (await exigerLaLimiteDuMoteur(page, info, "sonde")) return;
  const feuille = await creerLaFeuille(page);

  const code = feuille.code;
  const octets = decoderCode(code);
  const octetsHex = Buffer.from(octets).toString("hex");
  const materiauHex = createHash("sha256").update(octets).digest("hex");
  const sansTirets = code.replaceAll("-", "");
  const humaine = code.toLowerCase().replaceAll("-", " ").replaceAll("0", "o").replaceAll("1", "l");

  const morceaux = await sonder(page, APPAT, { noeudsARetirer: NOEUDS_DU_CODE });
  await attacher(
    info,
    "sonde",
    morceaux.map(({ ou, texte }) => ({
      ou,
      caracteres: texte.length,
      porteLAppat: texte.includes(APPAT),
      porteLeCode: texte.includes(code),
      portelaPhrase: texte.includes(PHRASE),
    })),
  );

  // TÉMOIN DE FOUILLE. Sans lui, « rien trouvé » pourrait vouloir dire « rien capturé » : la
  // recherche doit d'abord montrer qu'elle sait trouver ce qui EST là.
  const trouves = morceaux.filter(({ texte }) => texte.includes(APPAT)).map(({ ou }) => ou);
  expect(trouves, "la sonde n'a retrouvé son appât nulle part : elle ne mesure rien").toContain(
    "localStorage",
  );
  expect(trouves).toContain("sessionStorage");
  expect(trouves).toContain("cookies");
  expect(trouves).toContain("opfs");

  // SECOND témoin, sur le trafic : les ports ont bien porté quelque chose, et la fouille le voit.
  const recus = morceaux.find(({ ou }) => ou === "ports-recus").texte;
  const envois = morceaux.find(({ ou }) => ou === "ports-envois").texte;
  expect(recus).toContain("vault.coquille.etat-prive-reponse");
  expect(envois).toContain("vault.coquille.deverrouiller");

  // Le CANAL DE RENDU, nommé plutôt que subi : le code passe du Worker de confiance à la page de la
  // MÊME origine, une fois (ADR 0025, décision 3). L'affirmer positivement est ce qui donne un sens
  // à toutes les absences suivantes.
  expect(
    recus.includes(code),
    "le code n'a pas emprunté son canal de rendu : la fouille est vide",
  ).toBe(true);

  for (const { ou, texte } of morceaux) {
    // La PHRASE ne va que dans un sens : page → Worker, à l'intérieur de l'origine de confiance
    // (ADR 0021, limite 4). Partout ailleurs, y compris dans le sens du retour, elle est absente.
    if (ou !== "ports-envois") {
      expect(texte.includes(PHRASE), `la phrase se retrouve dans « ${ou} »`).toBe(false);
    }
    // Le CODE n'a qu'un canal légitime — le retour du Worker —, et le DOM de la feuille, retiré de
    // la fouille. Partout ailleurs, sous toutes ses formes, il est absent.
    if (ou !== "ports-recus") {
      expect(texte.includes(code), `le code se retrouve dans « ${ou} »`).toBe(false);
    }
    expect(texte.includes(sansTirets), `le code sans tirets est dans « ${ou} »`).toBe(false);
    expect(texte.includes(humaine), `la forme humaine du code est dans « ${ou} »`).toBe(false);
    expect(texte.includes(octetsHex), `les seize octets du code sont dans « ${ou} »`).toBe(false);
    expect(texte.includes(materiauHex), `le matériau HKDF du code est dans « ${ou} »`).toBe(false);
  }

  // Et l'autre sens : la page n'a JAMAIS renvoyé le code au Worker dans ce scénario. Elle ne l'a
  // pas non plus recopié dans son relevé — `codeRendu` est un booléen.
  expect(envois.includes(code)).toBe(false);
  expect(JSON.stringify(await releveDeLInterface(page))).not.toContain(code);
});

test("la PAGE de la coquille n'obtient aucun handle sur le fichier d'enveloppes", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  await porte(page);
  const sonde = await page.evaluate(async () => {
    const { openOpfsSyncAccess } = await import("/src/vm/opfs-sync-access.mjs");
    try {
      const handle = await openOpfsSyncAccess("coquille.cles");
      handle.close();
      return { ouvert: true, code: null };
    } catch (erreur) {
      return { ouvert: false, code: typeof erreur.code === "string" ? erreur.code : null };
    }
  });
  expect(sonde.ouvert, "la page a ouvert le fichier de clés en accès exclusif").toBe(false);
});

// --- La PASSKEY, dérivée dans la page ---------------------------------------------------------------

/**
 * WebAuthn refuse une adresse IP comme `rpId` : « This is an invalid domain. »
 *
 * L'origine de confiance du dépôt est `http://127.0.0.1:4173`, et son hôte est une IP. La coquille
 * est donc jointe par son AUTRE nom — le même serveur, la même interface de bouclage, un nom de
 * domaine enregistrable. C'est une contrainte de la spécification WebAuthn, pas une faiblesse de la
 * topologie : en production l'origine de confiance porte un vrai domaine.
 */
const HOTE_WEBAUTHN = `http://localhost:${SHELL_PORT}`;

/** Installe un authentificateur virtuel Chromium, ou rend `null` si ce moteur n'en offre pas. */
async function authentificateurVirtuel(page) {
  if (page.context().browser().browserType().name() !== "chromium") return null;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        hasPrf: true,
      },
    });
    return { cdp, authenticatorId };
  } catch (cause) {
    await cdp.detach().catch(() => {});
    return { cdp: null, erreur: cause.message };
  }
}

test("une PASSKEY crée le coffre et le rouvre ; sans authentificateur, le refus est TYPÉ", async ({
  page,
}, info) => {
  // Le délai de l'épreuve DÉRIVE de la borne du produit, il ne la devine pas.
  //
  // La première exécution en intégration continue a rendu ce test « flaky » sur Firefox : la borne
  // du module valait UNE MINUTE (`DELAI_MS`) et le délai de l'épreuve valait la même chose, si bien
  // que les deux se couraient après. La coquille nomme désormais sa propre borne
  // (`DELAI_PASSKEY_MS`), et l'épreuve attend celle-là plus une marge — les deux ne peuvent plus
  // se croiser par accident, quelle que soit la valeur choisie plus tard.
  const attendu = DELAI_PASSKEY_MS + 20000;
  test.setTimeout(attendu * 2);
  const authentificateur = await authentificateurVirtuel(page);
  await ouvrirLaCoquille(page, {}, HOTE_WEBAUTHN);

  await page.locator("#ouvrir-par-passkey").click();

  if (authentificateur === null || authentificateur.cdp === null) {
    // Chemin exercé JUSQU'À L'APPEL : `navigator.credentials.create` est bien invoqué, et c'est le
    // refus TYPÉ qui est vérifié. Rien n'est ignoré, rien n'est maquillé. DEUX refus sont admis, et
    // l'écart est une mesure, pas une tolérance : WebKit rend une créance dépourvue de résultat
    // `prf` — donc PRF_INDISPONIBLE —, tandis que Firefox rend `NotAllowedError` au bout du délai —
    // donc ANNULEE, puisque le navigateur ne distingue pas « personne n'a répondu » de « refusé ».
    await expect(page.locator("#deverrouillage-refus")).not.toBeEmpty({ timeout: attendu });
    const refus = await page.locator("#deverrouillage-refus").textContent();
    await attacher(info, "passkey-limite", {
      moteur: info.project.name,
      limite:
        "Aucun authentificateur virtuel n'est pilotable sur ce moteur : le protocole CDP WebAuthn est propre à Chromium. Le chemin est exercé jusqu'à l'appel, et le refus typé est vérifié, dans la borne que la coquille nomme.",
      borneMs: DELAI_PASSKEY_MS,
      refus,
    });
    expect(
      [DERIVATION_ERROR_CODES.prfIndisponible, DERIVATION_ERROR_CODES.annulee].some((code) =>
        refus.includes(code),
      ),
      `refus non typé : ${refus}`,
    ).toBe(true);
    return;
  }

  await expect
    .poll(async () => (await releve(page)).etat, { timeout: DELAI })
    .not.toBe(ETATS_DU_VOLUME.verrouille);
  const rapport = await releve(page);
  await attacher(info, "passkey", { moteur: info.project.name, etat: rapport.etat });
  if (await exigerLaLimiteDuMoteur(page, info, "passkey")) return;
  expect(rapport.etat).toBe(ETATS_DU_VOLUME.ouvert);
  expect((await releveDeLInterface(page)).moyensProposes).toContain("webauthn-prf");

  // SECONDE assertion, après rechargement : c'est elle qui prouve que la KEK se REFAIT sous les
  // paramètres publics écrits dans l'enveloppe, et non qu'on a gardé la première.
  await rouvrirLaCoquille(page);
  await expect(page.locator("#deverrouillage-moyens")).toContainText("passkey");
  await page.locator("#ouvrir-par-passkey").click();
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: DELAI })
    .toBe(ETATS_DU_VOLUME.ouvert);

  // Et ce qui a franchi le port est un HANDLE, jamais des octets : la sortie PRF ne quitte pas la
  // page, et `enveloppePrivilegiee` refuse une clé extractible.
  const envois = await page.evaluate(() => globalThis.__traficDesPorts.envois.join("\n"));
  expect(envois).toContain("[CryptoKey extractable=false]");
  expect(envois).not.toContain("extractable=true");
});

// --- Ce que la coquille refuse encore --------------------------------------------------------------

test("créer un moyen de récupération sur un coffre VERROUILLÉ est refusé, sous son code", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  // Même remarque que ci-dessus : un coffre FERMÉ, sous l'une ou l'autre de ses deux formes. Ce que
  // l'épreuve mesure ensuite ne dépend d'aucune des deux — le refus est le MÊME, et c'est le sujet.
  await exigerLEtatFerme(page);
  await page.locator("#creer-recuperation").click();
  await expect(page.locator("#deverrouillage-refus")).toContainText(
    CODES_REFUS_COQUILLE.volumeVerrouille,
    { timeout: DELAI },
  );
});

test("un code de récupération ne CRÉE pas un coffre : il en secourt un", async ({ page }) => {
  // Un coffre dont l'unique clé serait un papier n'est pas un coffre que quelqu'un aurait choisi.
  // Le refus est de fond, et il porte le code du geste refusé, pas celui d'une clé.
  await ouvrirLaCoquille(page);
  // Le code est CALCULÉ pour vérifier la somme, jamais écrit à la main : un littéral dont la somme
  // est fausse ferait mesurer le contrôle de saisie au lieu du refus qui nous intéresse, et le
  // `test.skip` qui couvrait ce cas maquillait la limite au lieu de l'écrire.
  const codeValide = encoderCode(new Uint8Array(CODE_OCTETS));
  await page.locator("#saisie-code").fill(codeValide);
  await expect(page.locator("#code-verdict")).toContainText("cohérent");
  await expect(page.locator("#ouvrir-par-code")).toBeEnabled();
  await page.locator("#ouvrir-par-code").click();
  await expect(page.locator("#deverrouillage-refus")).not.toBeEmpty({ timeout: DELAI });
});

// --- (e) La SONDE, REJOUÉE APRÈS UN VERROUILLAGE (#169, ADR 0031) ---------------------------------
//
// La sonde ci-dessus fouille une coquille OUVERTE. Celle-ci fouille la même origine APRÈS un
// verrouillage, c'est-à-dire après que le Worker qui détenait la KEK et la DEK a été terminé et que
// la coquille s'est rechargée. C'est la question que l'ADR 0030 § Limites laissait ouverte : « la
// sonde d'exfiltration de #162 n'est pas rejouée après la mort du Worker […] ; #25 la rejouera après
// un verrouillage, où la question se pose pour de bon ».
//
// ## L'AVEU, écrit avant les assertions
//
// **Cette sonde mesure ce qui n'est pas PERSISTÉ, pas ce qui est EFFACÉ d'un tas.** Elle fouille six
// stockages, l'OPFS entier en texte et en hexadécimal, le DOM et les deux sens des deux ports ; elle
// ne peut rien dire de la mémoire d'un processus, d'un fichier d'échange, ni des octets d'une
// `CryptoKey` — que, par construction, aucun code de cette origine ne peut lire (ADR 0021,
// décision 7 : GARANTI). Ce que cette tranche affirme est donc exactement ce que l'ADR 0031 écrit :
// **le Worker qui détenait les clés est mort**, aucun geste ne réussit plus sans une nouvelle
// dérivation, et rien du secret ne s'est déposé là où un adversaire qui copie le profil le lirait.
// « Les clés sont effacées » ne s'écrit pas, ici pas plus qu'ailleurs.
//
// ## Ce qui reste sur le support, et pourquoi ce n'est pas une fuite
//
// Le VOLUME reste, scellé sous sa DEK. L'INSTANTANÉ reste aussi (ADR 0031, décision 3, révision de
// l'ADR 0024 décision 8), scellé sous la même clé, en un seul AES-256-GCM par capture. Leurs NOMS
// sont sur le support, et l'en-tête d'un instantané n'est pas confidentiel (ADR 0024, limite 3) : ce
// que la fouille exige n'est donc pas leur absence, c'est l'absence de ce qui les OUVRE.

test("APRÈS un verrouillage, rien du secret ne s'est déposé — et la sonde dit ce qu'elle mesure", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page);
  await ouvrirParLaPhrase(page);
  if (await exigerLaLimiteDuMoteur(page, info, "sonde-apres-verrouillage")) return;

  // Un CODE de récupération est créé pendant que le coffre est ouvert : c'est le secret dont on
  // cherchera la trace après. Sans lui, la fouille ne chercherait que la phrase, et une phrase qui
  // n'a jamais quitté un champ de saisie serait un témoin faible.
  const feuille = await creerLaFeuille(page);
  const code = feuille.code;
  const octets = decoderCode(code);
  const octetsHex = Buffer.from(octets).toString("hex");
  const materiauHex = createHash("sha256").update(octets).digest("hex");
  const sansTirets = code.replaceAll("-", "");
  const humaine = code.toLowerCase().replaceAll("-", " ").replaceAll("0", "o").replaceAll("1", "l");

  // LE VERROUILLAGE, par le geste explicite — le seul déclencheur dont le produit maîtrise
  // entièrement le chemin, et le témoin positif de l'autre. La coquille se recharge d'elle-même.
  //
  // L'attente porte sur un TÉMOIN posé par l'épreuve dans le document d'avant, et non sur ce que la
  // page affiche : `#deverrouillage-moyens` est déjà rempli par la session en cours, et une épreuve
  // qui s'y fierait fouillerait la page PRÉCÉDENTE en croyant fouiller la nouvelle. Le témoin vit
  // sur `globalThis` ; le produit n'en sait rien, et il disparaît avec le document qui le portait.
  await page.evaluate(() => {
    globalThis.__documentDAvantLeVerrouillage = true;
  });
  await page.locator("#verrouiller-le-coffre").click();
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(() => globalThis.__documentDAvantLeVerrouillage === undefined);
        } catch {
          // Contexte détruit par la navigation : c'est le rechargement, pas un défaut.
          return false;
        }
      },
      { timeout: DELAI },
    )
    .toBe(true);
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
  const apres = await releve(page);
  expect(apres.etat, "le coffre n'est pas verrouillé : la sonde mesurerait un coffre ouvert").toBe(
    ETATS_DU_VOLUME.verrouille,
  );
  // Rien n'a été dérivé sans geste : le rechargement n'est pas une réouverture.
  expect(apres.mesures.deverrouillageMs).toBeNull();

  const morceaux = await sonder(page, APPAT, { noeudsARetirer: NOEUDS_DU_CODE });
  await attacher(
    info,
    "sonde-apres-verrouillage",
    morceaux.map(({ ou, texte }) => ({
      ou,
      caracteres: texte.length,
      porteLAppat: texte.includes(APPAT),
      porteLeCode: texte.includes(code),
      portelaPhrase: texte.includes(PHRASE),
    })),
  );

  // TÉMOIN DE FOUILLE, EN PREMIER. Sans lui, « rien trouvé » pourrait vouloir dire « rien capturé » :
  // la recherche doit d'abord montrer qu'elle sait trouver ce qui EST là — et elle doit le montrer
  // sur une coquille rechargée, où tout est neuf.
  const trouves = morceaux.filter(({ texte }) => texte.includes(APPAT)).map(({ ou }) => ou);
  expect(trouves, "la sonde n'a retrouvé son appât nulle part : elle ne mesure rien").toContain(
    "localStorage",
  );
  expect(trouves).toContain("sessionStorage");
  expect(trouves).toContain("cookies");
  expect(trouves).toContain("opfs");

  // SECOND TÉMOIN : l'OPFS n'est pas vide, et la fouille l'a bien lu. Une fouille sur un support
  // vide serait verte pour la mauvaise raison — et c'est aussi ce qui donne son sens à la ligne
  // suivante : ce qui reste sur le support est scellé, et le verrouillage ne le retire pas.
  const opfs = morceaux.find(({ ou }) => ou === "opfs").texte;
  expect(opfs.length, "l'OPFS lu est vide : la fouille ne porte sur rien").toBeGreaterThan(1_000);

  // ET LE VERDICT : ni la phrase, ni le code sous ses quatre formes, ni son matériau HKDF, nulle
  // part. Pas même dans les ports — la coquille rechargée n'a rien reçu de tout cela, et c'est le
  // point : le canal de rendu du code appartenait à la session précédente, et cette session est
  // morte avec son Worker.
  for (const { ou, texte } of morceaux) {
    expect(texte.includes(PHRASE), `la phrase se retrouve dans « ${ou} » après verrouillage`).toBe(
      false,
    );
    expect(texte.includes(code), `le code se retrouve dans « ${ou} » après verrouillage`).toBe(
      false,
    );
    expect(texte.includes(sansTirets), `le code sans tirets est dans « ${ou} »`).toBe(false);
    expect(texte.includes(humaine), `la forme humaine du code est dans « ${ou} »`).toBe(false);
    expect(texte.includes(octetsHex), `les seize octets du code sont dans « ${ou} »`).toBe(false);
    expect(texte.includes(materiauHex), `le matériau HKDF du code est dans « ${ou} »`).toBe(false);
  }

  // Et le relevé de l'interface, comme avant : il ne porte pas le code, et il n'en porte plus la
  // trace après un rechargement.
  expect(JSON.stringify(await releveDeLInterface(page))).not.toContain(code);
});

/**
 * SERT le module de verrouillage avec un délai d'inactivité COURT, pris entre les bornes du produit.
 *
 * Le même geste que dans `coquille-cycle-de-vie.spec.mjs`, et pour le même motif : il n'y a aucune
 * interface de réglage du délai (YAGNI écrit, ADR 0031 décision 2), donc aucun bouton par lequel une
 * épreuve pourrait l'abaisser. L'interception est du côté du RÉSEAU, là où le produit n'a rien à
 * dire, et ce qui est servi est le fichier RÉEL avec une seule constante remplacée par une valeur
 * que `delaiDInactivite` accepte.
 */
async function servirUnDelaiCourt(page, delaiMs) {
  const source = await readFile(
    new URL("../../src/coquille/verrouillage.mjs", import.meta.url),
    "utf8",
  );
  const abaisse = source.replace(
    "export const DELAI_INACTIVITE_MS = 600_000;",
    `export const DELAI_INACTIVITE_MS = ${delaiMs};`,
  );
  expect(abaisse, "la constante du délai n'a pas été trouvée").not.toBe(source);
  await page
    .context()
    .route("**/src/coquille/verrouillage.mjs", (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: abaisse }),
    );
}

test("APRÈS un verrouillage par le DÉLAI, rien du secret ne s'est déposé non plus", async ({
  page,
  browserName,
}, info) => {
  // Le geste explicite est le TÉMOIN POSITIF du délai, et la sonde ci-dessus le suit. Restait à
  // fouiller après l'AUTRE déclencheur : c'est le « non prouvé » que la revue de sécurité de la
  // PR #174 a relevé, et le voici comblé. Un moteur suffit — ce qui est mesuré est ce qui se
  // DÉPOSE, et cela ne dépend pas du moteur ; ce qui en dépend, la livraison des événements et
  // l'étirement des minuteries, est mesuré sur deux moteurs par `coquille-cycle-de-vie.spec.mjs`.
  test.skip(browserName !== "chromium", "une minute réelle : un moteur suffit pour un dépôt");
  test.setTimeout(300_000);
  await servirUnDelaiCourt(page, 60_000);
  await ouvrirLaCoquille(page);
  await ouvrirParLaPhrase(page);
  if (await exigerLaLimiteDuMoteur(page, info, "sonde-apres-delai")) return;

  const feuille = await creerLaFeuille(page);
  const code = feuille.code;
  const octets = decoderCode(code);
  const octetsHex = Buffer.from(octets).toString("hex");
  const materiauHex = createHash("sha256").update(octets).digest("hex");
  const sansTirets = code.replaceAll("-", "");
  const humaine = code.toLowerCase().replaceAll("-", " ").replaceAll("0", "o").replaceAll("1", "l");

  // RIEN n'est fait pendant la minute : ni clic, ni frappe, ni focus. La coquille se verrouille
  // toute seule, puis se recharge.
  const debut = Date.now();
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: 240_000 })
    .toBe(ETATS_DU_VOLUME.verrouille);
  await expect(page.locator("#deverrouillage-moyens")).not.toBeEmpty({ timeout: DELAI });
  const apres = await releve(page);
  expect(apres.mesures.deverrouillageMs, "rien n'a été dérivé sans geste").toBeNull();

  const morceaux = await sonder(page, APPAT, { noeudsARetirer: NOEUDS_DU_CODE });
  await attacher(
    info,
    "sonde-apres-delai",
    morceaux.map(({ ou, texte }) => ({
      ou,
      caracteres: texte.length,
      porteLAppat: texte.includes(APPAT),
      porteLeCode: texte.includes(code),
    })),
  );

  // TÉMOIN DE FOUILLE, EN PREMIER : la recherche doit d'abord montrer qu'elle sait trouver ce qui
  // EST là, sur une coquille rechargée où tout est neuf.
  const trouves = morceaux.filter(({ texte }) => texte.includes(APPAT)).map(({ ou }) => ou);
  expect(trouves, "la sonde n'a retrouvé son appât nulle part : elle ne mesure rien").toContain(
    "localStorage",
  );
  expect(trouves).toContain("opfs");
  const opfs = morceaux.find(({ ou }) => ou === "opfs").texte;
  expect(opfs.length, "l'OPFS lu est vide : la fouille ne porte sur rien").toBeGreaterThan(1_000);

  for (const { ou, texte } of morceaux) {
    expect(texte.includes(PHRASE), `la phrase se retrouve dans « ${ou} » après le délai`).toBe(
      false,
    );
    expect(texte.includes(code), `le code se retrouve dans « ${ou} » après le délai`).toBe(false);
    expect(texte.includes(sansTirets), `le code sans tirets est dans « ${ou} »`).toBe(false);
    expect(texte.includes(humaine), `la forme humaine du code est dans « ${ou} »`).toBe(false);
    expect(texte.includes(octetsHex), `les seize octets du code sont dans « ${ou} »`).toBe(false);
    expect(texte.includes(materiauHex), `le matériau HKDF du code est dans « ${ou} »`).toBe(false);
  }
  expect(Date.now() - debut, "le verrouillage est arrivé avant son échéance").toBeGreaterThan(
    30_000,
  );
});
