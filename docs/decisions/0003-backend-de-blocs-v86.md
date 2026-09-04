# ADR 0003 — Le backend de blocs v86 est un adaptateur, et la barrière de durabilité un pont posé à l'exécution

- Statut : accepté
- Date : 2026-08-23
- Issue : #4 · Invariant : `SEC-DURABLE-001` · Jalon 0

## Contexte

`docs/architecture.md` exige d'un backend de stockage une lecture exacte, une écriture dont
l'incomplétude est détectée, une barrière dont l'acquittement vaut durabilité, une géométrie stable,
une fermeture exclusive et une injection d'erreurs déterministe. `SECURITY.md` en tire
`SEC-DURABLE-001` : « aucune écriture n'est annoncée durable avant le flush effectif ».

Ces exigences n'ont de sens que si l'émulateur les relaie. Le spike #4 devait donc établir, sur une
version épinglée de v86, ce que le contrat de tampon disque de l'émulateur permet réellement — et
choisir entre adaptateur, contribution amont, fork borné ou pivot.

Le contexte disponible avant l'expérience : v86 accepte un tampon disque personnalisé, mais
`src/ide.js` traite ATA FLUSH CACHE sans jamais appeler ce tampon.

## Ce que l'expérience a établi

Protocole, commandes et mesures brutes :
[`docs/spikes/0004-backend-de-blocs-v86.md`](../spikes/0004-backend-de-blocs-v86.md). Les faits qui
portent la décision :

1. **Le point d'extension est public et suffisant.** `src/browser/starter.js` accepte tel quel tout
   objet portant `get`, `set` et `load` comme `hda`. Aucun patch n'est nécessaire pour brancher un
   backend : un vrai noyau Linux i386 monte le volume et y écrit.

2. **La rupture de durabilité est plus profonde qu'annoncé.** Elle n'est pas seulement dans le
   traitement de FLUSH CACHE : le paquet IDENTIFY de v86 n'arme pas le bit « write cache » (mot 82
   bit 5, recopié en mot 85). Le guest classe donc `sda` en `write through` et **n'émet aucune
   commande FLUSH CACHE**, pas même sur `sync` ou `fsync`. Mesuré : 177 commandes ATA sur le
   protocole complet, dont zéro `0xE7` et zéro `0xEA`. Corriger `ata_command` seul n'aurait rien
   changé — le correctif n'aurait jamais été atteint.

3. **Les deux corrections tiennent en six lignes utiles de `src/ide.js`**, et ces lignes sont du
   JavaScript : le cœur WebAssembly n'est pas concerné. Diff complet :
   `vendor/v86/patches/0001-flush-cache-vers-le-buffer.patch`, 17 lignes ajoutées, 6 retirées.

4. **La même correction s'obtient à l'exécution.** Les artefacts publiés de `v86@0.5.432` sont
   compilés par Closure en niveau `SIMPLE` : les noms de propriétés sont conservés et le prototype
   de `IDEInterface` reste greffable. Le pont
   [`src/vm/v86-flush-bridge.mjs`](../../src/vm/v86-flush-bridge.mjs) réplique le correctif sans
   fork ni chaîne de compilation. Mesuré : le guest passe en `write back`, émet ses FLUSH CACHE, et
   huit barrières traversent le backend dans l'ordre écriture → `flush` → acquittement.

5. **`get` et `set` n'ont aucun canal d'erreur.** Leurs callbacks n'expriment que le succès. Un
   backend en panne ne peut donc ni rendre des zéros — ce serait une donnée valide pour le guest —
   ni acquitter. Il ne reste que : ne pas acquitter, remonter l'erreur typée au runtime, et laisser
   le guest atteindre son délai de garde ATA. Cette conduite est mesurée dans le spike, elle n'est
   pas confortable, et elle est la seule qui ne mente pas.

6. **Deux contraintes d'environnement, découvertes en exécutant v86 dans un Worker de la coquille.**
   `script-src 'self'` refuse `WebAssembly.instantiate` sous Chromium ; et v86, faute de trouver
   `use-scheduling-api` dans l'URL de son contexte, crée un Worker imbriqué depuis une URL `blob:`
   que `worker-src 'self'` refuse — l'émulateur ne bat alors jamais, sans erreur visible côté page.

7. **L'isolation cross-origin n'est pas nécessaire.** Le guest démarre et écrit avec
   `crossOriginIsolated` à `false`, donc sans `SharedArrayBuffer`. L'écart d'héritage d'isolation
   relevé par le spike #35 ne bloque pas #4.

## Options comparées

| Option                    | Disponible quand        | Chaîne de compilation exigée             | Coût de mise à jour de v86        | Retenue           |
| ------------------------- | ----------------------- | ---------------------------------------- | --------------------------------- | ----------------- |
| Adaptateur seul           | immédiatement           | aucune                                   | nul                               | non               |
| Adaptateur + pont exécuté | immédiatement           | aucune                                   | rejouer `test:vm` à chaque montée | **oui**           |
| Contribution amont        | après acceptation amont | aucune pour nous                         | nul une fois fusionnée            | oui, en parallèle |
| Fork borné                | après mise en place     | Java + Closure v20210601 épinglé, `make` | rebaser le fork à chaque montée   | non               |
| Pivot hors v86            | plusieurs semaines      | inconnue                                 | inconnue                          | non               |

**Adaptateur seul** est écarté par le fait 2 : sans pont, `SEC-DURABLE-001` est structurellement
inatteignable, puisque le guest n'émet aucune barrière. Un backend parfait derrière un émulateur qui
ne lui transmet jamais `fsync` n'apporte aucune durabilité.

**Le fork borné** est écarté par le fait 4 : il coûterait strictement plus cher pour un résultat
identique. Le correctif ne touche que du JavaScript, donc reconstruire le cœur Rust
(`rustup target add wasm32-unknown-unknown`, `clang`, `make`) serait évitable — mais reconstruire
`libv86.mjs` exige tout de même Java et le jar Closure Compiler `v20210601`, que l'amont épingle
explicitement à cette version. Cela ajoute une dépendance JVM à la CI, un artefact non publié à
vérifier, et une branche à rebaser à chaque montée de version. Le pont à l'exécution obtient le même
comportement pour un fichier de 110 lignes couvert par des tests unitaires.

**Le pivot** est écarté sans prototype : aucun autre émulateur x86 en WebAssembly ne présente à la
fois la maturité de v86 et un point d'extension disque public. La question sera rouverte si les
conditions d'abandon ci-dessous se réalisent, pas avant.

## Décision

**Le stockage de la VM est un adaptateur vers le contrat de tampon de v86, complété par un pont de
durabilité posé à l'exécution sur le prototype de `IDEInterface`. Les artefacts v86 restent ceux du
paquet publié `v86@0.5.432`, épinglés par empreinte. Aucun fork n'est maintenu.**

Le correctif équivalent est versionné comme diff amont et sera proposé à copy/v86. Son acceptation
supprimerait le pont ; son refus ne changerait rien à l'architecture.

Conséquences immédiates :

- `vendor/v86/MANIFEST.json` fixe nom, taille, empreinte SHA-256, licence et URL de chaque artefact.
  `npm run vm:fetch` les récupère, `npm run vm:check` échoue si l'un diffère. Aucun binaire n'est
  versionné, aucune copie n'est reprise de RailsBox Live.
- La CSP de la coquille gagne `'wasm-unsafe-eval'` dans `script-src`. C'est le jeton le plus étroit
  qui autorise WebAssembly : il n'ouvre ni `eval` ni `new Function`, contrairement à
  `'unsafe-eval'`. La CSP publiée par l'ADR 0002 est amendée d'autant, et seulement d'autant.
- Le Worker runtime est chargé avec `?use-scheduling-api`, ce qui fait choisir `scheduler.postTask`
  à v86 plutôt qu'un Worker imbriqué `blob:`. `worker-src` reste `'self'`. Le Worker vérifie la
  condition au démarrage et échoue explicitement si elle manque.
- Les codes d'erreur de `src/vm/storage-errors.mjs` sont la première série stable proposée à #6.
- La preuve `intégration VM` existe (`npm run test:vm`) avec son témoin négatif ; elle reste
  périodique tant que les artefacts dépendent d'hôtes tiers (voir `docs/testing.md`).

## Ce que la décision ne fige pas

- la géométrie et le format du volume, réservés à #6 ;
- le backend OPFS de production : ce spike ne livre qu'un backend mémoire, qui déclare
  `durable: false` dans son descripteur ;
- la politique du runtime face à une erreur fatale du support — arrêt, verrouillage, message à la
  coquille — dont seule la remontée typée est ici établie ;
- l'image de guest : `linux4.iso` est un outil de mesure, pas la fixture produit de #5 ;
- les instantanés mémoire, refusés explicitement par l'adaptateur (`get_state`, `set_state`,
  `get_buffer` lèvent `VAULT_STORAGE_UNSUPPORTED`).

> **Amendement de l'[ADR 0024](0024-instantane-de-reprise.md) (#65, 4 septembre 2026).** La dernière
> ligne ci-dessus est amendée : `get_state` et `set_state` ne lèvent plus, ils portent la LIAISON du
> volume — identité, séquence, génération — et seulement pendant la quiescence, hors de laquelle ils
> refusent toujours. `get_buffer` reste refusé pour la raison inchangée : un volume Vault ne se
> recopie pas en un `ArrayBuffer` unique.

## Coût de mise à jour de v86

Monter de version demande : mettre à jour les cinq entrées de `MANIFEST.json`, exécuter
`npm run vm:fetch` puis `npm run test:vm`. Le pont est le point le plus fragile — il dépend de trois
noms conservés par la compilation Closure `SIMPLE` (`ata_command`, `create_identify_packet`,
`push_irq`) et de la structure `devices.ide.primary.master`. Une montée qui les renommerait ferait
échouer l'installation du pont **bruyamment** : `installDurabilityBridge` refuse un contrôleur dont
`primary.master` est absent, et le témoin négatif de `test:vm` échouerait en sens inverse. Le coût
n'est donc pas un risque de dégradation silencieuse, mais une tâche d'adaptation visible.

**Un quatrième nom s'y est ajouté depuis #52 : `tick_counter`**, dont dépend le chien de garde du
premier tour de boucle (`src/vm/runtime-environment.mjs`). Il ne se comporte PAS comme les trois
autres : son renommage ne casse rien bruyamment, il rend seulement le chien de garde aveugle. C'est
pourquoi l'aveuglement est lui-même consigné — `VAULT_RUNTIME_TICKS_UNREADABLE` apparaît alors dans
`observationsRuntime` du compte rendu — plutôt que de faire échouer un émulateur sain. Une montée de
version doit donc **vérifier ce champ**, en plus de rejouer `npm run test:vm` : un compte rendu qui
le porte annonce un instrument perdu, pas une panne.

## Risques résiduels

1. **Le pont modifie un prototype partagé.** Il ne s'applique qu'aux interfaces dont le tampon est
   l'adaptateur Vault, il refuse une double installation et il se retire — mais deux VM dans le même
   Worker restent une configuration non éprouvée.
2. **Un délai de garde ATA de plusieurs dizaines de secondes** est ce que le guest observe quand
   `get` ou `set` échoue. Tant que le canal d'erreur manque, une panne de support se paie en temps
   d'attente du guest. #14 devra décider si le runtime arrête la VM sans attendre.
3. **Une faute transitoire est absorbée par les tentatives du noyau.** Le guest peut rendre un
   succès là où le backend a signalé une erreur : seul le runtime sait. Toute décision de
   verrouillage doit donc se prendre côté runtime, jamais sur le retour du guest.
4. **`i.copy.sh` n'est pas un hébergeur que le projet maîtrise** et ne publie pas d'empreinte. Notre
   empreinte protège de l'altération, pas de la disparition. Miroir à prévoir avec #5.
5. **`scheduler.postTask` est absent de WebKit** (mesuré : `undefined` en page comme en Worker sous
   WebKit 26.5, présent sous Chromium 151 et Firefox 153). Sur un moteur sans cette API, v86 exige
   `worker-src blob:` dans la CSP de la coquille. La matrice #2 devra en tenir compte avant
   d'annoncer Safari.
6. **Le backend mémoire ne prouve pas la durabilité**, seulement l'ordre. La preuve de durabilité
   réelle appartient à #6 et à `FileSystemSyncAccessHandle`.

## Conditions d'abandon

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- une montée de v86 rend le pont impossible à poser sans reconstruire l'émulateur ;
- l'amont accepte le correctif — le pont devient alors du code mort à retirer ;
- une mesure sur `FileSystemSyncAccessHandle` montre que le contrat `get`/`set` de v86 rend la
  latence d'écriture inacceptable au regard des budgets de `docs/quality-attributes.md` ;
- un moteur obligatoire de la matrice #2 refuse `'wasm-unsafe-eval'` ou impose `worker-src blob:`.

## Alternatives rejetées

- **Rendre des zéros sur erreur de lecture** : convertit une panne de support en donnée valide pour
  le guest. Interdit par `docs/architecture.md`.
- **Acquitter l'écriture avant que le backend confirme** : c'est déjà ce que fait le chemin PIO de
  v86 en interne ; le reproduire côté backend supprimerait la seule barrière que nous ayons.
- **Émuler la durabilité par un `flush` implicite après chaque écriture** : coûteux, et faux — la
  durabilité serait promise là où le guest ne l'a pas demandée, et non promise là où il l'attend.
- **Patcher le fichier `libv86.mjs` téléchargé** : un correctif textuel sur un artefact compilé est
  exactement la « copie silencieuse » que `docs/architecture.md` refuse, et il casserait la
  vérification d'empreinte.
- **Exempter `/vm/` de la CSP de la coquille**, comme l'est la sonde de capacités : la sonde mesure
  ce qu'un moteur sait faire, le runtime est le produit. Le runtime doit vivre sous la politique
  réelle de la coquille, quitte à ce que cette politique nomme WebAssembly.
