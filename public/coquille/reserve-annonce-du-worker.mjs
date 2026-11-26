// La POIGNÉE DE MAIN de séquence du Worker de confiance (#299, ADR 0048 § 6) : il annonce LA séquence de
// publication qu'il exécute, que la page compare à la sienne AVANT tout secret ; différente, le Worker est
// terminé (`VAULT_COQUILLE_RESERVE_DIVERGENTE`). L'invariant : page, contrôleur et Worker de confiance sont
// de la même séquence de publication.
//
// Ce module est le DERNIER import de `runtime-worker.mjs`, et ce n'est pas un détail d'ordre : l'annonce ne
// part qu'une fois le graphe de modules du Worker chargé ET évalué. Un graphe refusé (entrée altérée,
// manquante) ne s'évalue jamais, donc n'annonce rien — la page le constate par son silence et nomme la
// cause par une re-vérification, jamais par l'événement `error`, que Firefox n'émet pas.
//
// Il ne porte ni clé ni donnée du volume : un type et un nombre. `null` : le dépôt vivant, sans réserve.

import { RESERVE_PUBLIEE } from "./reserve-publiee.mjs";

self.postMessage({ type: "reserve-sequence", sequence: RESERVE_PUBLIEE?.sequence ?? null });
