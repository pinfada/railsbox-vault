// L'INTERFACE de déverrouillage de la coquille de produit (#162, ADR 0029).
//
// C'est la moitié PAGE du geste : ce que l'utilisateur voit, ce qu'il tape, et ce qui part vers le
// Worker de confiance. Elle vit dans `src/coquille/` — donc publiée, donc partagée — plutôt que
// dans `public/main.mjs`, pour la raison qui gouverne déjà tout ce répertoire : ce qui est ici peut
// être MUTÉ et éprouvé sans démarrer un navigateur, et ce qui est dans la page ne le peut pas. Le
// DOM est le seul morceau que cette interface ne partage pas, et il est confiné aux fonctions qui
// le touchent nommément.
//
// ## Ce qu'elle ne fait JAMAIS
//
//  - **elle n'écrit le code nulle part.** Pas de presse-papiers, pas de stockage, pas de journal,
//    pas de champ caché. La feuille de récupération est affichée, et c'est tout : `SECURITY.md` dit
//    que l'impression sort par un chemin que le produit ne maîtrise pas, et la coquille ne le
//    promet pas ;
//  - **elle ne conserve pas la phrase après l'envoi.** Le champ est vidé, la variable relâchée. Ce
//    n'est PAS un effacement — « IMPOSSIBLE — effacer la phrase. C'est une `string` JavaScript :
//    immuable, copiée par le moteur, ramassée quand il le décide » (ADR 0021, décision 7). C'est
//    ce que le langage permet, ni plus, ni moins, et le dire ainsi est la moitié du travail ;
//  - **elle ne lit aucune version d'un stockage.** L'ancre est une SAISIE (ADR 0027, décision 3).
//    Une version rangée à côté du fichier qu'elle protège est ramenée en arrière par le même geste
//    que lui, et ne protège donc de rien ;
//  - **elle ne devine aucun moyen.** L'inventaire dit ce que le coffre porte ; un type qu'elle ne
//    sert pas est ANNONCÉ, jamais tenté.
//
// ## L'ORDRE, pour la passkey
//
// `navigator.credentials` n'existe pas dans un Worker (ADR 0021, décision 5) : la dérivation PRF a
// lieu ICI, et ce qui franchit le port est la `CryptoKey` NON EXTRACTIBLE. La sortie PRF brute ne
// quitte jamais cette page, et `enveloppePrivilegiee` refuse une clé extractible.

import { TEXTE_EN_COURS, annonceDAttente, moteurProbable } from "./attente-annoncee.mjs";
import {
  AVERTISSEMENT_SANS_RECUPERATION,
  AVEU_SANS_ANCRE,
  REPLI_DU_REJEU,
  ancreOpposee,
  feuilleDeRecuperation,
  versionANoter,
} from "./feuille-de-recuperation.mjs";
import { moyensProposes } from "./moyens-de-deverrouillage.mjs";
import { etatDeLaSaisie } from "./saisie-du-code.mjs";
import { DERIVATION_ERROR_CODES } from "../vm/derivation/derivation-errors.mjs";
import { ENVELOPPE_ERROR_CODES } from "../vm/enveloppe/enveloppe-errors.mjs";
import { STORAGE_ERROR_CODES } from "../vm/storage-errors.mjs";

/**
 * Ce que la coquille dit d'un refus, par code. La table est CLOSE et courte : elle ne couvre que
 * les refus qu'un geste d'utilisateur peut provoquer, et tout autre code est rendu tel quel.
 *
 * Rendre un code inconnu tel quel plutôt que « une erreur est survenue » est une décision : un code
 * est cherchable, une phrase générique ne l'est pas, et l'utilisateur qui écrit à quelqu'un pour
 * demander de l'aide a alors quelque chose à citer.
 */
export const CONDUITES = Object.freeze({
  // Le CONTEXTE d'un refus ne franchit pas le port : `{ voisin, champ, taille }` reste dans la
  // coquille, et ce que l'utilisateur lit est la phrase écrite ici. Les trois refus de #181 y sont
  // entrés avec la revue de sécurité de la PR #184 (constat 7) : ce sont les plus probables d'un
  // coffre restauré, et ils tombaient jusque-là sur le message destiné à l'exploitant — celui qui
  // cite un numéro d'issue et le nom d'un fichier voisin.
  [ENVELOPPE_ERROR_CODES.cleRefusee]:
    "Ce moyen n'ouvre pas ce coffre. Le geste était bien formé — c'est l'enveloppe qui a tranché : " +
    "phrase inexacte, passkey d'un autre appareil, ou code d'un autre coffre. Rien n'a été modifié.",
  [ENVELOPPE_ERROR_CODES.rejeu]: REPLI_DU_REJEU,
  [ENVELOPPE_ERROR_CODES.absente]:
    "Ce coffre n'a pas d'enveloppe de clés : il n'a jamais été ouvert sur cet appareil, ou son " +
    "fichier de clés a disparu. Un code de récupération ne peut rien pour un coffre qui n'existe pas.",
  [DERIVATION_ERROR_CODES.codeMalRecopie]:
    "Le code a été mal recopié : sa somme de contrôle ne vérifie pas. Relisez la feuille. Ce n'est " +
    "pas le refus d'un code étranger.",
  [DERIVATION_ERROR_CODES.codeDejaRendu]:
    "Ce code a déjà été rendu une fois, et il ne l'est jamais deux. S'il n'a pas été noté, créez un " +
    "NOUVEAU moyen de récupération : l'ancien restera valable tant qu'il n'est pas révoqué.",
  [DERIVATION_ERROR_CODES.prfIndisponible]:
    "Cette passkey n'offre pas l'extension « prf » : elle ne peut pas dériver de clé. Un autre " +
    "authentificateur, ou un autre moyen.",
  [DERIVATION_ERROR_CODES.prfIgnoree]:
    "L'authentificateur a répondu, mais sans la sortie « prf » demandée. C'est distinct de " +
    "l'indisponibilité : la passkey existe, l'extension n'a pas été servie.",
  [DERIVATION_ERROR_CODES.annulee]:
    "Le geste a été annulé, ou personne n'a répondu à l'authentificateur. Rien n'est compté : " +
    "recommencer coûte exactement la même chose.",
  [DERIVATION_ERROR_CODES.typeInconnu]:
    "Cette coquille ne sait pas servir ce moyen de déverrouillage.",
  [STORAGE_ERROR_CODES.unsupported]:
    "Ce navigateur ne sait pas ouvrir un coffre : il n'offre pas l'accès synchrone au stockage privé " +
    "depuis un Worker. Rien n'a échoué — rien n'a pu être tenté. Essayez un autre navigateur ; la " +
    "matrice de compatibilité du dépôt dit lesquels le savent.",
  [STORAGE_ERROR_CODES.volumeSansRacine]:
    "Ce coffre a été restauré, mais ce qui prouvait que son contenu vient bien de son archive n'est " +
    "plus là. Rien n'est perdu du côté de l'archive : restaurez-la à nouveau, puis ouvrez le coffre " +
    "sans autre geste entre les deux. Aucun octet n'a été lu.",
  [STORAGE_ERROR_CODES.engagementInvalide]:
    "Ce qui accompagne ce coffre ne correspond pas à son contenu : l'archive ou le coffre restauré a " +
    "été altéré. Ne réessayez pas avec les mêmes fichiers — restaurez depuis une archive à laquelle " +
    "vous faites confiance. Aucun octet n'a été lu.",
  [STORAGE_ERROR_CODES.creationNonConfirmee]:
    "L'installation de ce coffre n'a pas pu être confirmée : ce qui a été écrit sur cet appareil " +
    "n'est pas ce qui s'y trouve. Rien n'est déclaré installé ; recommencez l'installation.",
  [DERIVATION_ERROR_CODES.argon2Indisponible]:
    "Le calcul de la clé n'est pas disponible sur ce navigateur : l'artefact Argon2 n'a pas été " +
    "servi, ou WebAssembly est refusé par la politique de sécurité.",
});

/** Ce que l'utilisateur lit d'un refus : sa conduite s'il y en a une, son code sinon. */
export function conduiteDeRefus(code, message) {
  const conduite = CONDUITES[code];
  if (conduite !== undefined) return `${conduite} (${code})`;
  return `${message ?? "Le geste a été refusé."} (${code})`;
}

/**
 * L'ancre TELLE QU'ELLE EST SAISIE, et ce que la coquille en dit.
 *
 * Trois cas, trois phrases, et le troisième est celui qui compte : un champ vide n'est pas une
 * erreur, c'est un choix — et c'est le choix dont l'ADR 0027 exige qu'il soit AVOUÉ.
 *
 * @param {string} texte
 * @returns {{ version: number | null, valide: boolean, aveu: string }}
 */
export function ancreSaisie(texte) {
  const brut = String(texte ?? "").trim();
  if (brut === "") return { version: null, valide: true, aveu: AVEU_SANS_ANCRE };
  if (!/^\d{1,15}$/.test(brut) || Number(brut) < 1) {
    return {
      version: null,
      valide: false,
      aveu:
        "La version notée sur la feuille est un nombre entier, à partir de 1. Laissez le champ " +
        "vide si vous n'en avez pas noté — la coquille dira alors ce qu'elle ne protège plus.",
    };
  }
  return { version: Number(brut), valide: true, aveu: ancreOpposee(Number(brut)) };
}

/**
 * MONTE l'interface dans un document, et rend les poignées dont la page a besoin.
 *
 * `demander` est la seule chose que cette interface sait faire du Worker : poser une question sur
 * le canal privilégié et attendre SA réponse. Elle ne connaît ni le port, ni le contrat, ni la
 * corrélation — `public/main.mjs` les tient, et c'est ce qui garde la frontière dans un seul
 * fichier.
 *
 * `surMesure` reçoit les trois instants du geste — `geste`, `annonce`, `ouverture` —, et c'est la
 * page qui en fait des durées. C'est la MESURE que l'ADR 0029 publie : ce qui compte n'est pas la
 * durée de la dérivation, connue depuis l'ADR 0021, mais l'écart entre le geste et l'ANNONCE. Une
 * annonce peinte après la dérivation ne serait pas une annonce.
 *
 * @param {{ document: Document, racine: Element, demander: Function, deriverPhrase: Function,
 *           deriverPasskey: Function, agent?: string, surEtat?: Function,
 *           surMesure?: Function }} appel
 */
export function monterLInterface({
  document: doc,
  racine,
  demander,
  deriverPhrase,
  deriverPasskey,
  agent = "",
  surEtat = () => {},
  surMesure = () => {},
}) {
  const contexte = {
    noeuds: poignees(doc, racine),
    moteur: moteurProbable(agent),
    demander,
    deriverPhrase,
    deriverPasskey,
    surEtat,
    surMesure,
    inventaire: { present: false, versionEnveloppe: null, emplacements: [] },
    propose: moyensProposes({ emplacements: [], versionEnveloppe: null }),
    /** Le RELEVÉ de l'interface : ce qu'elle a MONTRÉ, jamais ce qu'elle a lu. */
    releve: {
      moteur: moteurProbable(agent),
      moyensProposes: [],
      typesInconnus: [],
      attenteAnnoncee: null,
      codeRendu: false,
      versionExigee: null,
      dernierRefus: null,
    },
  };

  brancherLesGestes(contexte);
  relireLAncre(contexte);
  relireLaSaisieDuCode(contexte);
  publier(contexte);
  return Object.freeze({
    rafraichirLInventaire: () => rafraichirLInventaire(contexte),
    releve: contexte.releve,
  });
}

/** Écrit un texte dans un nœud. La seule façon dont ce module touche le document. */
function dire(noeud, texte) {
  noeud.textContent = texte;
}

/** Publie le relevé de l'interface. Il ne porte que des booléens, des nombres et des noms. */
function publier({ noeuds, releve }) {
  noeuds.releve.textContent = JSON.stringify(releve, null, 2);
}

/** Inscrit les gestes de l'utilisateur. Chacun délègue à une fonction NOMMÉE, jamais à un corps. */
function brancherLesGestes(contexte) {
  const { noeuds } = contexte;
  noeuds.ancre.addEventListener("input", () => relireLAncre(contexte));
  noeuds.code.addEventListener("input", () => relireLaSaisieDuCode(contexte));
  noeuds.ouvrirParPhrase.addEventListener("click", () => ouvrirParLaPhrase(contexte));
  noeuds.ouvrirParCode.addEventListener("click", () => ouvrirParLeCode(contexte));
  noeuds.ouvrirParPasskey.addEventListener("click", () => ouvrirParLaPasskey(contexte));
  noeuds.creerRecuperation.addEventListener("click", () => creerLaFeuille(contexte));
}

/**
 * Redemande l'INVENTAIRE au Worker, et redit ce que le coffre porte.
 *
 * Appelé au montage et après chaque geste qui change l'enveloppe : ce que la coquille propose suit
 * ce que le fichier contient, et non ce qu'elle a affiché la fois d'avant.
 */
async function rafraichirLInventaire(contexte) {
  const { noeuds, releve } = contexte;
  contexte.inventaire = await contexte.demander("inventaire", {});
  contexte.propose = moyensProposes(contexte.inventaire);
  const propose = contexte.propose;
  releve.moyensProposes = propose.moyens.map((moyen) => moyen.nom);
  releve.typesInconnus = propose.inconnus.map((inconnu) => inconnu.typeKek);
  dire(
    noeuds.moyens,
    contexte.inventaire.present
      ? `Ce coffre s'ouvre par : ${propose.moyens.map((moyen) => moyen.libelle).join(", ")} (version d'enveloppe ${propose.versionEnveloppe}).`
      : "Aucun coffre sur cet appareil. Le premier déverrouillage en CRÉE un, sous le moyen que vous présentez.",
  );
  dire(noeuds.avertissement, propose.avertissement ?? "");
  // L'avertissement de `recovery: null`, montré là où la coquille le peut : dès qu'un coffre ouvert
  // n'a AUCUN moyen de récupération (ADR 0027, limite 6 ; ADR 0029, décision 4).
  dire(
    noeuds.sansRecuperation,
    contexte.inventaire.present && !propose.aUnMoyenDeRecuperation
      ? AVERTISSEMENT_SANS_RECUPERATION
      : "",
  );
  publier(contexte);
}

/** Relit l'ancre de version à chaque frappe, et affiche ce qu'elle promet — ou son AVEU. */
function relireLAncre(contexte) {
  const lue = ancreSaisie(contexte.noeuds.ancre.value);
  contexte.releve.versionExigee = lue.version;
  dire(contexte.noeuds.aveu, lue.aveu);
  publier(contexte);
  return lue;
}

/** Relit la saisie du code à chaque frappe : découpe, verdict, et l'état du bouton. */
function relireLaSaisieDuCode(contexte) {
  const etat = etatDeLaSaisie(contexte.noeuds.code.value);
  dire(contexte.noeuds.codeDecoupe, etat.decoupe);
  dire(contexte.noeuds.codeVerdict, etat.message);
  // Le bouton est fermé tant que la somme ne vérifie pas : le Worker ne voit JAMAIS un code mal
  // recopié, et l'utilisateur n'attend pas une dérivation pour apprendre qu'il a mal lu un « 5 ».
  contexte.noeuds.ouvrirParCode.disabled = !etat.envoyable;
  return etat;
}

/**
 * Le geste commun aux trois moyens : annoncer, dériver, ouvrir, dire.
 *
 * L'annonce est faite AVANT l'appel, et le fil est rendu au moteur avant que la dérivation ne le
 * prenne : sans cela, elle serait peinte APRÈS le calcul, c'est-à-dire au moment exact où elle ne
 * sert plus à rien. C'est la seule ligne de ce module dont l'ORDRE soit le sujet, et les deux
 * mesures que la page publie la bornent.
 */
async function ouvrirPar(contexte, moyen, corps, avantEnvoi = null) {
  const { noeuds, releve, surMesure } = contexte;
  const lue = relireLAncre(contexte);
  if (!lue.valide) return dire(noeuds.refus, lue.aveu);
  dire(noeuds.refus, "");
  surMesure("geste");
  const annonce = annonceDAttente({ moyen, moteur: contexte.moteur });
  releve.attenteAnnoncee = annonce === null ? null : annonce.attenteMs;
  dire(noeuds.attente, annonce === null ? "" : `${annonce.texte}\n${TEXTE_EN_COURS}`);
  publier(contexte);
  await peindre();
  surMesure("annonce");
  try {
    // Le geste PRÉPARATOIRE — la dérivation d'une phrase — a lieu ICI, après l'annonce et avant
    // l'envoi : c'est ce qui laisse l'annonce à l'écran pendant tout le calcul.
    const charge = avantEnvoi === null ? corps : await avantEnvoi(corps);
    const reponse = await contexte.demander("deverrouiller", {
      moyen,
      versionMinimale: lue.version,
      ...charge,
    });
    dire(noeuds.attente, "");
    releve.dernierRefus = null;
    surMesure("ouverture");
    await rafraichirLInventaire(contexte);
    contexte.surEtat(reponse);
    dire(noeuds.etat, messageDOuverture(reponse));
  } catch (erreur) {
    dire(noeuds.attente, "");
    montrerLeRefus(contexte, erreur);
  }
}

/**
 * Ce que l'utilisateur lit après une ouverture réussie — et, s'il y a lieu, ce qu'il doit RE-NOTER.
 *
 * Une migration de page d'enveloppe avance le compteur de version d'UNE unité, et ce cran n'est le
 * fait d'aucun geste de l'utilisateur : il n'a ni ajouté, ni remplacé, ni révoqué de clé. L'ancre
 * qu'il a notée avant la migration — la seule qu'un porteur de page v1 puisse tenir — ne détecte
 * donc plus l'effacement de la page v2 par un adversaire qui sait écrire dans l'OPFS, et le produit
 * remigre à chaque ouverture sans que l'ancre ne bronche (revue de sécurité de la PR #187,
 * constat 5).
 *
 * Ce n'est pas une perte de volume, et la page v1 conservée reste ce qui rend la migration sûre
 * sous coupure. Ce qui manquait est l'AVEU, et il se fait ici : la conduite est de re-noter la
 * version affichée après la première ouverture qui migre.
 */
export function messageDOuverture(reponse) {
  const version = `Coffre ouvert (version d'enveloppe ${reponse.versionEnveloppe}).`;
  return reponse.enveloppeMigree === true
    ? `${version} L'enveloppe a été mise à jour au format v2 : RE-NOTEZ cette version — celle que vous aviez notée ne vaut plus.`
    : version;
}

/** Rend un refus à l'utilisateur, sous sa conduite et son code. Un seul endroit, un seul format. */
function montrerLeRefus(contexte, erreur) {
  contexte.releve.dernierRefus = erreur?.code ?? null;
  dire(contexte.noeuds.refus, conduiteDeRefus(erreur?.code ?? null, erreur?.message));
  publier(contexte);
}

/**
 * Ouvre par la PHRASE.
 *
 * Le champ est vidé AVANT l'appel : ce qui part est la valeur déjà lue, et le DOM ne porte plus le
 * secret pendant les deux secondes de la dérivation — c'est-à-dire pendant tout le temps où
 * quelqu'un regarderait par-dessus l'épaule (ADR 0029, limite 1).
 */
async function ouvrirParLaPhrase(contexte) {
  const phrase = contexte.noeuds.phrase.value;
  contexte.noeuds.phrase.value = "";
  // La phrase est dérivée dans un Worker DÉDIÉ, et ce qui part vers le Worker de confiance est la
  // `CryptoKey` non extractible — exactement ce que la passkey lui envoie déjà (ADR 0029, déc. 5).
  await ouvrirPar(contexte, "phrase", { phrase }, (corps) =>
    deriverAvant(contexte, corps, () =>
      contexte.deriverPhrase({ inventaire: contexte.inventaire, phrase }),
    ),
  );
}

/**
 * Dérive AVANT d'envoyer, en gardant l'annonce d'attente à l'écran pendant le calcul.
 *
 * C'est ici que l'attente annoncée sert vraiment : le calcul a lieu dans un autre fil, la page reste
 * vivante, et le paragraphe d'annonce est peint depuis le début du geste jusqu'à son terme.
 */
async function deriverAvant(contexte, corps, deriver) {
  const derive = await deriver();
  void contexte;
  // La phrase ne repart PAS vers le Worker de confiance : elle a servi, elle reste ici, et ce qui
  // franchit le port privilégié est le handle opaque et les paramètres publics.
  const { phrase: _phrase, ...reste } = corps;
  void _phrase;
  return { ...reste, ...derive };
}

/** Ouvre par le CODE, une fois seulement que la somme de contrôle a vérifié. */
async function ouvrirParLeCode(contexte) {
  const etat = relireLaSaisieDuCode(contexte);
  if (!etat.envoyable) return;
  const code = contexte.noeuds.code.value;
  contexte.noeuds.code.value = "";
  relireLaSaisieDuCode(contexte);
  await ouvrirPar(contexte, "recuperation", { code });
}

/** Ouvre par la PASSKEY : la dérivation a lieu dans la page, et seule la CryptoKey en repart. */
async function ouvrirParLaPasskey(contexte) {
  const lue = relireLAncre(contexte);
  if (!lue.valide) return dire(contexte.noeuds.refus, lue.aveu);
  dire(contexte.noeuds.refus, "");
  try {
    const derive = await contexte.deriverPasskey({ inventaire: contexte.inventaire });
    await ouvrirPar(contexte, "webauthn-prf", derive);
  } catch (erreur) {
    montrerLeRefus(contexte, erreur);
  }
}

/**
 * Crée le moyen de récupération, et affiche la FEUILLE.
 *
 * Le code est écrit dans le DOM, et NULLE PART ailleurs. Il n'entre ni dans le relevé, ni dans un
 * journal, ni dans le presse-papiers : `releve.codeRendu` est un BOOLÉEN.
 */
async function creerLaFeuille(contexte) {
  const { noeuds, releve } = contexte;
  dire(noeuds.refus, "");
  try {
    const rendu = await contexte.demander("creerRecuperation", {});
    const feuille = feuilleDeRecuperation({ code: rendu.code, version: rendu.versionEnveloppe });
    dire(noeuds.feuilleCode, feuille.decoupe);
    dire(noeuds.feuilleVersion, `Version d'enveloppe : ${feuille.version}`);
    dire(noeuds.feuilleConsigne, feuille.consigne);
    dire(
      noeuds.versionANoter,
      versionANoter({ version: feuille.version, geste: "Moyen de récupération créé" }),
    );
    releve.codeRendu = true;
    publier(contexte);
    await rafraichirLInventaire(contexte);
  } catch (erreur) {
    montrerLeRefus(contexte, erreur);
  }
}

/** Rend la main au moteur pour qu'il PEIGNE l'annonce avant que la dérivation ne le bloque. */
function peindre() {
  return new Promise((rendre) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => rendre());
    else setTimeout(rendre, 0);
  });
}

/** Les nœuds que l'interface touche, relevés une fois. Un nœud manquant est une erreur ici. */
function poignees(doc, racine) {
  const trouver = (identifiant) => {
    const noeud = racine.querySelector(`#${identifiant}`);
    if (noeud === null) {
      throw new Error(`L'interface de déverrouillage exige le nœud « ${identifiant} ».`);
    }
    return noeud;
  };
  void doc;
  return {
    moyens: trouver("deverrouillage-moyens"),
    avertissement: trouver("deverrouillage-avertissement"),
    sansRecuperation: trouver("deverrouillage-sans-recuperation"),
    attente: trouver("deverrouillage-attente"),
    refus: trouver("deverrouillage-refus"),
    etat: trouver("deverrouillage-etat"),
    releve: trouver("deverrouillage-releve"),
    ancre: trouver("ancre-version"),
    aveu: trouver("ancre-aveu"),
    phrase: trouver("saisie-phrase"),
    ouvrirParPhrase: trouver("ouvrir-par-phrase"),
    ouvrirParPasskey: trouver("ouvrir-par-passkey"),
    code: trouver("saisie-code"),
    codeDecoupe: trouver("code-decoupe"),
    codeVerdict: trouver("code-verdict"),
    ouvrirParCode: trouver("ouvrir-par-code"),
    creerRecuperation: trouver("creer-recuperation"),
    feuilleCode: trouver("feuille-code"),
    feuilleVersion: trouver("feuille-version"),
    feuilleConsigne: trouver("feuille-consigne"),
    versionANoter: trouver("version-a-noter"),
  };
}
