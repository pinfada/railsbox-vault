# syntax=docker/dockerfile:1
#
# Guest i386 de l'image de référence : rootfs bootable et disque applicatif.
#
# Contexte de construction attendu : la racine du dépôt.
#   docker build --platform linux/386 -f tools/build-reference-image/guest.Dockerfile \
#     --target rootfs .
#
# Trois étages, trois rôles :
#
#   outils      Debian i386 + chaîne de compilation + Ruby compilé depuis les
#               sources. Jamais publié tel quel : il sert de base au disque
#               applicatif, dont les gemmes natives doivent être compilées pour
#               i386 par le MÊME Ruby que celui qui les exécutera.
#   rootfs      le disque hda. Noyau, initrd, bibliothèques d'exécution, Ruby
#               repris de `outils`, scripts du guest. Aucune chaîne de
#               compilation : elle pèse plus de 400 Mio et ne sert à rien après
#               la construction.
#   disque-app  le disque hdb. Arbre de l'application, bundle compilé, base
#               SQLite migrée et invariant déjà créé — l'invariant existe donc
#               AVANT le premier boot, ce qui est la condition d'une preuve de
#               persistance après boot à froid.
#
# Aucun secret n'est requis nulle part : ni `ARG`, ni `ENV`, ni fichier monté.
# `verify-pinning.mjs` le vérifie, et la construction échoue sinon.

########################################################################
# Étage `outils` : Ruby compilé, chaîne de compilation complète.
########################################################################
FROM i386/debian:bookworm-slim@sha256:72b77a38b741753a64ebd7ff26c200d5eb5119f8b385409c5aaaa1aee12e9045 AS outils

# Personnalité 32 bits pour toute la construction. Docker ne la pose pas sur une
# image linux/386 : `uname -m` y renvoie « x86_64 », celui du noyau hôte, alors
# que le userland est bien en 32 bits. Les autoconf s'y trompent et Ruby se
# compile en ELF32 correct mais s'étiquette `x86_64-linux-x32`, un triplet qui
# n'existe pas ; RubyGems raisonne ensuite sur une plateforme fantôme.
# `linux32` appelle personality(PER_LINUX32) et rend le triplet i686.
# Constat repris de RailsBox Live (MIT), tools/build-v86-image/base/Dockerfile
# au commit a36baf0bcbdec65ca3749ba1fb6d7b94e4abd594.
SHELL ["linux32", "/bin/sh", "-c"]

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential pkg-config patch \
      libyaml-dev zlib1g-dev libssl-dev libffi-dev libgmp-dev libreadline-dev \
      libsqlite3-dev libxml2-dev libxslt1-dev bison \
      curl ca-certificates; \
    rm -rf /var/lib/apt/lists/*

# Ruby exact, depuis les sources : les dépôts bookworm i386 ne fournissent que
# 3.1, et une archive vérifiée par empreinte est plus reproductible qu'un paquet
# dont la version bouge avec les mises à jour du miroir.
ARG RUBY_VERSION=3.3.12
ARG RUBY_URL=https://cache.ruby-lang.org/pub/ruby/3.3/ruby-3.3.12.tar.gz
ARG RUBY_SHA256=b06d63beae271933033e27f0a389bc582a009e7845357d44365c39de525a051b
RUN set -eu; \
    curl -fsSL "$RUBY_URL" -o /tmp/ruby.tar.gz; \
    echo "$RUBY_SHA256  /tmp/ruby.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/ruby.tar.gz -C /tmp; \
    cd "/tmp/ruby-${RUBY_VERSION}"; \
    ./configure --disable-install-doc --enable-shared; \
    make -j"$(nproc)"; \
    make install; \
    cd /; rm -rf /tmp/ruby*; \
    test "$(ruby -e 'print RUBY_VERSION')" = "$RUBY_VERSION"

# nokogiri contre les bibliothèques du système : la compilation de son libxml2
# embarqué échoue sous i386 (constat de RailsBox Live, même commit).
ENV NOKOGIRI_USE_SYSTEM_LIBRARIES=true

########################################################################
# Étage `rootfs` : le disque hda, sans chaîne de compilation.
########################################################################
FROM i386/debian:bookworm-slim@sha256:72b77a38b741753a64ebd7ff26c200d5eb5119f8b385409c5aaaa1aee12e9045 AS rootfs

SHELL ["linux32", "/bin/sh", "-c"]
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

# Noyau bootable directement par v86 (bzImage + initrd, sans amorceur), les
# bibliothèques d'exécution des gemmes natives, iproute2 pour lever la boucle
# locale — sans elle Puma n'a pas de 127.0.0.1 — et python3 pour le pont série.
#
# `python3` et non `python3-minimal` : le paquet minimal n'embarque ni `json`,
# ni `http.client`, ni `threading`. Le pont y meurt à l'import, et comme il est
# le processus 1, sa mort devient une panique du noyau — observé le 2026-08-23,
# diagnostic invisible sans la boucle de garde de `guest-init.sh`. L'écart de
# taille (~15 Mio) est le prix d'un guest qui démarre.
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      linux-image-686 initramfs-tools \
      libsqlite3-0 libxml2 libxslt1.1 zlib1g libyaml-0-2 \
      libssl3 libffi8 libgmp10 libreadline8 \
      python3 iproute2 procps; \
    rm -rf /var/lib/apt/lists/*; \
    update-initramfs -u -k all

# Les modules du noyau pèsent 188 Mio sur un rootfs que chaque visiteur
# télécharge, et ne servent à rien après le boot : l'initrd embarque ceux dont
# il a besoin pour monter la racine, et le guest ne charge aucun module ensuite
# — pas d'udev, pas de réseau, pas de périphérique à découvrir. `/boot` est
# conservé : le fabricant de systèmes de fichiers y prend le noyau et l'initrd
# avant de créer l'image, et ne pourrait plus les atteindre après.
RUN set -eu; \
    test -s /boot/initrd.img-*; \
    rm -rf /usr/lib/modules /lib/modules

# Ruby et Bundler, repris de l'étage de compilation.
COPY --from=outils /usr/local /usr/local
RUN ldconfig && test "$(ruby -e 'print RUBY_VERSION')" = "3.3.12"

COPY tools/build-reference-image/guest/guest-init.sh /opt/vault/guest-init.sh
COPY tools/build-reference-image/guest/start-app.sh /opt/vault/start-app.sh
COPY tools/build-reference-image/guest/serial-bridge.py /opt/vault/serial-bridge.py

# Environnement du guest. Aucune clé, aucun jeton, aucun mot de passe : la
# clé de signature de Rails est dérivée d'une chaîne publique documentée
# (config/application.rb), et `SECRET_KEY_BASE` n'est PAS posée ici pour que la
# valeur synthétique reste la valeur effective et reste traçable.
RUN set -eu; \
    chmod +x /opt/vault/guest-init.sh /opt/vault/start-app.sh; \
    mkdir -p /app /var/log; \
    { \
      echo 'export RAILS_ENV=production'; \
      echo 'export RACK_ENV=production'; \
      echo 'export BUNDLE_GEMFILE=/app/Gemfile'; \
      echo 'export BUNDLE_PATH=/app/vendor/bundle'; \
      echo 'export BUNDLE_FROZEN=true'; \
      echo 'export BUNDLE_FORCE_RUBY_PLATFORM=true'; \
      echo 'export VAULT_DATABASE_PATH=/app/var/db/vault.sqlite3'; \
      echo 'export VAULT_STORAGE_ROOT=/app/var/storage'; \
      echo 'export LOG_LEVEL=info'; \
      echo 'export PORT=3000'; \
      echo 'export TZ=UTC'; \
      echo 'export WEB_CONCURRENCY=0'; \
      echo 'export RAILS_MAX_THREADS=2'; \
    } > /opt/vault/env.sh

########################################################################
# Étage `disque-app` : le disque hdb, invariant déjà en place.
########################################################################
FROM outils AS disque-app

ENV RAILS_ENV=production \
    RACK_ENV=production \
    BUNDLE_GEMFILE=/app/Gemfile \
    BUNDLE_PATH=/app/vendor/bundle \
    BUNDLE_FROZEN=true \
    BUNDLE_FORCE_RUBY_PLATFORM=true \
    VAULT_DATABASE_PATH=/app/var/db/vault.sqlite3 \
    VAULT_STORAGE_ROOT=/app/var/storage \
    PORT=3000 \
    TZ=UTC

WORKDIR /app

# Couche de gemmes séparée du reste de l'application : elle n'est reconstruite
# que si le verrou change, ce qui économise la compilation de nokogiri et de
# sqlite3 à chaque itération sur le code Rails.
COPY apps/reference/Gemfile apps/reference/Gemfile.lock ./
RUN linux32 bundle install && linux32 bundle clean --force

COPY apps/reference/ ./

# La base est migrée et l'invariant créé ICI, à la construction. Le `verify` qui
# suit est la preuve que le disque publié porte bien l'invariant attendu : si le
# digest de la pièce jointe ne correspond pas, la construction échoue, et rien
# n'est publié.
RUN set -eu; \
    mkdir -p var/db var/storage tmp/pids log; \
    linux32 ruby bin/rails db:migrate; \
    linux32 ruby bin/vault-fixture create; \
    linux32 ruby bin/vault-fixture create; \
    linux32 ruby bin/vault-fixture verify --json > /app/var/invariant-a-la-construction.json; \
    rm -rf tmp/cache log/*.log
