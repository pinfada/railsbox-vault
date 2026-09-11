# ADR 0037 — Reprendre une installation interrompue : un bouton, une signature, un seul geste

- **Statut** : accepté
- **Date** : 2026-09-12
- **Issue** : [#173](https://github.com/pinfada/railsbox-vault/issues/173)
- **Complète** : [ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md) (décision 1, le refus
  `VAULT_COQUILLE_VOLUME_APPLICATIF_SANS_MANIFESTE`, laissé ouvert),
  [ADR 0020](0020-enveloppe-de-cle.md) (décision 1, le retrait d'un volume avec ses voisins),
  [ADR 0034](0034-archive-authentifiee-et-racine-initiale.md) (la racine initiale de création),
  [ADR 0028](0028-coquille-de-produit-et-frontiere.md) (le contrat strict de messages).
- **Ne traite pas** : un chemin de maintenance pour un volume anonyme qui N'EST PAS une installation
  interrompue — c'est une issue à ouvrir, pas une tranche à improviser (voir « Conséquences »).

## Contexte

Depuis #163 (ADR 0030), un volume applicatif dont le fichier existe mais dont le manifeste n'est
jamais inscrit est refusé, jamais écrasé : c'est soit l'installation interrompue d'un précédent
essai, soit autre chose, et l'ADR 0030 avait délibérément laissé cette question ouverte — « ce qu'il
faudra pour l'identifier ou le réparer est une question ouverte ».

Ce qui distingue les deux cas ne se devine pas : il se MESURE. En rejouant une interruption sur le
double déterministe (`tests/unit/vm-dater-la-creation.test.mjs`), deux faits contredisent
l'hypothèse de départ — « le journal de génération serait absent ou vide » :

1. le journal n'est JAMAIS absent pendant l'installation : `openOpfsVolume` l'écrit dès l'ouverture
   du volume, avant tout versement de disque ;
2. ce qui distingue une installation en cours n'est pas la présence du journal, c'est son CONTENU :
   séquence 0, génération 0, une seule racine — celle de naissance, aucune charge en attente. Cet
   état survit au versement entier et à la datation, et ne se referme que si le volume est ENSUITE
   rouvert pour un usage normal.

## Décision

**La SIGNATURE d'une installation interrompue** (`signatureDInstallationInterrompue`,
`src/coquille/application-de-reference.mjs`) est l'ensemble des TROIS conditions suivantes, et les
trois ensemble :

1. aucun manifeste n'est jamais inscrit (précondition du refus qui déclenche le constat) ;
2. le volume est de la taille EXACTE que le descripteur d'application annonce ;
3. le journal de génération ne porte QUE la racine de naissance (`constaterCreationSeule`,
   `src/vm/opfs-datation-de-creation.mjs`) — lu sans être ouvert en écriture, jamais tronqué pour
   décider.

Manquer l'une des trois rend « autre chose » : le refus reste tel quel, et aucun geste n'est
proposé.

**Le geste « Reprendre l'installation »** est un BOUTON de la coquille, jamais automatique — sur le
modèle du bouton « Rouvrir le coffre » de #171 (ADR 0031/0030). Il retire le volume orphelin et SES
SEULS voisins (`removeOpfsVolume`, ADR 0020 décision 1 : journal de génération, témoin de séquence,
enveloppe de clé, instantané), puis réinstalle par le chemin ordinaire de #163
(`installerSiNecessaire`).

Il exige un type de message NEUF sur le canal PRIVILÉGIÉ, sous le contrat strict de l'ADR 0028 :
`vault.coquille.reprendre-installation` / `vault.coquille.reprendre-installation-reponse`
(`TYPES_PRIVILEGIES.reprendreInstallation` / `.reprendreInstallationReponse`). **Aucun type sur le
port restreint** : le document applicatif n'a et n'aura jamais connaissance de ce geste.

**Le Worker REVÉRIFIE la signature lui-même**, sous sa propre exclusivité, juste avant d'agir
(`reprendreSiSignatureConfirmee`, `src/coquille/reprise-installation.mjs`) : un clic n'est pas une
preuve que rien n'a changé depuis que le bouton a été montré. Deux refus SANS aucun retrait —
manifeste désormais présent, signature qui ne tient plus — précèdent le seul chemin qui exécute.

## Ce que ce geste détruit, et pourquoi il ne peut pas détruire autre chose

Il détruit le volume applicatif ANONYME et ses voisins nommés ci-dessus. Il ne touche : ni le coffre
(`coquille`, un nom distinct), ni son enveloppe (`coquille.cles` n'est le voisin d'aucun nom que ce
geste retire), ni un AUTRE volume (`removeOpfsVolume` retire par nom, et `NOM_DU_VOLUME_APPLICATIF`
en est un seul, fixe). Le retrait ne s'exécute qu'après la revérification décrite ci-dessus, jamais
sur la seule foi du bouton affiché.

## Conséquences

- `VAULT_COQUILLE_VOLUME_APPLICATIF_SANS_MANIFESTE` reste inchangé dans son code et son message ; il
  porte désormais la signature dans son CONTEXTE (`installationInterrompue`, `motifDeLaSignature`),
  jamais dans le message rendu à l'utilisateur, qui nomme ce qui a été trouvé (taille, voisins
  présents, manifeste absent).
- Un volume « autre chose » (signature absente) continue de recevoir le refus SEUL, sans bouton,
  sans retrait : un chemin de maintenance pour ce cas reste une issue à ouvrir, pas une tranche à
  improviser.
- **§ 10.5 de `docs/format-de-volume-v3.md` n'est PAS modifiée** : elle documente exhaustivement les
  refus du PORT RESTREINT au document applicatif, et ce geste ne touche jamais ce port (« aucun type
  sur le port restreint », ci-dessus). Les deux types neufs vivent sur le canal PRIVILÉGIÉ,
  documentés dans `TYPES_PRIVILEGIES` (`contrat-de-messages.mjs`) et cette ADR — c'est la même règle
  que les autres gestes du canal privilégié (`application`, `fermeture`…), qui n'ont pas non plus de
  ligne dans cette table.
- Les dix refus existants de la coquille (§ 10.5) restent inchangés ; l'épreuve qui les rejoue reste
  verte sans modification.
- `tests/unit/coquille-deverrouillage.test.mjs` porte le cliquet d'exhaustivité des TYPES du canal
  privilégié (demande ↔ réponse appariable) : les deux types neufs y sont inscrits, dans les deux
  listes que l'épreuve confronte l'une à l'autre.
