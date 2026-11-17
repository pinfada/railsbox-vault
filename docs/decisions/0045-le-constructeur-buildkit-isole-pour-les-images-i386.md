# ADR 0045 — Un constructeur BuildKit isolé pour les images i386 quand Docker 29.4.2 prive les processus 32 bits de sockets

- Statut : accepté
- Date : 2026-11-17
- Issue : #295 · Lot CI-0

## Contexte

Depuis le 29/10/2026, `ubuntu-latest` est ubuntu-26.04 : Docker 29.4.2, libseccomp 2.6.0. Le profil
seccomp par défaut de Docker y est resserré (moby#52494, CVE-2026-31431, sockets `AF_ALG`) et le
constructeur intégré renvoie `ENOSYS` à `socket` pour les binaires i386. Dans l'étage i386 de
`guest.Dockerfile`, la glibc ne peut plus ouvrir de socket : `apt-get update` dit « Temporary
failure resolving 'deb.debian.org' », ce qui ressemble à un défaut de DNS et n'en est pas un.
L'étage amd64 n'est pas touché. Les preuves (CI, mêmes commandes sur 24.04 et 26.04) sont dans
l'issue #295.

Trois constats ferment les pistes évidentes : `--dns`, `--network host` n'y changent rien ;
`--security-opt seccomp=unconfined` répare un `docker run` ; un `seccomp-profile` posé dans
`daemon.json` ne s'applique pas aux étapes `RUN`, que BuildKit exécute sous son propre profil.

## Décision

`tools/docker-constructeur.mjs` **sonde** le constructeur par défaut (un `RUN` i386 qui crée une
socket, sans réseau). Il le garde s'il convient. Sinon il bascule sur un constructeur BuildKit
`docker-container` nommé `railsbox-vault-buildkit`, dont l'image est **épinglée par empreinte** dans
`sources.json` (`images.buildkit`), et sonde de nouveau. Si aucun ne convient, la construction
s'arrête avant les vingt minutes de compilation, avec la cause. `build-image.mjs` et
`fabriquer-paquet.mjs` passent par ce module ; leurs `docker build` ajoutent `--load`.

`guest.Dockerfile` ne change pas, donc ni le contenu de l'image ni les empreintes attendues par
`verify-pinning.mjs` : seul l'exécutant des étapes `RUN` change.

## Alternatives écartées

- **Épingler `runs-on: ubuntu-24.04`.** Ne corrige pas la cause, ne protège pas les postes de
  développement, et l'image 24.04 recevra Docker 29 à son tour.
- **`seccomp=unconfined` / `RUN --security=insecure`.** Retire toute la protection seccomp pour une
  seule syscall, et demande une entitlement BuildKit.
- **Remplacer `getent`/`apt` par un téléchargement 64 bits.** Réécrit la chaîne de construction et
  change ce que l'image contient.

## Conséquences et limites

- Le constructeur isolé exécute les `RUN` sous le profil de BuildKit, moins strict que celui de
  Docker 29.4.2. Un filtre seccomp ne lit pas les arguments de `socketcall` (en mémoire) : on ne
  peut donc pas autoriser les sockets 32 bits tout en bloquant `AF_ALG`. Acceptable ici : sources
  épinglées par empreinte, exécutant éphémère, aucun secret dans la construction. **À ne pas étendre
  à la construction de code non fiable.**
- La montée de version de BuildKit est manuelle (Dependabot ne lit pas `sources.json`).
- La sonde dépend du message de bash (« Function not implemented », « Operation not permitted »). Un
  changement de libellé ferait passer la sonde au vert à tort ; l'épreuve
  `tests/vm/sockets-i386.test.mjs` et l'étape « Sonde des sockets 32 bits » de `image-reference.yml`
  la rejouent, et la construction elle-même échouerait ensuite.
- Le cache de couches du constructeur isolé vit dans son conteneur, séparé de celui du démon.
