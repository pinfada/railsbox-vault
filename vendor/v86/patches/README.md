# Correctifs amont proposés pour v86

`0001-flush-cache-vers-le-buffer.patch` s'applique à `src/ide.js` du dépôt
[copy/v86](https://github.com/copy/v86) au commit `847e34d5499b17b90d2783d5342ddd243c753497`.

```sh
git clone https://github.com/copy/v86
cd v86 && git checkout 847e34d5499b17b90d2783d5342ddd243c753497
git apply /chemin/vers/vendor/v86/patches/0001-flush-cache-vers-le-buffer.patch
```

Il corrige les deux ruptures mesurées par le spike #4 :

1. le paquet IDENTIFY n'annonce pas de cache d'écriture, si bien que Linux classe le disque en
   « write through » et n'émet jamais de FLUSH CACHE ;
2. `ata_command` acquitte FLUSH CACHE et FLUSH CACHE EXT sans jamais solliciter le tampon disque.

**Ce correctif n'est pas appliqué par RailsBox Vault.** Le dépôt consomme les artefacts publiés du
paquet `v86@0.5.432` et obtient le même comportement à l'exécution, sans fork ni chaîne de
compilation, par `src/vm/v86-flush-bridge.mjs`. Le correctif existe ici pour être proposé à l'amont
et pour montrer que la solution retenue reproduit fidèlement une modification de six lignes utiles.

Voir [`docs/decisions/0003-backend-de-blocs-v86.md`](../../../docs/decisions/0003-backend-de-blocs-v86.md).
