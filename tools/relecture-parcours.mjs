#!/usr/bin/env node
// La PAGE DE RELECTURE du parcours guidé, GÉNÉRÉE depuis les textes servis (#193, ADR 0040).
//
//     node tools/relecture-parcours.mjs              # réécrit docs/parcours/relecture-p2.md
//     node tools/relecture-parcours.mjs --verifier   # code 1 si la page n'est plus à jour
//
// La revue de la PR #213 (constat 7) a trouvé seize textes affichés à la personne et absents de la
// page de relecture, écrite à la main : la relectrice non technique n'aurait vu ni la moitié des
// consignes de l'étape 3, ni les messages qui disent quoi noter. La page est désormais PRODUITE depuis
// les constantes que la coquille sert — `src/coquille/textes-du-parcours.mjs` et
// `src/coquille/conduites-du-parcours.mjs` — et `tests/unit/coquille-parcours-relecture.test.mjs`
// exige que la régénération ne change rien. Seuls l'introduction et les trois questions par étape sont
// écrites ici.
//
// Les libellés que la mise en forme ajoute (revue de la PR #216, constat 6) viennent de deux sources :
// le repli de l'aide, créé par le branchement, est lu dans `LIBELLES_DE_LA_PAGE` ; le lien d'évitement
// et le repli du relais, écrits dans leurs documents sans script, sont RELUS dans `public/index.html` et
// `public/document-applicatif.html`. Changer l'un d'eux sans régénérer fait échouer l'épreuve.

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import prettier from "prettier";

import { annonceDAttente } from "../src/coquille/attente-annoncee.mjs";
import {
  CLASSEMENT_DES_CONDUITES,
  CLASSES_DE_CONDUITE,
  CONDUITES_DU_PARCOURS,
  CONDUITE_GENERIQUE,
  REFUS_SANS_CODE,
} from "../src/coquille/conduites-du-parcours.mjs";
import {
  ECRANS,
  ETAPES,
  LIBELLES_DE_LA_PAGE,
  LIBELLES_DES_BLOCS,
  LIMITE_DE_FIREFOX,
  MESSAGES,
  STATUTS,
  texteDAttenteDeLaPhrase,
} from "../src/coquille/textes-du-parcours.mjs";

export const CHEMIN_DE_LA_RELECTURE = fileURLToPath(
  new URL("../docs/parcours/relecture-p2.md", import.meta.url),
);

/** Les messages de la page, rattachés à l'écran où la personne les lit. Une valeur vaut « N ». */
export const MESSAGES_PAR_ECRAN = Object.freeze({
  creer: ["limiteDeFirefox"],
  choisir: ["limiteDeFirefox", "passkeyALaCreation", "ouvertureEnCours", "coffreOuvert"],
  "code-feuille": ["consigneDeLaFeuille"],
  "code-confirmation": ["recopieIncomplete", "recopieDUnAutreCode", "codeConfirme"],
  "code-verifier": ["saisieIncomplete", "saisieComplete", "ouvertureEnCours", "coffreOuvert"],
  "code-a-verifier": ["verrouillageEnCours"],
  travailler: [
    "demarrageEnCours",
    "signesDeVie",
    "premierSigneDeVie",
    "applicationDemarree",
    "repriseEnCours",
  ],
  verrouiller: ["verrouillageEnCours"],
  rouvrir: ["passkeyALOuverture", "ouvertureEnCours", "coffreOuvert"],
  sauvegarder: ["sauvegardeEnCours", "sauvegardePrete"],
  restaurer: ["restaurationEnCours", "restauree"],
  "recuperer-preparer": ["verrouillageEnCours"],
  recuperer: ["saisieIncomplete", "saisieComplete", "ouvertureEnCours", "coffreOuvert"],
  revoquer: ["revoque", "revoqueSansRien"],
});

/** Les messages de STRUCTURE, communs à tous les écrans, dits une fois dans l'introduction. */
export const MESSAGES_DE_STRUCTURE = Object.freeze([
  "rang",
  "attendu",
  "duree",
  "suivante",
  "continuer",
  "codeMasque",
]);

/** Les trois questions de chaque étape, par rang. */
export const QUESTIONS = Object.freeze({
  1: [
    "Après avoir lu cet écran, pouvez-vous dire avec vos mots ce qu'est « un coffre » ?",
    "Savez-vous sur quel bouton cliquer si vous avez déjà une sauvegarde ?",
    "Un mot vous a-t-il arrêté ou inquiété ? Lequel ?",
  ],
  2: [
    "Comprenez-vous que le coffre est créé dès le clic, et qu'il faudra retenir la phrase ?",
    "L'annonce de durée (« l'onglet peut sembler figé ») vous aurait-elle évité de fermer la page ?",
    "La phrase sur les passkeys est-elle claire, ou vaudrait-il mieux ne pas en parler ?",
  ],
  3: [
    "Avant de cliquer, avez-vous compris que le code ne s'affichera qu'une fois ?",
    "Savez-vous ce qu'il faut recopier (le code ET le numéro de version) et où ranger la feuille ?",
    "Si la page se recharge avant la confirmation, l'écran « Vérifier votre code » vous dit-il quoi faire, y compris si vous avez perdu le code ?",
  ],
  4: [
    "L'attente de deux minutes est-elle annoncée assez clairement pour que vous patientiez ?",
    "La progression affichée pendant le démarrage vous rassure-t-elle ?",
    "Comprenez-vous que ce que vous écrivez reste sur cet appareil ?",
  ],
  5: [
    "Savez-vous ce que « verrouiller » change, et que la page va se recharger ?",
    "Le champ « numéro de version » vous paraît-il utile, ou déroutant ?",
    "Si la phrase est refusée, le message vous rassure-t-il (rien de perdu, essais illimités) ?",
  ],
  6: [
    "Comprenez-vous que la sauvegarde est un fichier téléchargé, à copier ailleurs ?",
    "Savez-vous que l'application est arrêtée pendant la sauvegarde ?",
    "Que feriez-vous si le téléchargement ne démarrait pas ?",
  ],
  7: [
    "Comprenez-vous qu'on ne restaure pas là où il y a déjà un coffre ?",
    "Si le fichier est abîmé, le message vous dit-il quoi faire ?",
    "Savez-vous avec quoi le coffre restauré s'ouvrira ensuite ?",
  ],
  8: [
    "Comprenez-vous que le code sert quand la phrase est oubliée ?",
    "Savez-vous où trouver le numéro de version à taper ?",
    "Si vous faites une faute de recopie, le message vous aide-t-il à la trouver ?",
  ],
  9: [
    "Savez-vous QUAND il faut révoquer (et quand il ne le faut pas) ?",
    "Comprenez-vous que les sauvegardes déjà faites restent ouvrables par les anciens moyens ?",
    "Savez-vous quoi faire après la révocation (noter la version, refaire une sauvegarde) ?",
  ],
});

const INTRODUCTION = `# Relecture du parcours guidé (P2, #193)

<!-- Page GÉNÉRÉE par tools/relecture-parcours.mjs depuis les textes servis : ne pas la modifier à la main. -->

Cette page est destinée à **une personne non technique**, désignée par le mainteneur, pour une
relecture d'environ trois quarts d'heure. Elle reproduit, **mot pour mot**, ce que RailsBox Vault
affiche à chaque étape — elle est produite à partir des mêmes textes que la page elle-même —, puis
pose trois questions par étape. Il n'y a pas de bonne réponse : ce qui compte est ce que vous
comprenez en lisant, et ce qui vous arrête.

**Comment répondre** : sous chaque question, écrivez librement (quelques mots suffisent). Signalez
aussi tout mot inconnu, toute phrase trop longue, et tout moment où vous ne sauriez pas quoi faire.
Vos retours seront consignés dans la PR, sans votre nom.`;

/** Les documents servis d'où les libellés sans script sont relus. */
const DOCUMENT_DE_LA_COQUILLE = new URL("../public/index.html", import.meta.url);
const DOCUMENT_DU_RELAIS = new URL("../public/document-applicatif.html", import.meta.url);

/** Le texte que capture `motif` dans `html`, ou une erreur qui nomme ce qui n'a pas été trouvé. */
function libelleDuDocument(html, motif, nom) {
  const trouve = motif.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
  if (!trouve) throw new Error(`Libellé introuvable dans le document servi : ${nom}.`);
  return trouve;
}

/** Les libellés de la mise en forme, lus là où la page les prend. */
export async function libellesDeLaMiseEnForme() {
  const coquille = await readFile(DOCUMENT_DE_LA_COQUILLE, "utf8");
  const relais = await readFile(DOCUMENT_DU_RELAIS, "utf8");
  return {
    evitement: libelleDuDocument(
      coquille,
      /<a class="evitement"[^>]*>([^<]+)<\/a>/u,
      "lien d'évitement",
    ),
    aide: LIBELLES_DE_LA_PAGE.aideDeLEtape,
    relais: libelleDuDocument(
      relais,
      /<details id="details-du-courtier">\s*<summary>([^<]+)<\/summary>/u,
      "repli du relais applicatif",
    ),
  };
}

/** La valeur montrée à la place d'un nombre. */
const N = "N";

function texteDuMessage(nom) {
  if (nom === "limiteDeFirefox") return `${LIMITE_DE_FIREFOX} (seulement dans Firefox)`;
  const message = MESSAGES[nom];
  if (typeof message !== "function") return message;
  if (nom === "demarrageEnCours") return message(N, MESSAGES.signesDeVie(N));
  if (nom === "revoque") return message(N, "V");
  if (nom === "recopieIncomplete" || nom === "saisieIncomplete") return message(N, 28);
  return message(N);
}

function citation(lignes) {
  return lignes.map((ligne) => `> ${ligne}`).join("\n>\n");
}

function attenteDeLaPhraseRelue() {
  const duree = (moteur) => {
    const { attenteMs } = annonceDAttente({ moyen: "phrase", moteur });
    return attenteMs >= 1000
      ? `environ ${Math.round(attenteMs / 1000)} seconde(s)`
      : "moins d'une seconde";
  };
  return texteDAttenteDeLaPhrase(`${duree("chromium")} (dans Firefox : « ${duree("firefox")} »)`);
}

function sectionDEcran(id, libelles) {
  const ecran = ECRANS[id];
  const lignes = [ecran.ceQuiVaSePasser, MESSAGES.attendu(ecran.attendu)];
  const attente =
    ecran.attente ?? (ecran.blocs.includes("phrase") ? attenteDeLaPhraseRelue() : null);
  if (attente !== null) lignes.push(MESSAGES.duree(attente));
  const morceaux = [`### Écran : ${ecran.titre}`, "", citation(lignes)];
  const libellesDesBlocs = ecran.blocs.flatMap((bloc) => LIBELLES_DES_BLOCS[bloc]);
  if (libellesDesBlocs.length > 0)
    morceaux.push("", `Boutons et champs : ${libellesDesBlocs.join(", ")}.`);
  if (id === "travailler") {
    morceaux.push(
      "",
      `Quand l'application est démarrée, les explications ci-dessus se replient sous « ${libelles.aide} » ` +
        "(un clic ou la touche Entrée les rouvre), le bouton « Démarrer l'application » disparaît, et " +
        "l'application remonte près du haut de la page. Au-dessus d'elle, un repli " +
        `« ${libelles.relais} » contient des informations techniques, qu'il n'est pas utile d'ouvrir.`,
    );
  }
  const messages = MESSAGES_PAR_ECRAN[id] ?? [];
  if (messages.length > 0) {
    morceaux.push("", "Messages qui peuvent s'afficher sur cet écran :", "");
    morceaux.push(...messages.map((nom) => `- ${texteDuMessage(nom)}`));
  }
  return morceaux.join("\n");
}

function sectionDEtape({ rang, titre }, libelles) {
  const ecrans = Object.keys(ECRANS).filter((id) => ECRANS[id].etape === rang);
  const questions = QUESTIONS[rang].map(
    (question, index) => `${index + 1}. ${question}\n\n   _Votre réponse :_`,
  );
  return [
    `## ${MESSAGES.rang(rang)} — ${titre}`,
    ...ecrans.map((id) => sectionDEcran(id, libelles)),
    "**Questions**",
    ...questions,
  ].join("\n\n");
}

function sectionDeStructure(libelles) {
  return [
    "## Ce que chaque écran affiche",
    [
      `Dans cet ordre : « ${MESSAGES.rang(N)} », le titre, ce qui va se passer, « ${MESSAGES.attendu("…")} »,`,
      `« ${MESSAGES.duree("…")} » quand le geste dure, les boutons, « ${MESSAGES.suivante("titre de l'étape")} », puis`,
      `un repli « Où suis-je ? » qui liste les neuf étapes. Le bouton qui fait passer à l'étape suivante`,
      `s'appelle « ${MESSAGES.continuer("…")} ». Si un code de récupération devait apparaître ailleurs`,
      `que sur sa feuille, il serait remplacé par « ${MESSAGES.codeMasque} ».`,
    ].join(" "),
    `Au clavier, le premier appui sur la touche Tab fait apparaître en haut de la page un lien « ${libelles.evitement} », qui mène directement au titre de l'étape.`,
    "Dans « Où suis-je ? », chaque étape porte l'une de ces mentions :",
    Object.values(STATUTS)
      .map((statut) => `- ${statut}`)
      .join("\n"),
    sectionDEcran("chargement", libelles),
  ].join("\n\n");
}

function sectionDesConduites() {
  const parClasse = Object.values(CLASSES_DE_CONDUITE).map((classe) => {
    const conduites = [
      ...new Set([
        ...Object.entries(CONDUITES_DU_PARCOURS)
          .filter(([code]) => CLASSEMENT_DES_CONDUITES[code] === classe)
          .map(([, conduite]) => conduite),
        ...Object.values(REFUS_SANS_CODE)
          .filter((refus) => refus.classe === classe)
          .map((refus) => refus.conduite),
      ]),
    ];
    if (conduites.length === 0) return null;
    return [`### Ce qu'il faut faire : ${classe}`, conduites.map((c) => `- ${c}`).join("\n")].join(
      "\n\n",
    );
  });
  return [
    "## Messages quand quelque chose ne va pas",
    "Voici les messages qu'une personne peut lire quand une opération est refusée, regroupés par ce " +
      "qu'ils demandent de faire. Signalez ceux que vous ne comprenez pas, ou qui ne vous disent pas " +
      "quoi faire.",
    ...parClasse.filter((section) => section !== null),
    "### Quand la cause n'est pas connue",
    `- ${CONDUITE_GENERIQUE}`,
  ].join("\n\n");
}

/** Le texte de la page, formaté comme le dépôt formate son Markdown. */
export async function genererLaRelecture() {
  const libelles = await libellesDeLaMiseEnForme();
  const brut = [
    INTRODUCTION,
    sectionDeStructure(libelles),
    ...ETAPES.map((etape) => sectionDEtape(etape, libelles)),
    sectionDesConduites(),
  ].join("\n\n");
  const options = (await prettier.resolveConfig(CHEMIN_DE_LA_RELECTURE)) ?? {};
  return prettier.format(`${brut}\n`, { ...options, parser: "markdown" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const attendue = await genererLaRelecture();
  if (process.argv.includes("--verifier")) {
    const actuelle = await readFile(CHEMIN_DE_LA_RELECTURE, "utf8");
    if (actuelle !== attendue) {
      process.stderr.write(
        `${CHEMIN_DE_LA_RELECTURE} n'est plus à jour : « node tools/relecture-parcours.mjs ».\n`,
      );
      process.exitCode = 1;
    }
  } else {
    await writeFile(CHEMIN_DE_LA_RELECTURE, attendue);
    process.stdout.write(`${CHEMIN_DE_LA_RELECTURE} régénérée.\n`);
  }
}
