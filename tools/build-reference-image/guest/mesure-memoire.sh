#!/bin/sh
# Relevé de MÉMOIRE du guest, pour les mesures E6 de #343 (ADR 0056). INERTE par défaut : l'init ne
# le lance que si la ligne de commande du noyau porte `vault.mesure-memoire=1`, ce que seul un
# harnais de mesure pose (`tools/vm/mesurer-postgresql.mjs`). Il ne fait que LIRE /proc, et il écrit
# dans le journal de Puma, que le pont série relaie : écrire sur ttyS0 corromprait ses trames.
#
# Une ligne toutes les cinq secondes :
#
#   [mesure] memoire t=<s> guest_utilise=<Kio> postgres_rss=<Kio> postgres_pss=<Kio> rails_pss=<Kio>
#
# `rss` additionne les pages résidentes de chaque processus : la mémoire partagée de PostgreSQL
# (`shared_buffers`) y est comptée une fois PAR processus. `pss` la répartit entre eux : c'est la
# part réelle. `guest_utilise` est MemTotal - MemAvailable, tout le guest compris (cache exclu).
set -u

# Un processus est reconnu par sa LIGNE DE COMMANDE (`ps -o args`), précédée d'une espace : Puma
# renomme la sienne (« puma 8.1.3 (tcp://…) »), et les processus du serveur s'appellent
# « postgres: checkpointer », « postgres: walwriter »…
POSTGRES='^ (postgres|/usr/lib/postgresql/)'
RAILS='^ (puma|ruby|bundle)'

# $1 : motif de la ligne de commande ; $2 : champ de smaps_rollup (Rss ou Pss).
somme() {
  total=0
  for pid in $(ps -eo pid=,args= | awk -v motif="$1" '{ pid = $1; $1 = ""; if ($0 ~ motif) print pid }'); do
    valeur=$(awk -v champ="$2:" '$1 == champ { print $2 }' "/proc/$pid/smaps_rollup" 2> /dev/null)
    total=$((total + ${valeur:-0}))
  done
  echo "$total"
}

while true; do
  total=$(awk '$1 == "MemTotal:" { print $2 }' /proc/meminfo)
  disponible=$(awk '$1 == "MemAvailable:" { print $2 }' /proc/meminfo)
  echo "[mesure] memoire t=$(cut -d ' ' -f 1 /proc/uptime) guest_utilise=$((total - disponible))" \
    "postgres_rss=$(somme "$POSTGRES" Rss) postgres_pss=$(somme "$POSTGRES" Pss)" \
    "rails_pss=$(somme "$RAILS" Pss)" >> /var/log/puma.log
  sleep 5
done
