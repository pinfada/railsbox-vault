# ADR 0045 — Les workflows de l'image et des épreuves VM restent sur ubuntu-24.04, à titre provisoire

- Statut : accepté, **provisoire**
- Date : 2026-11-18
- Issue : #295 · suite : #301 · Lot CI-0

## Contexte

Depuis le 29/10/2026, `ubuntu-latest` est ubuntu-26.04. Deux défauts y cassent les jobs qui
fabriquent l'image de référence ou lancent les épreuves VM. Les deux sont établis par exécution CI
(détail et liens de runs dans #295 et #301).

1. **Docker 29.4.2 donne `ENOSYS` à `socket` aux processus 32 bits des étapes `RUN`.** Le profil
   seccomp par défaut a été resserré (moby#52494, CVE-2026-31431). L'étage i386 de
   `guest.Dockerfile` ne résout plus `deb.debian.org` : `apt-get update` dit « Temporary failure
   resolving », ce qui ressemble à un défaut de DNS et n'en est pas un. `--dns`, `--network host`
   n'y changent rien ; `--security-opt seccomp=unconfined` répare un `docker run` ; un
   `seccomp-profile` de `daemon.json` ne s'applique pas aux `RUN`, que BuildKit exécute sous son
   propre profil. Le même `getent` réussit sur ubuntu-24.04 (Docker 28.0.4, libseccomp 2.5.5).
2. **Le WebKit de Playwright manque de `libicu74` et `libxml2.so.2` sur 26.04** : `tests/vm` sous
   WebKit échoue au lancement du navigateur.

## Décision

Les jobs de `image-reference.yml`, `mesure-reprise.yml`, `reprise.yml` et `vm.yml` sont épinglés sur
`ubuntu-24.04`, avec la raison écrite au-dessus du `runs-on`.
`tests/unit/workflows-image-sur-ubuntu-24-04.test.mjs` échoue si l'un d'eux revient à
`ubuntu-latest` ou perd la mention « PROVISOIRE (#295) ». Rien d'autre ne change : ni
`guest.Dockerfile`, ni l'outillage de construction, ni les empreintes attendues par
`verify-pinning.mjs` et le manifeste.

## Alternatives écartées ou reportées

- **Constructeur BuildKit isolé** (`docker-container`, image épinglée par empreinte) : prototype sur
  la branche `wip/ci-26-04-constructeur-isole`. La construction et `test:vm:reference` y sont verts
  sur 26.04, mais « Intégration VM » ne l'est pas (défaut 2) et les lots de « Reprise MVP » n'ont
  pas été exécutés sur 26.04. Non retenu tant qu'il n'est pas vert de bout en bout ; repris par
  #301.
- **`seccomp=unconfined` / `RUN --security=insecure`** : retire toute la protection seccomp pour une
  syscall, et demande une entitlement BuildKit.

## Conséquences et limites

- **Le retour à `ubuntu-latest` n'est pas fait.** La date de retrait d'ubuntu-24.04 par GitHub n'est
  pas annoncée au 18/11/2026 ; le jour où elle l'est, #301 devient urgente.
- L'image 24.04 recevra Docker ≥ 29 à son tour : l'épinglage protège du système d'exploitation, pas
  de la version de Docker installée dessus. La sonde du prototype (`tests/vm/sockets-i386.test.mjs`
  de la branche `wip/`) dirait la cause en dix secondes ; elle n'est pas livrée ici.
- Les empreintes de l'image de référence ne sont pas reproductibles au bit près d'une construction à
  l'autre (horodatages, ordre d'allocation ; voir #212) : aucune comparaison d'empreinte entre 24.04
  et 26.04 n'est revendiquée.
