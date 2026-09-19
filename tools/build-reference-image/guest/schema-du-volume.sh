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
# Et une AUTORISATION : `vault.migrer=1`, posé par le Worker sous le seul geste « Mettre à jour ».
# L'espace `vault.*` est refusé dans la ligne de commande SERVIE (descripteur) : seul le Worker l'écrit.
#
# Avant toute comparaison, chaque grandeur est VALIDÉE : un entier de quatorze chiffres au plus, sans
# zéro de tête (l'horodatage de Rails). `dash` compare en 64 bits et rend « Illegal number », évalué
# FAUX, sur tout le reste : un marqueur illisible désarmait les gardes (revue de la PR #249, constat 3).
#
#   marqueur ou valeur invalide       REFUS marqueur-invalide : rien n'est migré ni réécrit ;
#   paramètre vault.* en double       REFUS parametre-double (revue de la PR #249, constat 2) ;
#   V > P, ou P < I                   REFUS anterieur : du vieux code sur des données récentes — ou
#                                     peut-être intermédiaires —, jamais ;
#   E connu, V != E et V != P         REFUS divergent — sauf V = P : une mise à jour ACHEVÉE dont le
#                                     manifeste n'a pas encore suivi ;
#   P > V sans vault.migrer=1         REFUS migration-non-autorisee (revue de la PR #249, constat 4) ;
#   P > V, autorisé                   I := P et `sync`, db:migrate, puis V := P, I retiré, `sync` ;
#   sinon                             rien : aucun second chargement de Rails.
#
# Chaque décision est dite sur la série, préfixée `[schema]` : c'est ce que le Worker relève
# (`src/vm/constat-de-schema.mjs`). `VAULT_CMDLINE` ne sert qu'aux épreuves du script
# (`tests/vm/schema-du-volume.test.mjs`) : le guest lit /proc/cmdline.
set -u

if [ -f /opt/vault/env.sh ]; then . /opt/vault/env.sh; fi

marqueur_donnees=/app/var/.vault-schema
marqueur_paquet=/app/db/.vault-schema
marqueur_intention=/app/var/.vault-migration
ligne_du_noyau=${VAULT_CMDLINE:-/proc/cmdline}

# Un entier de quatorze chiffres au plus, sans zéro de tête (« 0 » seul est admis).
valide() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    0) return 0 ;;
    0*) return 1 ;;
  esac
  [ "${#1}" -le 14 ]
}

refuser() {
  echo "[schema] REFUS $*"
  exit 3
}

# Lit un marqueur : « absent » s'il n'existe pas ou est vide, sa valeur exacte sinon — ou le REFUS.
# Rien n'est filtré : un octet de trop est un marqueur invalide, pas un marqueur deviné.
lire() {
  if [ ! -s "$1" ]; then
    printf 'absent'
    return 0
  fi
  valeur=$(cat "$1")
  valide "$valeur" || return 1
  printf '%s' "$valeur"
}

# Écrit un marqueur par RENOMMAGE, journalisé par ext4 : une coupure laisse l'ancien ou le nouveau,
# jamais un marqueur vide.
ecrire() {
  printf '%s\n' "$2" > "$1.neuf" && mv "$1.neuf" "$1"
}

# Les paramètres vault.* de la ligne du noyau : un par ligne. Deux fois la même clé est un refus.
parametres=$(tr ' ' '\n' < "$ligne_du_noyau" | grep '^vault\.' || true)
doubles=$(printf '%s\n' "$parametres" | sed -n 's/^\(vault\.[^=]*\)=.*$/\1/p' | sort | uniq -d)
[ -z "$doubles" ] || refuser "parametre-double"

V=$(lire "$marqueur_donnees") || refuser "marqueur-invalide nom=volume"
P=$(lire "$marqueur_paquet") || refuser "marqueur-invalide nom=paquet"
I=$(lire "$marqueur_intention") || refuser "marqueur-invalide nom=intention"
E=$(printf '%s\n' "$parametres" | sed -n 's/^vault\.schema=//p')
[ -n "$E" ] || E=absent
if [ "$E" != absent ] && ! valide "$E"; then refuser "marqueur-invalide"; fi
migrer=non
if printf '%s\n' "$parametres" | grep -qx 'vault\.migrer=1'; then migrer=oui; fi

echo "[schema] volume=$V paquet=$P attendu=$E intention=$I"

if [ "$P" = absent ]; then
  # Un paquet sans marqueur ne sait pas dire son schéma : rien n'est comparé, rien n'est migré.
  # C'est le cas d'une image d'avant T2 ; la décision de la coquille a déjà eu lieu.
  echo "[schema] migration aucune schema=absent"
  exit 0
fi
[ "$V" != absent ] || refuser "divergent volume=absent paquet=$P attendu=$E"

# Comparaisons ENTIÈRES, sur des valeurs validées : `-gt` de dash ne se trompe plus.
[ "$V" -le "$P" ] || refuser "anterieur volume=$V paquet=$P"
if [ "$I" != absent ] && [ "$P" -lt "$I" ]; then
  refuser "anterieur volume=$V paquet=$P intention=$I"
fi
if [ "$E" != absent ] && [ "$V" != "$E" ] && [ "$V" != "$P" ]; then
  refuser "divergent volume=$V paquet=$P attendu=$E"
fi
if [ "$P" -eq "$V" ]; then
  # Une intention restée là (coupure après le marqueur, avant son retrait) n'a plus d'objet.
  if [ "$I" != absent ]; then rm -f "$marqueur_intention" && sync; fi
  echo "[schema] migration aucune schema=$V"
  exit 0
fi
[ "$migrer" = oui ] || refuser "migration-non-autorisee volume=$V paquet=$P"

# L'INTENTION d'abord, rendue durable AVANT la première migration : `sync` pousse le fichier ET le
# répertoire à travers le journal d'ext4 et la barrière du disque (#209). Une coupure pendant les
# migrations laisse donc toujours I = P, et aucun paquet plus ancien ne rouvrira ces données.
ecrire "$marqueur_intention" "$P"
sync
# La mise à jour des DONNÉES commence ICI, avant le chargement de Rails pour `db:migrate` : c'est la
# ligne que le Worker guette pour dire « mise à jour de vos données » (contre-recette QA de #249, 1).
echo "[schema] migration commencee de=$V vers=$P"
debut=$(date +%s%N)
cd /app || exit 3
# Chaque ligne de Rails est redite sur la série, préfixée : « == <version> <Nom>: migrated » dit
# qu'une migration est COMMITÉE — c'est ce qu'une épreuve de coupure entre deux migrations guette.
# `dash` n'a pas `pipefail` : le code de Rails passe par un fichier.
{ bundle exec ruby bin/rails db:migrate 2>&1; echo $? > /run/vault-migration-code; } \
  | tee /var/log/migration.log | sed -u 's/^/[schema] rails : /'
code=$(cat /run/vault-migration-code 2>/dev/null || echo 1)
[ "$code" -eq 0 ] 2>/dev/null || refuser "migration-echouee de=$V vers=$P code=$code"
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
