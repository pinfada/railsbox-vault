# ADR 0053 — Le téléchargement anticipé du premier démarrage : les étapes 1 à 3 remplissent le magasin

- Statut : proposé
- Date : 2026-11-28
- Issue : [#348](https://github.com/pinfada/railsbox-vault/issues/348) · lot
  `lot:parcours-critiques`
- **Complète** l'[ADR 0044](0044-le-magasin-d-artefacts.md) (le magasin a désormais deux écrivains,
  coordonnés par un verrou) et l'[ADR 0040](0040-le-parcours-est-un-ordre-pas-une-decision.md)
  (l'ordre du parcours décide aussi quand télécharger). **Amende** la décision du #242 (point 4) :
  la phase « téléchargement » n'est plus montrée sous le nom de « préparation ».
- Ne touche pas : le format du magasin, la vérification au service, la rétention, le descripteur
  scellé ([ADR 0046](0046-le-descripteur-scelle-et-le-demarrage-hors-connexion.md)), les refus du
  stockage ([ADR 0006](0006-conduite-refus-persistance.md),
  [ADR 0047](0047-un-rejet-transitoire-du-stockage-n-est-pas-une-absence.md)).

## Contexte

L'acquisition des artefacts du boot — wasm, BIOS, VGA BIOS, noyau, initrd, rootfs, paquet ; environ
207 Mio servis, environ 38 s de « préparation » relevées par le banc mémoire de
`docs/mesures/2026-10-lot-d-reference.md` — partait au clic sur « Démarrer l'application », à
l'étape 4 : `demarrerLApplication` → `demarrerLaVm` → `booterLePaquet` → `bootEtVerifier` →
`preparerLeBoot` → `acquerirRuntime` → `loadRuntime`. Rien ne la lançait plus tôt : le Service
Worker de la réserve ne précharge pas les artefacts de VM (`PASSAGE_NOMME`, ADR 0048), et le magasin
n'était rempli que par le boot. Pendant les étapes 1 à 3, la personne choisit sa phrase et recopie
son code : ce temps était perdu.

## Décision

1. **Quand.** La page lance le téléchargement anticipé une fois la progression du parcours lue, si
   l'étape atteinte est 1, 2 ou 3 (`telechargementAnticipeVoulu`). Jamais en vue complète (le
   harnais des épreuves de frontière), jamais sous Firefox, où l'application ne démarre pas dans
   cette version (`LIMITE_DE_FIREFOX`) : 200 Mio y seraient téléchargés pour rien. Il part derrière
   le portail de la réserve, comme le Worker de confiance.
2. **Où.** Dans un Worker DÉDIÉ, `public/coquille/prechargement-worker.mjs`, qui ne reçoit aucun
   message, ne détient aucun port, aucune clé, aucun handle de volume, et meurt après son bilan. Pas
   dans le Worker de confiance, qui sert les gestes du coffre, ni dans la page, dont le fil porte la
   saisie : hacher et décompresser 200 Mio prendrait l'un ou l'autre.
3. **Quoi.** Le Worker lit le descripteur PUBLIC de l'origine (`lireLeDescripteur`, sans repli), en
   déduit les adresses (`adressesDuRuntime`), et range au magasin, artefact par artefact, ce qui n'y
   est pas (`magasin.contient`). Chaque artefact passe par le chemin du boot : `acquerirUnPetit`
   (épingle, taille, empreinte) ou `servirOuTelecharger` (empreinte en flux, racine des tranches).
   Rien d'autre n'est écrit : ni coffre, ni volume, ni secret. Le paquet est celui du descripteur
   servi, la graine n'est pas préchargée (elle se verse chiffrée dans le volume ; environ 0,5 Mio).
4. **Ce qu'il ne fait jamais.** Il ne demande aucun octet au réseau sans magasin, quand le stockage
   ne répond pas, quand la place manque pour TOUT ranger (`peutAdmettre(total)`, avec la marge du
   volume de l'ADR 0006), ni quand tout est déjà là. Hors connexion, ou sans descripteur, il
   s'arrête. L'étape 4 fait alors exactement ce qu'elle faisait avant.
5. **L'étape 4 ne croit rien.** Elle relit le descripteur, puis SERT du magasin, en revérifiant, ce
   que le téléchargement anticipé a rangé : c'est le chemin de l'ADR 0044, inchangé. Un descripteur
   qui aurait changé entre-temps nomme d'autres empreintes : le magasin ne les a pas, et l'étape 4
   les télécharge.
6. **Un verrou, deux comportements** (`src/vm/verrou-des-artefacts.mjs`, Web Locks,
   `vault-artefacts-acquisition`). Le téléchargement anticipé ne le prend que s'il est libre
   (`ifAvailable`) : un autre onglet qui télécharge ou démarre le fait renoncer (`occupe`). Le boot
   l'attend, dit qu'il télécharge pendant l'attente, puis sert ce qui vient d'être rangé. Son
   attente est bornée à cinq minutes (`ATTENTE_MAX_DU_VERROU_MS`) : au-delà, il acquiert sans le
   verrou, comme avant. Le verrou évite un travail double ; il ne protège rien de ce qui est
   vérifié. Sans `navigator.locks`, les deux gestes s'exécutent sans lui.
7. **La reprise.** Un artefact n'est rangé qu'entier (le `.partiel` est renommé en dernier). Une
   préparation interrompue — onglet fermé, rechargement de l'étape 3 — laisse au magasin ce qui est
   fini ; la page suivante ne demande que le reste. L'artefact en cours recommence depuis le début.
8. **L'attente distingue trois phases.** `preparation` ouvre tout démarrage ; `telechargement` n'est
   posée que si des octets viennent réellement du réseau (ou si le boot attend le verrou) ;
   `demarrage` suit l'acquisition. La page les dit telles quelles, et l'étape du démarrage dit
   pourquoi elle est longue : « Cela prend du temps, car un ordinateur complet démarre dans votre
   navigateur. » Le #242 (point 4) montrait « préparation » à la place de « téléchargement » parce
   que la phase ne savait pas si le magasin servait ; elle le sait désormais.

## Conséquences

- Le premier démarrage, l'acquisition faite pendant les étapes 1 à 3, ne paie plus au clic que la
  relecture vérifiée du magasin. Les durées annoncées (« environ deux minutes ») ne changent pas :
  aucune mesure du parcours complet avec l'image n'a été refaite par cette tranche.
- Une personne qui ouvre la page et part tout de suite a téléchargé jusqu'à 207 Mio. C'est le prix
  de la décision 1, déjà annoncé par la limite « Un gros téléchargement » de l'écran d'entrée.
- Pendant les étapes 1 à 3, le Worker du téléchargement anticipé tient en mémoire un artefact à la
  fois — le rootfs, 385 Mio décompressés, au plus fort — puis le relâche. Il n'existe plus à l'étape
  4 s'il a fini.
- La page publie `telechargementAnticipe` dans son relevé : une issue et des statuts du magasin,
  jamais un octet ni une adresse.

## Limites écrites

- La dérivation Argon2id de l'étape 2 et le hachage du téléchargement anticipé tournent en même
  temps, dans deux Workers. Sur un appareil à un ou deux cœurs, la durée annoncée de la création n'a
  pas été remesurée avec ce travail en fond.
- Deux onglets sur une ancienne version sans verrou restent possibles pendant une mise à jour de la
  coquille : le magasin les supporte (ADR 0044, amendement D1g), au prix d'un téléchargement de
  plus.
- La borne de cinq minutes n'est pas mesurée : elle dépasse les 207 Mio à 10 Mbit/s (environ 170 s).
