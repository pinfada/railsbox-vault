# Triage des issues — 17 septembre 2026

Périmètre : les **26 issues ouvertes** de `pinfada/railsbox-vault`, relues depuis GitHub. La
priorité ci-dessous distingue les incidents reproductibles des chantiers de qualification. Aucune
issue n'est fermée par ce document ; les corrections doivent encore être revues et intégrées.

## Corrections de cette tranche

| Issue                                                        | Priorité et constat                                                                                                               | Correction                                                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#215](https://github.com/pinfada/railsbox-vault/issues/215) | P1 : un deuxième démarrage peut faire déclarer mort un Worker occupé par le premier                                               | Bouton désactivé pendant le geste, appels concurrents refusés sans remplacer le rapport initial ; le Worker refuse les nouveaux gestes longs **à leur arrivée**, avant la file, avec `VAULT_COQUILLE_GESTE_EN_COURS`. |
| [#222](https://github.com/pinfada/railsbox-vault/issues/222) | P1 qualification : la recette exige une queue non validée que son déclencheur ne garantit pas                                     | Lecture non destructive du journal **après coupure et avant récupération** ; comparaison exacte du rejeu et des octets écartés avec ce constat. Aucun retry ajouté, aucune modification du récupérateur.              |
| [#220](https://github.com/pinfada/railsbox-vault/issues/220) | P2 préventif : l'API générique choisit implicitement un secret si un type apparaît plusieurs fois ; aucun appel de produit actuel | Refus `VAULT_ENVELOPPE_EMPLACEMENT_AMBIGU` avant dérivation/écriture ; chaque emplacement reste ouvrable avec son identifiant. Le premier type servable reste préféré ; pas de repli silencieux en cas d'ambiguïté.   |

### Preuves locales

- Suite complète `npm run test:unit` : **1 928 tests réussis**, zéro échec ou test ignoré. Lint,
  format et `git diff --check` conformes. La suite navigateur complète n'a pas été rejouée : cette
  tranche a exécuté les deux scénarios Chrome ciblés décrits ci-dessous.
- `vm-derivation-branchement.test.mjs` : refus avant dérivation, enveloppe inchangée, deux choix
  explicites utilisables, identifiant inconnu refusé. Campagne
  `muter-gardes-archive-recuperation.mjs` : **30/30 mutants détectés**, dont la suppression du
  nouveau refus.
- `coquille-portabilite.test.mjs`, `coquille-portabilite-du-worker.test.mjs` et
  `coquille-verrouillage.test.mjs` : arrivée concurrente refusée, état initial préservé, bouton
  rétabli après succès ou échec. Chrome : double clic avec un Worker instrumenté répondant après 40
  s, sans faux décès, fermeture toujours atteignable.
- `vm-generation-store.test.mjs` : queue nulle **et** non nulle confrontées au vrai récupérateur ;
  journal absent ou tronqué refusé par le constat.
- Chrome **152.0.7977.83**, Windows : scénario E2E de coupure puis boot à froid Rails réussi en
  **3,9 min**. Journal observé : génération 5, sept enregistrements validés, **28 822 octets** non
  validés ; récupération : sept enregistrements rejoués, exactement **28 822 octets** écartés,
  invariant Rails et empreinte de pièce jointe conformes. Les deux rapports Playwright sont dans
  `reports/issues-critiques/resultats-{e2e,browser}.json` (artefacts locaux ignorés par Git).

Cette exécution E2E a rencontré une queue **positive** ; le cas zéro est imposé par le test
unitaire, pas prétendu observé dans ce run. Le constat lit des racines non encore authentifiées : il
ne donne aucune autorisation d'ouverture. Le boot suivant authentifie les données. Une mort de
Worker ne simule ni une coupure électrique ni la perte des caches système.

## Suites prioritaires et limites

| Issues                                                                                                                                                                                   | Analyse et prochaine action                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#210](https://github.com/pinfada/railsbox-vault/issues/210)                                                                                                                             | Priorité données avant toute ouverture aux applications tierces : définir et éprouver la durabilité hors SQLite/ActiveStorage. La preuve Rails actuelle ne garantit pas les écritures d'une application qui n'émet pas de barrière. Chantier distinct, non corrigé ici. |
| [#218](https://github.com/pinfada/railsbox-vault/issues/218)                                                                                                                             | Offrir une révocation ciblée d'une feuille perdue. Le geste actuel retire aussi les autres moyens : ne pas remplacer arbitrairement cette politique sans sélection explicite et tests conservant la passkey.                                                            |
| [#179](https://github.com/pinfada/railsbox-vault/issues/179)                                                                                                                             | Corréler les réponses de la fixture hostile au lieu du FIFO ; une réponse tardive peut fausser une preuve de sécurité. À traiter avant d'étendre ces sondes.                                                                                                            |
| [#223](https://github.com/pinfada/railsbox-vault/issues/223), [#176](https://github.com/pinfada/railsbox-vault/issues/176)                                                               | Parcours et confiance : mémoriser la révocation achevée, expliquer cookies/OPFS, puis définir une présence utilisateur que le cadre ne puisse pas forger. Aucun effacement automatique ni heartbeat du cadre accepté comme preuve de présence.                          |
| [#197](https://github.com/pinfada/railsbox-vault/issues/197), [#165](https://github.com/pinfada/railsbox-vault/issues/165), [#217](https://github.com/pinfada/railsbox-vault/issues/217) | Compléter l'E2E de reprise d'installation ; reproduire l'ancien arrêt initramfs avec sa trace ; isoler les intermittents WebKit. Ne pas confondre un scénario voisin vert avec la résolution de ces incidents.                                                          |
| [#212](https://github.com/pinfada/railsbox-vault/issues/212)                                                                                                                             | Reproductibilité de l'image : deux constructions indépendantes doivent donner les mêmes octets, après maîtrise des UUID, graines et dates. Non démontré par un boot réussi.                                                                                             |
| [#126](https://github.com/pinfada/railsbox-vault/issues/126), [#125](https://github.com/pinfada/railsbox-vault/issues/125), [#124](https://github.com/pinfada/railsbox-vault/issues/124) | Qualification des effets de Permissions-Policy et du cache, puis sonde sur l'hébergeur réel. Les seuls en-têtes servis ne suffisent pas ; un déploiement externe reste hors de cette tranche.                                                                           |
| [#40](https://github.com/pinfada/railsbox-vault/issues/40), [#67](https://github.com/pinfada/railsbox-vault/issues/67)                                                                   | Vrai Safari macOS et mémoire du processus navigateur : mesures dédiées ; WebKit Playwright sous Windows n'est pas Safari.                                                                                                                                               |
| [#151](https://github.com/pinfada/railsbox-vault/issues/151), [#76](https://github.com/pinfada/railsbox-vault/issues/76)                                                                 | Intégrité d'un futur cache SW de la coquille et spike COOP/COEP conditionnel : ne pas les assimiler à des mécanismes déjà livrés.                                                                                                                                       |
| [#191](https://github.com/pinfada/railsbox-vault/issues/191)                                                                                                                             | Découper le Worker améliore sa lisibilité ; priorité inférieure aux défauts d'exécution, extraction séparée pour garder la revue ciblée.                                                                                                                                |
| [#195](https://github.com/pinfada/railsbox-vault/issues/195), [#31](https://github.com/pinfada/railsbox-vault/issues/31)                                                                 | Épiques de viabilité et feuille de route : nécessitent notamment une validation humaine, pas seulement une suite automatisée verte.                                                                                                                                     |
| [#26](https://github.com/pinfada/railsbox-vault/issues/26), [#27](https://github.com/pinfada/railsbox-vault/issues/27), [#28](https://github.com/pinfada/railsbox-vault/issues/28)       | Futurs échanges E2EE/API métier/démonstrateur : pas des corrections urgentes du coffre local.                                                                                                                                                                           |

### Issue probablement périmée

[#172](https://github.com/pinfada/railsbox-vault/issues/172) est annoncée comme absorbée par
[#182](https://github.com/pinfada/railsbox-vault/issues/182), fermée le 11 septembre. La hiérarchie
actuelle (`src/vm/derivation/hierarchie-de-volume.mjs`, ADR 0033) dérive les clés par volume et
domaine. Les tests `vm-hierarchie-de-cles.test.mjs` et `vm-budget-par-domaine.test.mjs` mesurent la
séparation et les invocations réelles. Recommandation : rattacher la preuve v4 et faire confirmer la
clôture, sans prétendre que les anciens formats ont été automatiquement migrés.

La PR #224 ouverte sur la chaîne d'approvisionnement constitue un travail distinct ; cette tranche
n'en modifie ni les dépendances ni les contrôles.
