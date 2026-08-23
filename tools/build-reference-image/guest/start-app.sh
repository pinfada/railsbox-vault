#!/bin/sh
# Lanceur de l'application de référence. Appelé par l'init, jamais directement.
set -eu

. /opt/vault/env.sh

cd /app
# Puma exige tmp/pids ; ActiveStorage et SQLite exigent leurs répertoires. Ils
# sont créés par la construction du disque, mais un disque reconstruit à la main
# ne doit pas échouer pour un répertoire manquant.
mkdir -p tmp/pids log var/db var/storage

exec bundle exec puma config.ru -b "tcp://127.0.0.1:${PORT}"
