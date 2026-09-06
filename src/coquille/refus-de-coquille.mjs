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

  // --- Ce qui ne doit jamais franchir le port restreint ---------------------------------------
  /** Une réponse qui transporterait un handle, une clé ou une capacité transférable. */
  capaciteDansUnMessage: "VAULT_COQUILLE_CAPACITE_DANS_UN_MESSAGE",
});

/** Les messages en français, un par code. Ils décrivent le REFUS, jamais l'état de l'appareil. */
const MESSAGES = Object.freeze({
  [CODES_REFUS_COQUILLE.messageMalforme]: "Message illisible : la coquille attend un objet typé.",
  [CODES_REFUS_COQUILLE.contratRefuse]: "Contrat inconnu : cette coquille ne parle pas ce dialecte.",
  [CODES_REFUS_COQUILLE.typeInconnu]: "Requête hors de la liste d'admission de la coquille.",
  [CODES_REFUS_COQUILLE.kek]: "La clé de déverrouillage ne quitte jamais la coquille.",
  [CODES_REFUS_COQUILLE.dek]: "La clé de volume ne quitte jamais le Worker de confiance.",
  [CODES_REFUS_COQUILLE.exportation]: "L'export est un geste de l'utilisateur, pas de l'application.",
  [CODES_REFUS_COQUILLE.revocation]: "La révocation est un geste de l'utilisateur, pas de l'application.",
  [CODES_REFUS_COQUILLE.emplacement]:
    "Ajouter un emplacement de déverrouillage est un geste de l'utilisateur.",
  [CODES_REFUS_COQUILLE.recuperation]:
    "Créer un moyen de récupération est un geste de l'utilisateur.",
  [CODES_REFUS_COQUILLE.volume]: "L'application ne choisit pas le volume qu'elle habite.",
  [CODES_REFUS_COQUILLE.enveloppe]: "Le fichier d'enveloppes et son inventaire ne sont pas lisibles ici.",
  [CODES_REFUS_COQUILLE.portPrivilegie]:
    "Le canal privilégié coquille ↔ Worker n'est atteignable par aucun message.",
  [CODES_REFUS_COQUILLE.handle]: "Aucun handle, descripteur ou capacité ne franchit le port restreint.",
  [CODES_REFUS_COQUILLE.canalAbsent]:
    "Annonce refusée : le canal privilégié n'est pas établi ; aucun port n'est octroyé avant lui.",
  [CODES_REFUS_COQUILLE.annonceType]: "Annonce refusée : type inattendu.",
  [CODES_REFUS_COQUILLE.annonceOrigine]: "Annonce refusée : origine inattendue.",
  [CODES_REFUS_COQUILLE.annonceFenetre]: "Annonce refusée : fenêtre émettrice inattendue.",
  [CODES_REFUS_COQUILLE.annonceUnique]: "Annonce refusée : le port restreint a déjà été transféré.",
  [CODES_REFUS_COQUILLE.capaciteDansUnMessage]:
    "Réponse retenue : elle transportait autre chose que des données.",
});

/** Tous les codes, triés. Sert au cliquet d'exhaustivité et aux épreuves. */
export const TOUS_LES_CODES_DE_COQUILLE = Object.freeze(
  Object.values(CODES_REFUS_COQUILLE).slice().sort(),
);

/** @param {string} code */
export function messageDeRefus(code) {
  const message = MESSAGES[code];
  if (!message) throw new Error(`Code de refus de coquille inconnu : ${code}.`);
  return message;
}
