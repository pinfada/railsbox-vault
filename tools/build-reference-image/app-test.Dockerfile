# syntax=docker/dockerfile:1
#
# Image d'exécution de la suite Minitest de l'application de référence.
#
# Elle ne sert PAS à construire le guest : l'architecture y est amd64, pas i386,
# pour que la boucle de développement et la CI restent en minutes plutôt qu'en
# dizaines de minutes. Ce qu'elle garantit est la version exacte de Ruby et le
# `Gemfile.lock` gelé ; ce qu'elle ne garantit pas est le comportement des gemmes
# natives sous i386, que seul le test VM peut prouver. La limite est écrite dans
# `docs/testing.md`.
FROM ruby:3.3.12-slim-bookworm@sha256:41120b37f3a8147ae5dbca5020b5be4dafaa8ffa589ee539d184dad0ba0b5ae5

ENV DEBIAN_FRONTEND=noninteractive \
    BUNDLE_PATH=/bundle \
    BUNDLE_FROZEN=true \
    BUNDLE_FORCE_RUBY_PLATFORM=true \
    NOKOGIRI_USE_SYSTEM_LIBRARIES=true \
    LANG=C.UTF-8

# `BUNDLE_FORCE_RUBY_PLATFORM=true` interdit les gemmes précompilées : tout ce
# qui est natif est compilé ici, comme dans le guest i386. Les en-têtes système
# sont donc requises — les mêmes que celles du rootfs (voir sources.json).
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential pkg-config \
      libyaml-dev zlib1g-dev libsqlite3-dev libxml2-dev libxslt1-dev; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /application

# Couche de gemmes séparée : elle n'est reconstruite que si le verrou change.
COPY Gemfile Gemfile.lock ./
RUN bundle install && bundle clean --force

CMD ["bundle", "exec", "ruby", "bin/rails", "test"]
