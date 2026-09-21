# Diagnostic de reprise de l’issue #246

Constat du 21 septembre 2026, run `run_20260921_00000_770780ea7b1e4565be0874adb44a9617`, base
`71ed3f457bad3397bf422c95f6a19bc01dcf324f`.

## Décision : implémentation bloquée

Le texte et les commentaires de [#246](https://github.com/pinfada/railsbox-vault/issues/246) ne sont
pas accessibles dans cette session.
`gh issue view 246 --repo pinfada/railsbox-vault --json title,body,state,comments` échoue faute de
`GH_TOKEN` ; une lecture HTTP par `Invoke-RestMethod` échoue, et
`curl.exe -L --max-time 20 https://api.github.com/repos/pinfada/railsbox-vault/issues/246` retourne
le code 7 (connexion impossible au proxy 127.0.0.1).

La recherche `rg -n '#246|issues/246' docs src tests` ne trouve que la mention « lot B — #246 » dans
[la feuille de route](roadmap.md). Les anciens comptes rendus consultés ne contiennent pas davantage
le contrat de l’issue.

La [Definition of Ready](../CONTRIBUTING.md) reste donc **non vérifiable** : résultat, critères
automatisables, dépendances et leur état, commande de preuve, risques et décisions d’architecture
sont inconnus. Cela ne démontre pas que l’issue elle-même est mal préparée. Aucune implémentation ni
preuve TDD n’est revendiquée.

Condition de reprise : fournir le corps et les commentaires de #246, ainsi que les contrats et états
de ses dépendances, ou rétablir leur lecture GitHub. Le mainteneur ou l’opérateur du lanceur peut
fournir ces éléments. Aucun correctif produit ne peut être déduit du seul numéro d’issue.

## Preuves des runs antérieurs

Sources lues sans modification : `manifest.json` et `events.jsonl`, sous `../../runs/<identifiant>/`
relativement à ce worktree.

### Run `run_20260921_00000_996b7043fe8a4481989c22b070942fb3`

Les quatre événements sont `created`, `base_resolved`, `aborted`, `finished`. À
`2026-09-21T21:30:13.8306932Z`, l’abandon porte `System.Management.Automation.RuntimeException`.
Aucun événement `command`, `worktree_created` ou validation ; zéro tentative et zéro jeton.

Il s’agit d’un arrêt du lancement, pas d’un échec de test observé. La cause exacte de l’exception
manque dans ces traces. `git worktree list` confirme que la branche `agent/railsbox-vault/246` est
déjà attachée au worktree `bb5549…` : un conflit lors de sa réutilisation est plausible, mais aucune
sortie de commande ne le prouve.

### Run `run_20260921_00000_bb5549f64ae24b8e9cc82470af381973`

Contrairement au champ final `validation: null`, les événements contiennent trois
`validation_failed`, avec sorties des commandes. À chaque tentative, installation npm et
installation des navigateurs sortent à 0 ; `npm.ps1 run check` sort à 1.

| Heure UTC de fin de commande | Résultat navigateur               | Échecs observés                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19:57:06                     | 440 réussis, 53 ignorés, 1 échec  | Firefox, `coquille-service-applicatif.spec.mjs:62` : `sondes-terminees` attendu, `demarrage` reçu après 60 s.                                                                                                                 |
| 20:07:46                     | 438 réussis, 53 ignorés, 3 échecs | Chromium, `coquille-cycle-de-vie.spec.mjs:383` : navigation `ERR_ABORTED` ; `coquille-installation-interrompue.spec.mjs:286` : bouton introuvable ; `coquille-premier-clic.spec.mjs:217` : bouton actif au lieu de désactivé. |
| 20:17:42                     | 440 réussis, 53 ignorés, 1 échec  | Chromium, `coquille-deverrouillage.spec.mjs:324` : `locator.textContent: Target crashed`.                                                                                                                                     |

Ces sorties prouvent des échecs de validation ; elles ne suffisent pas à attribuer une cause produit
commune, une contradiction de spécification ou un problème de charge. Le premier passage concerne
`71ed3f4`, les suivants `a7b271b`. Un événement `rollback` conserve la référence
`refs/pilotage/audit/run_20260921_00000_bb5549f64ae24b8e9cc82470af381973`. Aucun de ces travaux n’a
été modifié ici.

## Validation déjà fournie pour le run courant

L’événement `validation_failed` du 21 septembre à 21:44:12 UTC indique :

| Commande                                                     | Code | Durée     |
| ------------------------------------------------------------ | ---- | --------- |
| `npm.ps1 ci --ignore-scripts --no-audit --no-fund`           | 0    | 4,043 s   |
| `npm.ps1 exec -- playwright install chromium firefox webkit` | 0    | 80,112 s  |
| `npm.ps1 run check`                                          | 1    | 535,911 s |

Unitaires : 2 173 réussis, zéro échec, un ignoré. Navigateurs : 439 réussis, 53 ignorés, deux échecs
:

- `coquille-frontiere.spec.mjs:257`, Chromium : pour `contrat-etranger`,
  `VAULT_COQUILLE_CONTRAT_REFUSE` attendu, `VAULT_COQUILLE_CAPACITE_DANS_UN_MESSAGE` reçu.
- `coquille-deux-coffres.spec.mjs:121`, Firefox : délai global de 120 s dépassé.

Ces résultats proviennent du lanceur, pas d’une nouvelle exécution pendant ce diagnostic. La chaîne
`check` s’arrête aux tests navigateur ; les étapes suivantes ne sont donc pas prouvées. Aucun test
n’a été modifié, neutralisé ou relancé sans contrat d’issue. Le seul ajout de cette intervention est
ce rapport ; le répertoire non suivi `%SystemDrive%/`, présent à l’arrivée, reste intact.
