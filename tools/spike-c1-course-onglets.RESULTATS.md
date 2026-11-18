# Spike jetable — course entre onglets (#310, Révision 2) — 19/11/2026

Branche `spike/c1-course-onglets`, **sans PR, hors produit**. Chromium Headless Shell 151 (Playwright 1.62),
aarch64, deux Workers dédiés réels, OPFS réel. Commandes :
`node tools/spike-c1-course-onglets.mjs [--chrono] [--balayage]`.

Ce que le spike rejoue : la séquence de `deverrouiller` (`public/runtime-worker-deverrouillage.mjs:159-171,
203-215`) avec les **mêmes fonctions de bibliothèque** : `ouvrirEnveloppe(kek)` → [pause contrôlée] →
`openOpfsVolume(dek)`. Ce n'est **pas** le Worker de produit (dépendant de `interne` et du canal) ; la pause est le seul ajout.

| Expérience | Résultat |
|---|---|
| Contrôle 1 : A tient le volume et révoque la clé de B **avant** que B déverrouille | B refusé **à l'enveloppe** : `VAULT_ENVELOPPE_CLE_REFUSEE` (la révocation tient) |
| Contrôle 2 : A tient le volume, aucune révocation | B : enveloppe ouverte, volume `VAULT_STORAGE_BUSY` (le handle exclusif tient) |
| **Course contrôlée** : B ouvre l'enveloppe (DEK en main), pause ; A révoque la clé de B puis ferme ; B reprend | **B OUVRE LE VOLUME** et relit le secteur en clair. L'enveloppe refuse pourtant sa clé (`CLE_REFUSEE`) avant comme après ; B ne peut plus révoquer (`CLE_REFUSEE`) ; la clé de A ouvre toujours |
| Mesure (15 échantillons, sans contention) | `ouvrirEnveloppe` ≈ 2,5 ms ; **fenêtre enveloppe → volume ouvert ≈ 8,8 ms (max 10,3)** ; `revoquerToutSauf` ≈ 7 ms ; fermeture ≈ 0,3 ms |
| Balayage « naturel » (164 essais, B sans pause, révocation de A déclenchée de 0 à 120 ms après le départ de B) | **0/164 course** : 164 × `VAULT_STORAGE_BUSY` (B tente le handle bien avant que A ait fini). |

Lecture : **la course est possible** (démontrée avec une pause contrôlée), pas observée au naturel avec la séquence du produit non
retentée. Un B qui **retente** `openOpfsVolume` jusqu'à la libération (code de page ordinaire, même origine) la gagne à coup sûr.
Non mesuré : suspension réelle d'un onglet d'arrière-plan, Firefox, WebKit.
