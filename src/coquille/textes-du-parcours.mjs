// Les TEXTES du parcours guidé (#193, ADR 0040) : tout ce que la page montre à une personne.
//
// Ils ont quitté `parcours.mjs` pour deux raisons. Le cliquet de taille (`taille-des-fichiers.test.mjs`,
// plafond de 800 lignes) : les écrans, les messages et les libellés en pesaient la moitié. Et la
// relecture (revue de la PR #213, constat 7) : la page et `tools/relecture-parcours.mjs` lisent
// désormais les MÊMES constantes, si bien que la page de relecture ne peut plus dériver de ce qui est
// servi. `parcours.mjs` les réexporte ; il garde l'ordre, et ce module ne décide rien.
//
// Pur, comme le reste du répertoire : ni DOM, ni stockage, ni horloge.

/** Les neuf étapes de la Definition of Ready de #193, dans l'ordre. */
export const ETAPES = Object.freeze([
  Object.freeze({ rang: 1, titre: "Créer votre coffre" }),
  Object.freeze({ rang: 2, titre: "Choisir comment l'ouvrir" }),
  Object.freeze({ rang: 3, titre: "Recevoir et confirmer votre code de récupération" }),
  Object.freeze({ rang: 4, titre: "Travailler dans l'application" }),
  Object.freeze({ rang: 5, titre: "Verrouiller et rouvrir" }),
  Object.freeze({ rang: 6, titre: "Sauvegarder votre coffre" }),
  Object.freeze({ rang: 7, titre: "Restaurer sur un autre appareil" }),
  Object.freeze({ rang: 8, titre: "Récupérer votre coffre avec le code" }),
  Object.freeze({ rang: 9, titre: "Révoquer en urgence" }),
]);

/**
 * Ce que les blocs portent de VISIBLE : leurs boutons et leurs champs, tels que `public/index.html`
 * les nomme (ou que la page les renomme). La page de relecture les liste ; une épreuve relit qu'ils
 * sont bien ceux du document.
 */
export const LIBELLES_DES_BLOCS = Object.freeze({
  commencer: ["« Commencer »", "« J'ai déjà une sauvegarde »"],
  ancre: ["« Numéro de version noté sur votre feuille (facultatif) » (champ)"],
  phrase: ["« Votre phrase » (champ)", "« Créer mon coffre » ou « Ouvrir mon coffre »"],
  passkey: ["« Créer mon coffre avec une passkey » ou « Ouvrir mon coffre avec ma passkey »"],
  perdu: ["« J'ai oublié ma phrase : utiliser mon code de récupération »"],
  code: ["« Code de récupération » (champ)", "« Ouvrir mon coffre avec le code »"],
  "feuille-annonce": ["« Afficher mon code de récupération »"],
  "nouveau-code": ["« Je n'ai plus cette feuille — afficher un nouveau code »"],
  "feuille-revenir": [
    "« Revenir : j'ai toujours ma feuille » (seulement quand la personne a dit ne plus l'avoir)",
  ],
  feuille: ["« Votre code de récupération : » suivi du code", "« J'ai recopié mon code »"],
  revoir: ["« Revoir mon code »"],
  application: [
    "« Démarrer l'application »",
    "« Reprendre l'installation » (seulement si une installation a été interrompue)",
  ],
  verrouiller: ["« Verrouiller mon coffre »"],
  "espace-de-travail": ["l'application elle-même, une fois démarrée"],
  sauvegarde: ["« Sauvegarder mon coffre »", "« Enregistrer la sauvegarde » (lien)"],
  restauration: [
    "« Fichier de sauvegarde » (champ)",
    "« Restaurer ma sauvegarde sur cet appareil »",
  ],
  revocation: ["« Révoquer tous les autres moyens d'ouvrir ce coffre »"],
  "sans-revoquer": ["« Terminer sans révoquer »"],
  continuer: ["« Continuer : » suivi du titre de l'étape suivante"],
  retour: ["« Revenir à mon application »"],
});

const ENVIRON_DEUX_MINUTES =
  "Le premier démarrage installe l'application : comptez environ deux minutes, parfois davantage " +
  "sur un appareil lent ou occupé. Les démarrages suivants sont plus courts. Pendant ce temps, " +
  "l'onglet peut sembler figé : ne le fermez pas. La progression s'affiche sous le bouton.";

const QUELQUES_SECONDES_DE_VERROUILLAGE = "Le verrouillage prend quelques secondes.";

/**
 * La limite de Firefox, dite AVANT toute attente (revue de la PR #213, constat 9 ; ADR 0038) : sous
 * ce moteur, la machine qui porte l'application tourne environ six fois plus lentement, et son
 * démarrage n'a jamais abouti.
 */
export const LIMITE_DE_FIREFOX =
  "Dans cette version de RailsBox Vault, l'application ne démarre pas dans Firefox : elle y " +
  "fonctionne environ six fois plus lentement, et son démarrage n'a jamais abouti. Pour travailler " +
  "dans l'application, utilisez Chrome ou Edge récents.";

/**
 * Ce qu'une personne fait d'une feuille perdue sur un coffre OUVERT (#214) : elle en demande une
 * nouvelle. L'ancien code n'est pas remplacé — il reste valable jusqu'à une révocation —, et c'est
 * pourquoi l'écran nomme les DEUX sorties : « je ne l'ai plus » et « quelqu'un l'a vue ».
 */
const SI_LA_FEUILLE_EST_PERDUE =
  "Si vous n'avez plus cette feuille, cliquez sur « Je n'ai plus cette feuille — afficher un " +
  "nouveau code » : un nouveau code sera affiché, une seule fois, et vous le recopierez sur une " +
  "feuille neuve. L'ancien code continue d'ouvrir ce coffre tant que personne ne le retire. Si " +
  "quelqu'un d'autre a vu votre feuille, cliquez aussi sur « Je n'ai plus cette feuille », puis, " +
  "avant d'afficher un nouveau code, sur « Révoquer tous les autres moyens d'ouvrir ce coffre » : " +
  "les anciens codes seront retirés.";

/**
 * La même question sur un coffre VERROUILLÉ : afficher un code exige un coffre ouvert, et celui-ci
 * ne l'est pas. Le coffre est encore vide à l'étape 3 : l'abandonner ne coûte rien, et la conduite
 * dit COMMENT.
 */
const SI_LE_CODE_EST_PERDU =
  "Si vous n'avez plus cette feuille, cliquez sur « Je n'ai plus cette feuille — afficher un " +
  "nouveau code » : un coffre VERROUILLÉ n'affiche aucun code, vous l'ouvrirez donc d'abord avec " +
  "votre phrase, et un nouveau code vous sera proposé ensuite. L'ancien code continue d'ouvrir ce " +
  "coffre tant que personne ne le retire. Si vous n'avez ni la feuille ni la phrase et que vous " +
  "n'avez encore rien mis dans ce coffre, abandonnez-le : dans les réglages du navigateur, effacez " +
  "les données de ce site, rechargez la page, puis créez un nouveau coffre. Si vous avez déjà mis " +
  "des données dans ce coffre, n'effacez rien et demandez de l'aide.";

/**
 * Une sauvegarde ne connaît que les codes qui existaient quand elle a été faite (revue de la PR
 * #219, constat 5) : l'archive emporte les emplacements du moment, pas ceux qui viendront.
 */
const SAUVEGARDE_ANTERIEURE =
  "Une sauvegarde faite avant ce nouveau code ne le connaît pas : refaites-en une à l'étape 6.";

/** La sortie de l'annonce, quand on y est venu dire « je n'ai plus cette feuille » (#239). */
const SI_LA_FEUILLE_EST_RETROUVEE =
  " Si vous avez retrouvé votre feuille, cliquez sur « Revenir : j'ai toujours ma feuille ».";

const UN_CODE_A_DEJA_ETE_RENDU =
  "Un code de récupération a déjà été affiché pour ce coffre, et il ne sera plus jamais réaffiché : " +
  "il n'existe que sur votre feuille. Pour continuer, ouvrez votre coffre avec ce code, en le " +
  "lisant sur votre feuille — c'est ainsi que l'on vérifie que votre feuille est juste. Sur cet " +
  "appareil, cela ne vous est demandé qu'une fois : ensuite, votre phrase suffit, tant que vous ne " +
  "l'avez pas révoquée.";

/**
 * Ce que la révocation d'urgence COÛTE dépend du moyen de la séance : elle garde celui qui vient
 * d'ouvrir et retire les autres (contre-recette QA de #244). L'écran renvoie au texte écrit au-dessus
 * du bouton, que la page choisit (`MESSAGES.avertissementDeRevocation`).
 */
const CE_QUE_LA_REVOCATION_RETIRE =
  "Ce que la révocation retirerait est écrit au-dessus du bouton : cela dépend du moyen avec lequel " +
  "vous avez ouvert ce coffre.";

/** Les moyens, tels qu'une personne les nomme, et ce que la révocation retire des autres. */
const MOYEN_NOMME = Object.freeze({
  phrase: "votre phrase",
  "webauthn-prf": "votre passkey",
  recuperation: "le code de votre feuille",
});
const LES_AUTRES_RETIRES = Object.freeze({
  phrase:
    "Votre passkey et vos codes de récupération ne fonctionneront plus : votre feuille de " +
    "récupération ne servira plus à rien, créez-en une nouvelle ensuite.",
  "webauthn-prf":
    "Votre phrase et vos codes de récupération ne fonctionneront plus : votre feuille de " +
    "récupération ne servira plus à rien, créez-en une nouvelle ensuite.",
  recuperation:
    "Votre phrase et votre passkey ne fonctionneront plus sur ce coffre : seul le code de votre " +
    "feuille l'ouvrira.",
});

/**
 * L'étape 3 éprouve la feuille en S'EN SERVANT (#239) : verrouiller, puis rouvrir par le code. Le
 * coffre est encore vide, et la phrase le rouvre si la recopie était fausse.
 */
const EPROUVER_LA_FEUILLE =
  "Pour être sûr que votre feuille est juste, vous allez vous en servir : verrouillez votre " +
  "coffre, puis rouvrez-le avec le code que vous venez de recopier. Le code quitte alors cette " +
  "page. Votre coffre est encore vide : si vous vous êtes trompé en recopiant, votre phrase le " +
  "rouvre, et rien n'est perdu.";

/**
 * L'application, telle que l'étape 4 et l'accueil la montrent.
 *
 * T2 de #236 ajoutera ici un BLOC « Mettre à jour l'application », sous l'application, montré
 * seulement quand une mise à jour est proposée : un bloc de ces deux écrans, pas une étape (#239).
 */
const L_APPLICATION_S_EXECUTE_ICI =
  "L'application s'exécute entièrement dans votre navigateur. Ce que vous y écrivez est enregistré " +
  "dans votre coffre, sur cet appareil.";

/**
 * Les écrans. Chacun porte son étape, un titre, ce qui va se passer, ce qui est attendu, l'attente
 * annoncée AVANT le geste quand il dure (`null` sinon), et les blocs qu'il montre.
 */
export const ECRANS = Object.freeze({
  chargement: ecran(null, {
    titre: "Préparation",
    ceQuiVaSePasser: "RailsBox Vault vérifie ce que cet appareil contient déjà.",
    attendu: "Rien : patientez quelques secondes.",
    blocs: [],
  }),
  refuse: ecran(1, {
    titre: "Ce coffre ne peut pas être ouvert ici",
    ceQuiVaSePasser:
      "RailsBox Vault a trouvé sur cet appareil un coffre qu'il ne peut pas ouvrir. Rien n'a été " +
      "modifié. Lisez le message ci-dessous : il dit quoi faire.",
    attendu: "Suivez les indications du message.",
    blocs: [],
  }),
  creer: ecran(1, {
    titre: "Créer votre coffre",
    ceQuiVaSePasser:
      "Votre coffre garde une application et ses données sur cet appareil, dans ce navigateur, " +
      "protégées par votre secret. Cette version est expérimentale : utilisez uniquement des données " +
      "d'essai. La protection dépend aussi du navigateur et de la version de RailsBox Vault que vous utilisez.",
    attendu:
      "Cliquez sur « Commencer ». Si vous avez déjà une sauvegarde d'un coffre, choisissez plutôt « " +
      "J'ai déjà une sauvegarde ».",
    blocs: ["commencer"],
  }),
  choisir: ecran(2, {
    titre: "Choisir comment l'ouvrir",
    ceQuiVaSePasser:
      "Vous choisissez le secret qui ouvrira votre coffre. Le plus simple est une phrase : plusieurs " +
      "mots, faciles à retenir pour vous et difficiles à deviner pour les autres. Le coffre est créé " +
      "dès que vous cliquez.",
    attendu: "Tapez votre phrase, puis cliquez sur « Créer mon coffre ».",
    blocs: ["phrase", "passkey"],
  }),
  "code-annonce": ecran(3, {
    titre: "Recevoir votre code de récupération",
    ceQuiVaSePasser:
      "Si vous oubliez votre phrase, seul un code de récupération pourra rouvrir votre coffre. Sans " +
      "lui, une phrase oubliée est un coffre perdu, et personne ne peut vous aider. Ce code ne " +
      "s'affichera QU'UNE SEULE FOIS : préparez une feuille de papier et un stylo avant de cliquer.",
    attendu: "Quand vous êtes prêt à écrire, cliquez sur « Afficher mon code de récupération ».",
    blocs: ["feuille-annonce", "feuille-revenir", "revocation"],
  }),
  "code-feuille": ecran(3, {
    titre: "Recopier votre code de récupération",
    ceQuiVaSePasser:
      "Voici votre code. Il ne sera plus jamais affiché, et rien sur cet appareil n'en garde de copie. " +
      "Recopiez-le à la main, avec le numéro de version, et rangez la feuille ailleurs que près de " +
      "cet appareil.",
    attendu:
      "Recopiez le code et le numéro de version, puis cliquez sur « J'ai recopié mon code ».",
    blocs: ["feuille"],
  }),
  "code-a-verrouiller": ecran(3, {
    titre: "Vérifier votre code de récupération",
    ceQuiVaSePasser: EPROUVER_LA_FEUILLE,
    attendu:
      "Cliquez sur « Verrouiller mon coffre », puis ouvrez-le avec le code de votre feuille. Si vous " +
      "n'avez pas fini de recopier, cliquez d'abord sur « Revoir mon code ».",
    attente: QUELQUES_SECONDES_DE_VERROUILLAGE,
    blocs: ["revoir", "verrouiller"],
  }),
  "code-verifier": ecran(3, {
    titre: "Vérifier votre code de récupération",
    ceQuiVaSePasser: UN_CODE_A_DEJA_ETE_RENDU,
    attendu:
      "Si vous avez votre feuille : tapez le code, puis cliquez sur « Ouvrir mon coffre avec le " +
      "code ». " +
      SI_LE_CODE_EST_PERDU,
    blocs: ["code", "nouveau-code"],
  }),
  "code-a-verifier": ecran(3, {
    titre: "Vérifier votre code de récupération",
    ceQuiVaSePasser: UN_CODE_A_DEJA_ETE_RENDU,
    attendu:
      "Si vous avez votre feuille : cliquez sur « Verrouiller mon coffre », puis ouvrez le coffre " +
      "avec le code que vous y avez recopié. " +
      SI_LA_FEUILLE_EST_PERDUE,
    attente: QUELQUES_SECONDES_DE_VERROUILLAGE,
    blocs: ["nouveau-code", "verrouiller"],
  }),
  travailler: ecran(4, {
    titre: "Travailler dans l'application",
    ceQuiVaSePasser: L_APPLICATION_S_EXECUTE_ICI,
    attendu:
      "Cliquez sur « Démarrer l'application », attendez qu'elle s'affiche, puis utilisez-la. Quand " +
      "vous avez fini, passez à l'étape suivante.",
    attente: ENVIRON_DEUX_MINUTES,
    blocs: ["application", "espace-de-travail", "continuer"],
  }),
  accueil: ecran(4, {
    titre: "Votre application",
    ceQuiVaSePasser:
      "La visite est finie. " +
      L_APPLICATION_S_EXECUTE_ICI +
      " Vos gestes de tous les jours sont sur cet écran : verrouiller le coffre quand vous avez " +
      "fini, le sauvegarder de temps en temps, et révoquer les autres moyens de l'ouvrir si l'un " +
      "d'eux a pu être vu. " +
      CE_QUE_LA_REVOCATION_RETIRE,
    attendu:
      "Cliquez sur « Démarrer l'application », attendez qu'elle s'affiche, puis utilisez-la. Quand " +
      "vous avez fini, cliquez sur « Verrouiller mon coffre ».",
    attente: ENVIRON_DEUX_MINUTES,
    blocs: ["application", "verrouiller", "espace-de-travail", "sauvegarde", "revocation"],
  }),
  "travailler-sans-application": ecran(4, {
    titre: "Travailler dans l'application",
    ceQuiVaSePasser: LIMITE_DE_FIREFOX,
    attendu:
      "Ouvrez RailsBox Vault dans Chrome ou Edge récents et créez-y votre coffre. Le coffre créé dans " +
      "ce navigateur-ci est encore vide : vous pouvez l'abandonner en effaçant les données de ce site " +
      "dans les réglages du navigateur.",
    blocs: [],
  }),
  verrouiller: ecran(5, {
    titre: "Verrouiller votre coffre",
    ceQuiVaSePasser:
      "Verrouiller arrête l'application, enregistre tout, et referme le coffre : plus rien n'est " +
      "lisible sans votre secret. La page se recharge ensuite. Le coffre se verrouille aussi tout seul " +
      "après un moment sans activité.",
    attendu: "Cliquez sur « Verrouiller mon coffre », puis rouvrez-le avec votre phrase.",
    attente: QUELQUES_SECONDES_DE_VERROUILLAGE,
    blocs: ["verrouiller", "espace-de-travail", "retour"],
  }),
  rouvrir: ecran(5, {
    titre: "Rouvrir votre coffre",
    ceQuiVaSePasser:
      "Votre coffre est verrouillé. Il s'ouvre avec la phrase que vous avez choisie. Si vous avez " +
      "noté un numéro de version sur votre feuille, tapez-le : il empêche qu'on vous rende une copie " +
      "plus ancienne de votre coffre sans que vous le sachiez.",
    attendu: "Tapez votre phrase, puis cliquez sur « Ouvrir mon coffre ».",
    blocs: ["ancre", "phrase", "passkey", "perdu"],
  }),
  sauvegarder: ecran(6, {
    titre: "Sauvegarder votre coffre",
    ceQuiVaSePasser:
      "Une sauvegarde est un fichier qui contient tout votre coffre, toujours protégé. L'application " +
      "est arrêtée le temps de la sauvegarde. Le fichier est enregistré par votre navigateur, comme " +
      "un téléchargement : gardez-en une copie ailleurs que sur cet appareil (clé USB, autre " +
      "ordinateur).",
    attendu:
      "Cliquez sur « Sauvegarder mon coffre ». Si le navigateur ne l'enregistre pas tout seul, " +
      "cliquez sur « Enregistrer la sauvegarde ».",
    attente:
      "La sauvegarde prend de quelques secondes à quelques minutes, selon la taille du coffre et " +
      "l'appareil. Ne fermez pas l'onglet.",
    blocs: ["sauvegarde", "continuer", "retour"],
  }),
  "restaurer-ailleurs": ecran(7, {
    titre: "Restaurer sur un autre appareil",
    ceQuiVaSePasser:
      "Votre sauvegarde permet de retrouver votre coffre sur un autre appareil, dans un autre " +
      "navigateur ou à une autre adresse. Il s'y ouvrira avec votre code de récupération. On ne " +
      "restaure jamais par-dessus un coffre existant : faites-le là où il n'y en a pas encore.",
    attendu:
      "Sur l'autre appareil, ouvrez RailsBox Vault, choisissez « J'ai déjà une sauvegarde » et donnez " +
      "le fichier. Pour continuer ici, cliquez sur le bouton ci-dessous.",
    blocs: ["continuer", "retour"],
  }),
  restaurer: ecran(7, {
    titre: "Restaurer une sauvegarde",
    ceQuiVaSePasser:
      "Le coffre contenu dans la sauvegarde est recopié sur cet appareil, puis vérifié. Rien n'est " +
      "écrit si le fichier est abîmé. Le coffre restauré s'ouvre ensuite avec votre code de " +
      "récupération.",
    attendu:
      "Choisissez le fichier de sauvegarde, puis cliquez sur « Restaurer ma sauvegarde sur cet " +
      "appareil ».",
    attente:
      "La restauration prend de quelques secondes à quelques minutes, selon la taille du coffre et " +
      "l'appareil. Ne fermez pas l'onglet.",
    blocs: ["restauration"],
  }),
  "recuperer-preparer": ecran(8, {
    titre: "Récupérer votre coffre avec le code",
    ceQuiVaSePasser:
      "Si vous avez oublié votre phrase, le code de récupération rouvre votre coffre. Pour vous " +
      "entraîner, verrouillez d'abord le coffre : vous le rouvrirez avec le code.",
    attendu: "Cliquez sur « Verrouiller mon coffre ».",
    attente: QUELQUES_SECONDES_DE_VERROUILLAGE,
    blocs: ["verrouiller", "retour"],
  }),
  recuperer: ecran(8, {
    titre: "Récupérer votre coffre avec le code",
    ceQuiVaSePasser:
      "Le code de récupération de votre feuille rouvre votre coffre, même sans la phrase. Le numéro " +
      "de version noté à côté du code protège contre une copie plus ancienne : tapez-le aussi.",
    attendu:
      "Tapez le numéro de version et le code de votre feuille, puis cliquez sur « Ouvrir mon coffre " +
      "avec le code ».",
    blocs: ["ancre", "code"],
  }),
  revoquer: ecran(9, {
    titre: "Révoquer en urgence",
    ceQuiVaSePasser:
      "Cette étape est facultative : elle vous montre le geste à faire si quelqu'un connaît votre " +
      "phrase ou a trouvé votre feuille. Révoquer retire tout ce qui ouvre ce coffre, SAUF le moyen " +
      "que vous venez d'utiliser. " +
      CE_QUE_LA_REVOCATION_RETIRE +
      " Les sauvegardes déjà faites restent ouvrables par les anciens moyens : détruisez-les si elles " +
      "risquent de tomber entre de mauvaises mains, puis faites une nouvelle sauvegarde.",
    attendu:
      "Si personne n'a vu votre phrase ni votre feuille, cliquez sur « Terminer sans révoquer ». " +
      "Seulement si c'est nécessaire, cliquez sur « Révoquer tous les autres moyens d'ouvrir ce " +
      "coffre », puis notez le nouveau numéro de version sur votre feuille.",
    blocs: ["revocation", "sans-revoquer", "retour"],
  }),
  "termine-sans-revoquer": ecran(9, {
    titre: "Parcours terminé",
    ceQuiVaSePasser:
      "Vous avez fait le tour de votre coffre, sans rien révoquer : votre phrase, votre passkey et " +
      "votre feuille l'ouvrent toujours. Si un jour l'un de ces moyens a pu être vu, la révocation " +
      "reste disponible sur l'écran de votre application.",
    attendu: "Pour vous servir de votre application, cliquez sur « Revenir à mon application ».",
    blocs: ["retour"],
  }),
  termine: ecran(9, {
    titre: "Parcours terminé",
    ceQuiVaSePasser:
      "Seul le moyen que vous avez utilisé pour ouvrir ce coffre l'ouvre désormais. Les sauvegardes " +
      "déjà faites restent ouvrables par les anciens moyens : détruisez-les si elles risquent de " +
      "tomber entre de mauvaises mains, puis faites une nouvelle sauvegarde.",
    attendu:
      "Notez sur votre feuille le numéro de version indiqué ci-dessous. Pour vous servir de votre " +
      "application, cliquez sur « Revenir à mon application ».",
    blocs: ["retour"],
  }),
});

/** @param {number | null} rang */
function ecran(rang, { titre, ceQuiVaSePasser, attendu, attente = null, blocs }) {
  return Object.freeze({
    etape: rang,
    titre,
    ceQuiVaSePasser,
    attendu,
    attente,
    blocs: Object.freeze([...blocs]),
  });
}

/**
 * Les libellés que la MISE EN FORME ajoute à la page (#194 ; revue de la PR #216, constat 6). Le repli
 * de l'aide est créé par le branchement quand Rails est prêt, et nommé d'ici ; la page de relecture le
 * lit au même endroit. Le lien d'évitement et le repli du relais sont écrits dans leurs documents, et
 * `tools/relecture-parcours.mjs` les y relit.
 */
export const LIBELLES_DE_LA_PAGE = Object.freeze({
  aideDeLEtape: "Aide pour cette étape",
});

/**
 * Les MESSAGES que la page écrit en plus des écrans : réussites, attentes en cours, consignes. Ceux
 * qui portent une valeur sont des fonctions ; la page de relecture les appelle avec « N ».
 */
export const MESSAGES = Object.freeze({
  rang: (rang) => `Étape ${rang} sur ${ETAPES.length}`,
  attendu: (texte) => `Ce que vous avez à faire : ${texte}`,
  duree: (texte) => `Durée : ${texte}`,
  suivante: (titre) => `Étape suivante : ${titre}.`,
  continuer: (titre) => (titre === null ? "Continuer" : `Continuer : ${titre}`),
  passkeyALaCreation:
    "Ce navigateur connaît les passkeys (empreinte, visage, code de l'appareil ou clé de " +
    "sécurité). Toutes ne savent pas protéger un coffre : si la vôtre ne le sait pas, RailsBox " +
    "Vault vous le dira, et vous pourrez utiliser une phrase.",
  passkeyALOuverture: "Ce coffre s'ouvre aussi avec votre passkey.",
  consigneDeLaFeuille: (version) =>
    `Numéro de version à noter à côté du code : ${version}. Recopiez les 7 groupes de 4 symboles ` +
    `exactement. Ce code ne sera plus jamais affiché.`,
  feuilleEprouvee:
    "Votre feuille est juste : son code a ouvert votre coffre. Gardez-la bien, loin de cet appareil.",
  saisieIncomplete: (lus, total) => `${lus} symbole(s) sur ${total}.`,
  saisieComplete: "Code complet : aucune faute de recopie détectée.",
  coffreOuvert: "Votre coffre est ouvert.",
  ouvertureEnCours: "Ouverture en cours… Ne fermez pas l'onglet.",
  verrouillageEnCours: "Verrouillage en cours… Ne fermez pas l'onglet.",
  repriseEnCours: "Reprise de l'installation en cours… Ne fermez pas l'onglet.",
  sauvegardeEnCours: "Sauvegarde en cours… Ne fermez pas l'onglet.",
  restaurationEnCours: "Restauration en cours… Ne fermez pas l'onglet.",
  applicationDemarree: "L'application est démarrée : elle s'affiche ci-dessous.",
  applicationEnAttente:
    "L'application n'est pas encore démarrée : elle s'affichera ici quand vous aurez cliqué sur « " +
    "Démarrer l'application ».",
  applicationAffichee: "L'application s'affiche ci-dessous.",
  demarrageEnCours: (secondes, vie) =>
    `Démarrage en cours depuis ${secondes} seconde(s), sur environ deux minutes. ${vie}`,
  signesDeVie: (nombre) => `Le coffre travaille : ${nombre} signe(s) de vie reçu(s).`,
  premierSigneDeVie: "En attente du premier signe de vie du coffre.",
  sauvegardePrete:
    "Sauvegarde prête. Votre navigateur l'enregistre sous le nom « coffre.rbvault » ; si rien ne " +
    "s'est enregistré, cliquez sur « Enregistrer la sauvegarde ». Pensez à redémarrer " +
    "l'application si vous voulez continuer à l'utiliser.",
  restauree:
    "Sauvegarde restaurée et vérifiée. Ouvrez maintenant le coffre avec votre code — avec un code " +
    "qui existait quand la sauvegarde a été faite.",
  revoque: (nombre, version) =>
    `${nombre} moyen(s) retiré(s). Nouveau numéro de version à noter sur votre feuille : ${version}.`,
  revoqueSansRien:
    "Aucun autre moyen n'ouvrait ce coffre : rien n'a été retiré, et votre feuille reste juste.",
  codeMasque: "(code masqué)",
  avertissementDeRevocation: (moyen) =>
    MOYEN_NOMME[moyen] === undefined
      ? "Seul le moyen avec lequel vous avez ouvert ce coffre continuera de l'ouvrir ; tous les " +
        "autres ne fonctionneront plus."
      : `Seul le moyen avec lequel vous venez d'ouvrir ce coffre — ${MOYEN_NOMME[moyen]} — ` +
        `continuera de l'ouvrir. ${LES_AUTRES_RETIRES[moyen]}`,
  codesDejaRendus: (nombre) =>
    nombre <= 1
      ? "Ce coffre porte déjà un code de récupération. En afficher un nouveau n'efface pas " +
        "l'ancien : les deux ouvriront ce coffre tant que vous n'en retirez aucun. " +
        SAUVEGARDE_ANTERIEURE +
        SI_LA_FEUILLE_EST_RETROUVEE
      : `Ce coffre porte déjà ${nombre} codes de récupération. En afficher un nouveau n'efface ` +
        "aucun des précédents : tous ouvrent ce coffre tant que vous n'en retirez aucun. " +
        SAUVEGARDE_ANTERIEURE +
        SI_LA_FEUILLE_EST_RETROUVEE,
});

/** Ce que « Où suis-je ? » dit de chaque étape. */
export const STATUTS = Object.freeze({
  passee: "étape passée",
  "en-cours": "vous êtes ici",
  "a-venir": "à venir",
  "non-jouee": "non jouée sur cet appareil : le coffre y a été restauré",
});

/** Le texte de l'attente d'une phrase, pour une durée déjà dite (« environ 2 secondes »). */
export function texteDAttenteDeLaPhrase(duree) {
  return (
    `Après votre clic, le coffre fait un calcul volontairement lent, pour qu'on ne puisse pas deviner ` +
    `votre phrase en essayant. Comptez ${duree} sur ce navigateur ; sur un appareil très occupé, ` +
    `cela peut aller jusqu'à une minute et demie. L'onglet peut sembler figé : ne le fermez pas.`
  );
}
