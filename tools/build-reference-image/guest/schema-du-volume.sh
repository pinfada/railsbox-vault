#!/bin/sh
# Le SCHÉMA des données, confronté au paquet AVANT Rails (#236 T2, ADR 0042).
#
# Appelé par l'init, après les montages et avant `start-app.sh`, de façon SYNCHRONE : Rails n'est
# lancé que si ce script rend 0. Il compare quatre grandeurs :
#
#   V  le marqueur des DONNÉES, /app/var/.vault-schema — il voyage avec le volume du coffre ;
#   P  le marqueur du PAQUET,   /app/db/.vault-schema  — il voyage avec le code ;
#   E  le schéma que le manifeste du coffre ATTEND, `vault.schema=` sur la ligne de commande du
#      noyau, posé par le Worker de confiance (absent pour un coffre qui ne le connaît pas) ;
#   I  l'INTENTION d'une migration commencée, /app/var/.vault-migration : le schéma VISÉ. Rails
#      commite migration par migration, et une coupure entre deux laisse la base à un schéma
#      INTERMÉDIAIRE que V ne dit pas (V n'avance qu'à la fin).
#
# et fait UNE chose :
#
#   V > P, ou P < I     REFUS anterieur : du vieux code sur des données récentes — ou peut-être
#                       intermédiaires —, jamais ;
#   E connu, V != E     REFUS divergent — SAUF si V = P : c'est une mise à jour ACHEVÉE dont le
#     et V != P         manifeste n'a pas encore suivi (coupure entre la barrière et son écriture) ;
#   P > V               I := P et `sync`, db:migrate, puis V := P, I retiré, `sync` — la barrière
#                       qui rend la nouvelle génération VALIDÉE avant que la ligne ne soit dite ;
#   sinon               rien : aucun second chargement de Rails.
#
# Chaque décision est dite sur la série, préfixée `[schema]` : c'est ce que le Worker relève
# (`src/vm/constat-de-schema.mjs`). La console du noyau est muette à ce stade ; ces lignes, elles,
# sont imprimées par l'init sur ttyS0 avant que le pont ne la prenne.
set -u

. /opt/vault/env.sh

marqueur_donnees=/app/var/.vault-schema
marqueur_paquet=/app/db/.vault-schema
marqueur_intention=/app/var/.vault-migration

lire() {
  if [ -s "$1" ]; then tr -cd '0-9' < "$1"; else printf 'absent'; fi
}

# Écrit un marqueur par RENOMMAGE, journalisé par ext4 : une coupure laisse l'ancien ou le nouveau,
# jamais un marqueur vide.
ecrire() {
  printf '%s\n' "$2" > "$1.neuf" && mv "$1.neuf" "$1"
}

V=$(lire "$marqueur_donnees")
P=$(lire "$marqueur_paquet")
I=$(lire "$marqueur_intention")
E=$(tr ' ' '\n' < /proc/cmdline | sed -n 's/^vault\.schema=\([0-9]\{1,32\}\)$/\1/p' | head -n 1)
[ -n "$E" ] || E=absent

echo "[schema] volume=$V paquet=$P attendu=$E intention=$I"

if [ "$P" = absent ]; then
  # Un paquet sans marqueur ne sait pas dire son schéma : rien n'est comparé, rien n'est migré.
  # C'est le cas d'une image d'avant T2 ; la décision de la coquille a déjà eu lieu.
  echo "[schema] migration aucune schema=absent"
  exit 0
fi
if [ "$V" = absent ]; then
  echo "[schema] REFUS divergent volume=absent paquet=$P attendu=$E"
  exit 3
fi

# Comparaison ENTIÈRE (les versions de migration d'ActiveRecord sont des entiers) : `-gt` de dash
# travaille sur 64 bits, et un horodatage de migration en tient 47.
if [ "$V" -gt "$P" ]; then
  echo "[schema] REFUS anterieur volume=$V paquet=$P"
  exit 3
fi
if [ "$I" != absent ] && [ "$P" -lt "$I" ]; then
  echo "[schema] REFUS anterieur volume=$V paquet=$P intention=$I"
  exit 3
fi
if [ "$E" != absent ] && [ "$V" != "$E" ] && [ "$V" != "$P" ]; then
  echo "[schema] REFUS divergent volume=$V paquet=$P attendu=$E"
  exit 3
fi
if [ "$P" -eq "$V" ]; then
  # Une intention restée là (coupure après le marqueur, avant son retrait) n'a plus d'objet.
  if [ "$I" != absent ]; then rm -f "$marqueur_intention" && sync; fi
  echo "[schema] migration aucune schema=$V"
  exit 0
fi

# L'INTENTION d'abord, rendue durable AVANT la première migration : `sync` pousse le fichier ET le
# répertoire à travers le journal d'ext4 et la barrière du disque (#209). Une coupure pendant les
# migrations laisse donc toujours I = P, et aucun paquet plus ancien ne rouvrira ces données.
ecrire "$marqueur_intention" "$P"
sync
debut=$(date +%s%N)
cd /app || exit 3
# Chaque ligne de Rails est redite sur la série, préfixée : « == <version> <Nom>: migrated » dit
# qu'une migration est COMMITÉE — c'est ce qu'une épreuve de coupure entre deux migrations guette.
# `dash` n'a pas `pipefail` : le code de Rails passe par un fichier.
{ bundle exec ruby bin/rails db:migrate 2>&1; echo $? > /run/vault-migration-code; } \
  | tee /var/log/migration.log | sed -u 's/^/[schema] rails : /'
code=$(cat /run/vault-migration-code 2>/dev/null || echo 1)
if [ "$code" -ne 0 ]; then
  echo "[schema] REFUS migration-echouee de=$V vers=$P code=$code"
  exit 3
fi
# Le marqueur passe à P, PUIS l'intention est retirée, PUIS `sync` : la barrière franchit toutes les
# couches — la génération OPFS qui porte la base migrée, le marqueur et le retrait de l'intention est
# validée avant que la ligne soit dite. Le manifeste du coffre garde SON intention jusqu'à ce que le
# Worker l'ait fait suivre, sur cette ligne-là.
ecrire "$marqueur_donnees" "$P"
rm -f "$marqueur_intention"
sync
fin=$(date +%s%N)
echo "[schema] migration jouee de=$V vers=$P ms=$(( (fin - debut) / 1000000 ))"
exit 0
