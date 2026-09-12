// Les REFUS de la coquille de produit (#161, ADR 0028).
//
// Un refus de la coquille porte un CODE stable, un message en français et le type reçu. Il ne porte
// jamais autre chose : ni octet du volume, ni nom de fichier, ni état interne. C'est la règle du
// § 10 de la spécification, appliquée à une famille qui n'existait pas — celle de la frontière entre
// la coquille et le document applicatif.
//
// ## Pourquoi un code par geste refusé, et non un seul « non »
//
// La liste de refus de l'issue #24 nomme dix gestes : obtenir une KEK, obtenir une DEK, exporter,
// révoquer, ajouter un emplacement, créer un moyen de récupération, changer d'emplacement de volume,
// lire le fichier d'enveloppes ou son inventaire, obtenir le port privilégié, obtenir un handle. Un
// refus générique les couvrirait tous, et c'est précisément ce qui le rendrait inutile : l'épreuve
// de l'application malveillante ne pourrait plus distinguer « la coquille refuse ce geste-là » de
// « la coquille n'a pas compris le message ». Un relevé tout vert obtenu par incompréhension ne
// prouve rien, et c'est la faute que le témoin positif existe pour trouver.
//
// ## Ce refus n'est PAS un oracle
//
// Le code rendu ne dépend QUE du type reçu. Il est calculé avant que la coquille ait consulté quoi
// que ce soit — état du volume, enveloppe, présence d'une clé —, et deux appareils dans des états
// différents rendent le même code pour le même type. Un adversaire qui lit `VAULT_COQUILLE_KEK_REFUSEE`
// apprend qu'il a demandé une KEK, ce qu'il savait déjà en l'écrivant.

/**
 * Les codes de refus de la coquille. Le préfixe `VAULT_COQUILLE_` les distingue des familles du
 * format de volume : ce ne sont pas des refus du support, ce sont des refus de FRONTIÈRE.
 *
 * La table est relue par `tests/unit/dossier-de-revue.test.mjs`, qui exige que chacun figure au § 10
 * de `docs/format-de-volume-v3.md` — le cliquet d'exhaustivité qui empêche qu'un refus existe dans
 * le code sans qu'un relecteur en soit prévenu.
 */
export const CODES_REFUS_COQUILLE = Object.freeze({
  // --- Encodage du contrat -------------------------------------------------------------------
  /** Le message n'est pas un objet, ou ne porte pas de type : rien à décoder. */
  messageMalforme: "VAULT_COQUILLE_MESSAGE_MALFORME",
  /** L'identifiant ou la version du contrat ne sont pas ceux de cette coquille. */
  contratRefuse: "VAULT_COQUILLE_CONTRAT_REFUSE",
  /** Le type est bien formé et n'est ni admis, ni nommé par la liste de refus. */
  typeInconnu: "VAULT_COQUILLE_TYPE_INCONNU",

  // --- Les dix gestes de la liste de refus (#24, décision 2) ----------------------------------
  kek: "VAULT_COQUILLE_KEK_REFUSEE",
  dek: "VAULT_COQUILLE_DEK_REFUSEE",
  exportation: "VAULT_COQUILLE_EXPORT_REFUSE",
  revocation: "VAULT_COQUILLE_REVOCATION_REFUSEE",
  emplacement: "VAULT_COQUILLE_EMPLACEMENT_REFUSE",
  recuperation: "VAULT_COQUILLE_RECUPERATION_REFUSEE",
  volume: "VAULT_COQUILLE_VOLUME_REFUSE",
  enveloppe: "VAULT_COQUILLE_ENVELOPPE_REFUSEE",
  portPrivilegie: "VAULT_COQUILLE_PORT_PRIVILEGIE_REFUSE",
  handle: "VAULT_COQUILLE_HANDLE_REFUSE",

  // --- L'annonce reçue sur `window`, et sa vérification triple --------------------------------
  /** L'ordre non négociable : aucun port n'est octroyé tant que le canal privilégié n'existe pas. */
  canalAbsent: "VAULT_COQUILLE_CANAL_ABSENT",
  annonceType: "VAULT_COQUILLE_ANNONCE_TYPE",
  annonceOrigine: "VAULT_COQUILLE_ANNONCE_ORIGINE",
  annonceFenetre: "VAULT_COQUILLE_ANNONCE_FENETRE",
  annonceUnique: "VAULT_COQUILLE_ANNONCE_UNIQUE",

  // --- La CORRÉLATION, qui interdit qu'une requête reste muette (revue de #166) ----------------
  /**
   * La requête ne porte pas d'identifiant de corrélation admissible.
   *
   * Sans lui, deux requêtes en vol se disputent une seule réponse et l'une des deux reste MUETTE —
   * ce que la revue de sécurité de la PR #166 a mesuré, et ce que « un refus typé, jamais un
   * silence » interdit. L'exiger est la seule façon d'apparier N réponses à N requêtes.
   */
  correlationAbsente: "VAULT_COQUILLE_CORRELATION_ABSENTE",
  /** Un identifiant déjà en vol : le réemployer rendrait la réponse ambiguë pour l'appelant. */
  correlationDupliquee: "VAULT_COQUILLE_CORRELATION_DUPLIQUEE",
  /** Plus de requêtes en vol que la borne nommée : la coquille refuse au lieu de gonfler. */
  tropDeRequetes: "VAULT_COQUILLE_TROP_DE_REQUETES",

  // --- Ce qui ne doit jamais franchir le port restreint ---------------------------------------
  /**
   * Une capacité dans un message, DANS LES DEUX SENS.
   *
   * Vers l'application : une réponse qui transporterait un handle, une clé ou un transférable — un
   * défaut de programmation de la coquille, et `sansCapacite` lève avant l'envoi. Vers la coquille :
   * un message du document applicatif qui TRANSFÈRE un port ou un tampon. Rien n'en était retenu,
   * mais rien n'était refusé non plus, et la revue de #166 l'a relevé : un canal qu'on n'a pas
   * décidé d'ouvrir doit être fermé nommément.
   */
  capaciteDansUnMessage: "VAULT_COQUILLE_CAPACITE_DANS_UN_MESSAGE",

  // --- Le canal PRIVILÉGIÉ, et l'ordre des gestes qu'il porte (#162, ADR 0029) -----------------
  /**
   * Un geste qui exige un volume OUVERT a été demandé sur un volume qui ne l'est pas.
   *
   * Le seul, pour l'instant : créer un moyen de récupération. « Il faut détenir une KEK VALABLE
   * pour ajouter — l'enveloppe n'est pas un trousseau ouvert en écriture » (ADR 0020, repris par
   * `moyen-de-recuperation.mjs`), et c'est ce qui rend ce geste possible seulement à qui peut déjà
   * ouvrir. Le dire par un code plutôt que par un bouton grisé a une raison : un bouton grisé
   * n'apprend rien à qui l'atteint autrement, et l'épreuve n'a rien à mesurer.
   *
   * Ce refus vit sur le canal PRIVILÉGIÉ, entre la coquille et son Worker. Il n'est jamais rendu au
   * document applicatif — qui reçoit `VAULT_COQUILLE_RECUPERATION_REFUSEE` bien avant, sur le type
   * du message et sans qu'aucun état ne soit consulté.
   */
  volumeVerrouille: "VAULT_COQUILLE_VOLUME_VERROUILLE",

  // --- Le CYCLE DE VIE assemblé, et sa conduite (#163, ADR 0030) ------------------------------
  /**
   * Le WORKER DE CONFIANCE ne répond plus : il a jeté, il a été terminé, ou il s'est tu au-delà de
   * `DELAI_WORKER_MORT_MS`.
   *
   * Ce code est NEUF, et son absence était un défaut relevé par la Definition of Ready de #25 :
   * la borne de mort rejetait sous `typeInconnu`, dont le message dit « Requête hors de la liste
   * d'admission de la coquille » — c'est-à-dire tout autre chose que ce qui s'est produit. Un refus
   * qui décrit un autre événement que le sien est un refus qu'on finit par mal lire.
   *
   * Ce qu'il ne dit PAS : ce que « verrouillé » veut dire, quand cela arrive, ni sous quel délai.
   * L'état et la règle appartiennent à #25 ; #163 constate et conduit (ADR 0030, décision 3).
   */
  workerMort: "VAULT_COQUILLE_WORKER_MORT",
  /**
   * Une étape du cycle de vie a été demandée avant celle dont elle dépend.
   *
   * C'est la garde d'ORDRE de `cycle-de-vie.mjs`, et elle est de la même nature que
   * `canalAbsent` : l'ordre des huit étapes de `docs/architecture.md` n'est pas une convention de
   * lecture, c'est une condition contrôlée qui rougit quand on l'inverse.
   */
  etapeHorsOrdre: "VAULT_COQUILLE_ETAPE_HORS_ORDRE",
  /**
   * Le Worker de confiance a JETÉ en servant une requête ADMISE, sans code de refus à donner.
   *
   * Ce code est NEUF (#169), et il ferme un défaut de la même famille que celui qui a fait naître
   * `workerMort` : le repli de `repondreRefus` renvoyait `typeInconnu` — « Requête hors de la liste
   * d'admission de la coquille » — pour un geste qui était, lui, parfaitement admis. Le message
   * décrivait un autre événement que le sien, et il le décrivait **exactement là où il compte le
   * plus** : sur l'INATTENDU, c'est-à-dire ce dont personne n'a écrit le refus.
   *
   * Ce qu'il dit, et rien de plus : le geste était admis, le Worker a essayé, quelque chose a jeté
   * sans se nommer. Ce qu'il ne dit PAS : ce qui a jeté. Une exception peut nommer un chemin de
   * fichier ; un refus rendu n'a rien à en dire (ADR 0028).
   *
   * Il ne remplace AUCUN code typé : une `StorageError` garde le sien, une erreur d'enveloppe le
   * sien. Le repli ne mord que sur ce qui n'en a pas.
   */
  gesteRompu: "VAULT_COQUILLE_GESTE_ROMPU",
  /**
   * Aucune application n'est servie par cette origine : il n'y a rien à démarrer.
   *
   * Ce n'est pas un échec du geste — c'est l'absence de son objet, comme `indisponible` est
   * l'absence d'un moteur capable plutôt qu'un déverrouillage raté. Un `npm run check` tourne sans
   * les artefacts de l'image de référence, et la coquille doit le DIRE plutôt que d'échouer.
   */
  applicationAbsente: "VAULT_COQUILLE_APPLICATION_ABSENTE",
  /**
   * Une capacité EXIGÉE manque au moteur qui exécute la coquille, mesurée dans son propre document
   * et sous la CSP servie — sans l'exemption dont jouit la sonde `public/compat.html` (#2).
   */
  capaciteManquante: "VAULT_COQUILLE_CAPACITE_MANQUANTE",
  /**
   * Un fichier de volume applicatif existe, mais aucun manifeste ne l'identifie.
   *
   * La coquille REFUSE, et ne réinstalle pas. Un volume naît anonyme et ne devient identifié qu'une
   * fois son disque écrit et flushé : un volume sans manifeste est donc soit une installation
   * interrompue, soit un volume que quelque chose d'autre a écrit. Verser le disque applicatif
   * par-dessus écraserait, sans un geste et sans un mot, tout ce que le guest y aurait mis depuis —
   * exactement le « succès muet » que la spécification refuse partout ailleurs (constat 7 de la
   * revue de sécurité de la PR #171).
   */
  volumeApplicatifSansManifeste: "VAULT_COQUILLE_VOLUME_APPLICATIF_SANS_MANIFESTE",

  // --- Le RELAIS HTTP vers l'application du guest (#192, ADR 0038) -----------------------------
  /**
   * Une requête a été relayée alors qu'aucune application ne TOURNE.
   *
   * Il se distingue de `applicationAbsente` comme `verrouille` se distingue d'`indisponible` :
   * l'un dit « cette origine ne sert aucune application », l'autre « celle-ci n'est pas démarrée ».
   * Le premier appelle un autre déploiement, le second un geste de l'utilisateur — et le cadre, qui
   * n'a pas de bouton, doit pouvoir distinguer les deux pour dire à l'utilisateur ce qu'il attend.
   *
   * C'est aussi lui que le cadre reçoit AVANT le premier démarrage, et c'est ce qui rend l'épreuve
   * rouge de cette tranche mesurable sans machine virtuelle : hier le cadre recevait
   * `VAULT_COQUILLE_TYPE_INCONNU` — « je ne sais pas de quoi tu parles » —, aujourd'hui il reçoit
   * « je sais, et il n'y a rien à servir ».
   */
  applicationNonDemarree: "VAULT_COQUILLE_APPLICATION_NON_DEMARREE",
  /**
   * La requête relayée n'a pas la forme que `relais-http.mjs` admet : méthode hors liste, chemin qui
   * n'est pas un chemin, en-tête illisible, corps qui n'est pas du base64 ou qui franchit le
   * plafond.
   *
   * Un seul code pour cinq causes, et c'est délibéré : à la différence des dix gestes refusés, ces
   * cinq-là ne sont pas des DEMANDES distinctes qu'un adversaire formule — ce sont cinq façons
   * d'écrire mal la même demande. Les distinguer apprendrait à qui tâtonne quelle borne il vient de
   * franchir, et le relevé de la coquille compte déjà les refus par code.
   */
  requeteHttpRefusee: "VAULT_COQUILLE_REQUETE_HTTP_REFUSEE",
  /**
   * La réponse du guest franchit `PLAFOND_CORPS_DE_REPONSE_OCTETS`.
   *
   * Elle n'est pas tronquée : une réponse tronquée est une réponse FAUSSE, que le cadre rendrait
   * comme si elle était entière. Elle est refusée, et le refus dit laquelle.
   */
  reponseHttpTropGrande: "VAULT_COQUILLE_REPONSE_HTTP_TROP_GRANDE",
  /**
   * La réponse est arrivée APRÈS que la coquille a cessé de servir — verrouillage, mort du Worker,
   * fin d'onglet.
   *
   * Elle n'est jamais rendue au cadre, et c'est le point : le verrouillage retire le cadre, et une
   * réponse en vol qui le rattraperait dessinerait des pixels du coffre après sa fermeture. Ce code
   * existe pour que l'ABANDON soit compté et observable plutôt que silencieux.
   */
  relaisAbandonne: "VAULT_COQUILLE_RELAIS_ABANDONNE",
  /**
   * Un type du CANAL DE RELAIS a été posé ailleurs que sur le canal de relais.
   *
   * Même nature que `portPrivilegie` : la coquille refuse NOMMÉMENT la tentative la plus évidente
   * plutôt que de la laisser tomber dans « type inconnu ». Trois vocabulaires, trois canaux, et
   * aucun ne se parle sur celui d'un autre.
   */
  canalDeRelaisRefuse: "VAULT_COQUILLE_CANAL_DE_RELAIS_REFUSE",
});

/** Les messages en français, un par code. Ils décrivent le REFUS, jamais l'état de l'appareil. */
const MESSAGES = Object.freeze({
  [CODES_REFUS_COQUILLE.messageMalforme]: "Message illisible : la coquille attend un objet typé.",
  [CODES_REFUS_COQUILLE.contratRefuse]:
    "Contrat inconnu : cette coquille ne parle pas ce dialecte.",
  [CODES_REFUS_COQUILLE.typeInconnu]: "Requête hors de la liste d'admission de la coquille.",
  [CODES_REFUS_COQUILLE.kek]: "La clé de déverrouillage ne quitte jamais la coquille.",
  [CODES_REFUS_COQUILLE.dek]: "La clé de volume ne quitte jamais le Worker de confiance.",
  [CODES_REFUS_COQUILLE.exportation]:
    "L'export est un geste de l'utilisateur, pas de l'application.",
  [CODES_REFUS_COQUILLE.revocation]:
    "La révocation est un geste de l'utilisateur, pas de l'application.",
  [CODES_REFUS_COQUILLE.emplacement]:
    "Ajouter un emplacement de déverrouillage est un geste de l'utilisateur.",
  [CODES_REFUS_COQUILLE.recuperation]:
    "Créer un moyen de récupération est un geste de l'utilisateur.",
  [CODES_REFUS_COQUILLE.volume]: "L'application ne choisit pas le volume qu'elle habite.",
  [CODES_REFUS_COQUILLE.enveloppe]:
    "Le fichier d'enveloppes et son inventaire ne sont pas lisibles ici.",
  [CODES_REFUS_COQUILLE.portPrivilegie]:
    "Le canal privilégié coquille ↔ Worker n'est atteignable par aucun message.",
  [CODES_REFUS_COQUILLE.handle]:
    "Aucun handle, descripteur ou capacité ne franchit le port restreint.",
  [CODES_REFUS_COQUILLE.canalAbsent]:
    "Annonce refusée : le canal privilégié n'est pas établi ; aucun port n'est octroyé avant lui.",
  [CODES_REFUS_COQUILLE.annonceType]: "Annonce refusée : type inattendu.",
  [CODES_REFUS_COQUILLE.annonceOrigine]: "Annonce refusée : origine inattendue.",
  [CODES_REFUS_COQUILLE.annonceFenetre]: "Annonce refusée : fenêtre émettrice inattendue.",
  [CODES_REFUS_COQUILLE.annonceUnique]: "Annonce refusée : le port restreint a déjà été transféré.",
  [CODES_REFUS_COQUILLE.correlationAbsente]:
    "Requête refusée : il lui faut un identifiant de corrélation, pour que sa réponse lui revienne.",
  [CODES_REFUS_COQUILLE.correlationDupliquee]:
    "Requête refusée : cet identifiant de corrélation est déjà en vol.",
  [CODES_REFUS_COQUILLE.tropDeRequetes]:
    "Requête refusée : trop de requêtes en vol. La coquille borne, elle ne met pas en réserve.",
  [CODES_REFUS_COQUILLE.capaciteDansUnMessage]:
    "Message retenu : il transportait autre chose que des données.",
  [CODES_REFUS_COQUILLE.volumeVerrouille]:
    "Ce geste demande un volume OUVERT : créer un moyen de récupération exige de détenir déjà une clé qui ouvre ce coffre.",
  [CODES_REFUS_COQUILLE.workerMort]:
    "Le Worker de confiance ne répond plus : la coquille ne sert plus rien tant que « Rouvrir le coffre » ne l'a pas rechargée.",
  [CODES_REFUS_COQUILLE.etapeHorsOrdre]:
    "Étape du cycle de vie demandée avant celle dont elle dépend : l'ordre n'est pas une convention.",
  [CODES_REFUS_COQUILLE.gesteRompu]:
    "Le Worker de confiance a jeté en servant ce geste, sans refus à nommer : le geste était admis, il n'a pas abouti.",
  [CODES_REFUS_COQUILLE.applicationAbsente]:
    "Aucune application n'est servie par cette origine : il n'y a rien à démarrer ici.",
  [CODES_REFUS_COQUILLE.capaciteManquante]:
    "Une capacité exigée manque à ce navigateur : la coquille le dit plutôt que de l'inventer.",
  [CODES_REFUS_COQUILLE.volumeApplicatifSansManifeste]:
    "Un volume applicatif existe sans manifeste : la coquille refuse de l'écraser pour installer.",
  [CODES_REFUS_COQUILLE.applicationNonDemarree]:
    "L'application n'est pas démarrée : il n'y a rien à servir tant que le coffre n'a pas été ouvert et l'application lancée.",
  [CODES_REFUS_COQUILLE.requeteHttpRefusee]:
    "Requête relayée refusée : sa méthode, son chemin, ses en-têtes ou son corps sortent de ce que le relais admet.",
  [CODES_REFUS_COQUILLE.reponseHttpTropGrande]:
    "Réponse trop grande pour le relais : elle est refusée entière plutôt que rendue tronquée.",
  [CODES_REFUS_COQUILLE.relaisAbandonne]:
    "Réponse abandonnée : la coquille avait cessé de servir avant qu'elle n'arrive.",
  [CODES_REFUS_COQUILLE.canalDeRelaisRefuse]:
    "Le canal de relais coquille ↔ Worker n'est atteignable par aucun message du port restreint.",
});

/** Tous les codes, triés. Sert au cliquet d'exhaustivité et aux épreuves. */
export const TOUS_LES_CODES_DE_COQUILLE = Object.freeze(
  Object.values(CODES_REFUS_COQUILLE).slice().sort(),
);

/**
 * Le code qu'un GESTIONNAIRE D'ERREUR a le droit de poster : le sien s'il appartient à l'ensemble
 * CLOS du § 10.5, `VAULT_COQUILLE_GESTE_ROMPU` sinon.
 *
 * Il existe parce qu'un refus se construit souvent depuis `erreur.code`, et qu'une erreur de la
 * plate-forme porte AUSSI un `code` — une `DOMException` d'`atob` porte `5`. `messageDeRefus` jette
 * sur un code inconnu, et un jet DANS un chemin de refus est le seul silence qui ne se voit pas : la
 * revue de sécurité de la PR #203 (constat 3) l'a mesuré, corrélation restée sans réponse comprise.
 *
 * @param {unknown} code
 * @returns {string}
 */
export function codeDeRefusAdmis(code) {
  return typeof code === "string" && Object.hasOwn(MESSAGES, code)
    ? code
    : CODES_REFUS_COQUILLE.gesteRompu;
}

/** @param {string} code */
export function messageDeRefus(code) {
  const message = MESSAGES[code];
  if (!message) throw new Error(`Code de refus de coquille inconnu : ${code}.`);
  return message;
}
