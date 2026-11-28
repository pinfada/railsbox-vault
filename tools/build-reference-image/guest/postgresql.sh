#!/bin/sh
# Cycle de vie du cluster PostgreSQL d'un coffre (#343, ADR 0056). Le MÊME script sert aux deux
# bouts de la chaîne, ce qui garantit que le cluster démarré dans le guest est celui que la
# fabrication du paquet a préparé :
#
#   à la fabrication (guest.Dockerfile, étage disque-app) :
#     sh postgresql.sh preparer    initdb AVEC sommes de contrôle, démarrage, rôle et base
#     sh postgresql.sh verifier    les réglages relus par SHOW sur la connexion de l'application
#     sh postgresql.sh arreter     arrêt `fast` : checkpoint écrit, datadir cohérent dans la graine
#   au boot du guest (guest-init.sh), APRÈS le montage du disque de données :
#     sh postgresql.sh demarrer    reprise sur crash si la session précédente a été coupée
#     sh postgresql.sh verifier    refus en clair si un réglage est affaibli
#   partout :
#     sh postgresql.sh url         le DATABASE_URL que l'outil fournit à Rails
#
# Repris de RailsBox (pinfada/railsbox, tools/build-v86-image/base/rib/postgres.sh) : le datadir
# sur le disque de données (/app/var/pg, la graine puis le volume du coffre), le lancement sous
# l'utilisateur `postgres` par `su`, le répertoire de sockets recréé sur /run, l'arrêt `fast` à la
# construction. DURCI : la configuration vient du rootfs (`config_file`) et non du datadir, les trois
# réglages de durabilité sont redits en ligne de commande — ils l'emportent ainsi sur un
# `postgresql.auto.conf` —, initdb pose les sommes de contrôle, le rôle de l'application n'est pas
# superutilisateur, et le serveur n'écoute sur aucun port TCP.
#
# Chaque ligne dite sur la série commence par `[postgresql]` : c'est ce que les épreuves relèvent.
set -eu

PG_VERSION=15
PG_BIN="/usr/lib/postgresql/${PG_VERSION}/bin"
PGDATA=/app/var/pg
SOCKETS=/run/postgresql
CONFIGURATION=/opt/vault/postgresql.conf
JOURNAL=/var/log/postgresql.log
ROLE=vault
BASE=vault
# `localhost` n'est là que pour la syntaxe : Ruby refuse une autorité sans hôte (`vault@/`), et le
# paramètre `host` — un répertoire, donc le socket — l'emporte, pour libpq comme pour Active Record.
URL="postgresql://${ROLE}@localhost/${BASE}?host=${SOCKETS}"
# Les réglages de durabilité, redits au serveur : la ligne de commande l'emporte sur tout fichier.
DURABILITE="-c fsync=on -c synchronous_commit=on -c full_page_writes=on"
# Une reprise sur crash sous émulation peut être longue : la borne est large, mais elle existe.
DELAI_DEMARRAGE_S=900

dire() {
  echo "[postgresql] $*"
}

refuser() {
  dire "REFUS $*"
  if [ -s "$JOURNAL" ]; then tail -n 20 "$JOURNAL" | sed 's/^/[postgresql] journal : /'; fi
  exit 3
}

# Le serveur refuse de tourner en root, et l'init du guest est root.
en_postgres() {
  su -s /bin/sh postgres -c "$1"
}

repertoire_des_sockets() {
  mkdir -p "$SOCKETS"
  chown postgres:postgres "$SOCKETS"
  chmod 2775 "$SOCKETS"
  touch "$JOURNAL"
  chown postgres:postgres "$JOURNAL"
}

lancer() {
  en_postgres "$PG_BIN/pg_ctl --pgdata=$PGDATA --log=$JOURNAL --wait --timeout=$DELAI_DEMARRAGE_S \
    -o '-c config_file=$CONFIGURATION $DURABILITE' start" > /dev/null ||
    refuser "demarrage-echoue : le serveur n'a pas demarre, voir les dernieres lignes de son journal"
}

# À la FABRICATION seulement : le cluster naît dans la graine, migré ensuite par Rails.
preparer() {
  [ ! -e "$PGDATA" ] || refuser "cluster-deja-present $PGDATA"
  repertoire_des_sockets
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  # --data-checksums : une page corrompue est DÉTECTÉE à la lecture au lieu d'être rendue.
  # --auth-local=trust : seul le socket du guest mène au serveur, et le guest n'a pas de réseau.
  en_postgres "$PG_BIN/initdb --pgdata=$PGDATA --data-checksums --encoding=UTF8 --locale=C.UTF-8 \
    --username=postgres --auth-local=trust --auth-host=reject" > /dev/null
  lancer
  # Le rôle de l'application peut créer SA base (`db:create`) et ses extensions de confiance, mais
  # n'est pas superutilisateur : il ne peut ni `ALTER SYSTEM`, ni changer fsync.
  en_postgres "$PG_BIN/psql -X -q -h $SOCKETS -U postgres -d postgres \
    -c 'CREATE ROLE $ROLE LOGIN CREATEDB' -c 'CREATE DATABASE $BASE OWNER $ROLE'"
  dire "cluster prepare dans $PGDATA (sommes de controle, role $ROLE, base $BASE)"
}

# Au BOOT : le datadir arrive avec le volume du coffre ; il n'est jamais recréé ici.
demarrer() {
  [ -f "$PGDATA/PG_VERSION" ] ||
    refuser "cluster-absent : le paquet attend PostgreSQL, et le disque de donnees n'a pas de cluster dans $PGDATA"
  version=$(cat "$PGDATA/PG_VERSION")
  [ "$version" = "$PG_VERSION" ] ||
    refuser "version-du-cluster : cluster $version, serveur $PG_VERSION — une montee de version n'est pas prise en charge"
  [ "$(stat -c %U "$PGDATA")" = postgres ] ||
    refuser "proprietaire : $PGDATA n'appartient pas a l'utilisateur postgres du guest"
  repertoire_des_sockets
  # Aucun serveur ne peut tourner à cet instant : l'init vient de monter le disque. Un verrou laissé
  # par la session précédente dit seulement qu'elle a été COUPÉE — c'est le cas normal d'un coffre
  # verrouillé —, et le serveur fera sa reprise sur crash. Sous un guest qui redémarre à l'identique,
  # le PID inscrit peut désigner un autre processus vivant : le serveur refuserait alors de partir.
  if [ -f "$PGDATA/postmaster.pid" ]; then
    rm -f "$PGDATA/postmaster.pid"
    dire "session precedente coupee : reprise sur crash"
  fi
  debut=$(date +%s%N)
  lancer
  fin=$(date +%s%N)
  rss=$(ps -o rss= -C postgres 2> /dev/null | awk '{ s += $1 } END { print s + 0 }')
  dire "pret en $(((fin - debut) / 1000000)) ms, rss=${rss} Kio"
}

# Les réglages APPLIQUÉS, relus par SHOW sur la connexion de l'application : même rôle, même base,
# donc mêmes ALTER ROLE … SET et ALTER DATABASE … SET que Rails.
verifier() {
  lus=""
  for reglage in fsync synchronous_commit full_page_writes wal_sync_method data_checksums \
    ignore_checksum_failure zero_damaged_pages; do
    valeur=$("$PG_BIN/psql" -X -A -t -d "$URL" -c "SHOW $reglage" 2> /dev/null) ||
      refuser "connexion-impossible : la connexion de l'application ($URL) a echoue"
    lus="$lus $reglage=$valeur"
  done
  dire "reglages$lus"
  ecarts=""
  for attendu in fsync=on synchronous_commit=on full_page_writes=on data_checksums=on \
    ignore_checksum_failure=off zero_damaged_pages=off; do
    case " $lus " in
      *" $attendu "*) ;;
      *) ecarts="$ecarts $attendu" ;;
    esac
  done
  case " $lus " in
    *" wal_sync_method=fdatasync "* | *" wal_sync_method=fsync "* | \
      *" wal_sync_method=open_datasync "* | *" wal_sync_method=open_sync "*) ;;
    *) ecarts="$ecarts wal_sync_method=fdatasync" ;;
  esac
  [ -z "$ecarts" ] || refuser "reglages-affaiblis attendus :$ecarts"
  dire "reglages conformes"
}

arreter() {
  en_postgres "$PG_BIN/pg_ctl --pgdata=$PGDATA --mode=fast --wait stop" > /dev/null
  dire "cluster arrete proprement"
}

case "${1:-}" in
  preparer) preparer ;;
  demarrer) demarrer ;;
  verifier) verifier ;;
  arreter) arreter ;;
  url) printf '%s\n' "$URL" ;;
  *)
    echo "usage : sh postgresql.sh preparer|demarrer|verifier|arreter|url" >&2
    exit 2
    ;;
esac
