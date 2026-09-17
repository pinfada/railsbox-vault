#!/bin/bash
# Lit UNE archive tar sur l'entrée standard, et en fabrique les DEUX images d'un paquet applicatif
# (#236, ADR 0041) :
#
#   fabriquer-paquet <taille-graine-Mio>
#
#   /sortie/paquet.ext4   le CODE, depuis le sous-arbre `app` : ext4 SANS journal, marge réduite.
#                         Il est monté en lecture-écriture ÉPHÉMÈRE (ses écritures vivent dans le
#                         delta en RAM du tampon du disque système, et meurent au boot à froid) :
#                         un journal n'y serait jamais rejoué, et il coûterait 4 Mio à chaque
#                         visiteur ainsi qu'une marge que le budget mémoire ne veut pas payer.
#   /sortie/graine.ext4   les DONNÉES, depuis le sous-arbre `graine` : ext4 AVEC journal, à la
#                         taille FIXE demandée. C'est le volume `application` du coffre, celui dont
#                         #209 exige la durabilité — journal, barrières, `errors=remount-ro`.
#
# Une seule extraction pour deux images : l'archive d'un conteneur applicatif pèse plus d'un
# gibioctet, et l'exporter deux fois doublerait la fabrication sans rien prouver de plus.
set -euo pipefail

TAILLE_GRAINE_MIB="${1:?taille de la graine attendue, en Mio}"

BLOC="${BLOC:-4096}"
# Marge du PAQUET : +5 % et 16 Mio. Elle est bien plus faible que celle du rootfs parce que rien ne
# grandit durablement dedans — `tmp/`, `log/` et le cache vivent le temps d'une session — et parce
# que chaque mébioctet de marge est un mébioctet de RAM chez le visiteur (#67, cible 1,2 Gio).
MARGE_PAQUET_POURCENT="${MARGE_PAQUET_POURCENT:-5}"
MARGE_PAQUET_MIB="${MARGE_PAQUET_MIB:-16}"

TRAVAIL="$(mktemp -d)"
trap 'rm -rf "$TRAVAIL"' EXIT

echo "[paquet] extraction de l'archive (app + graine)…" >&2
mkdir -p "$TRAVAIL/racine"
tar -x -C "$TRAVAIL/racine" app graine

for sous_arbre in app graine; do
  [ -d "$TRAVAIL/racine/$sous_arbre" ] || {
    echo "[paquet] sous-arbre absent de l'archive : $sous_arbre" >&2
    exit 1
  }
done

UTILISE_MIB="$(du -sm "$TRAVAIL/racine/app" | cut -f1)"
TAILLE_PAQUET_MIB=$((UTILISE_MIB + UTILISE_MIB * MARGE_PAQUET_POURCENT / 100 + MARGE_PAQUET_MIB))

echo "[paquet] paquet.ext4 : ${TAILLE_PAQUET_MIB} Mio (code : ${UTILISE_MIB} Mio, ext4 sans journal)…" >&2
rm -f /sortie/paquet.ext4
mke2fs -q -t ext4 -b "$BLOC" -O ^has_journal -E lazy_itable_init=0 \
  -d "$TRAVAIL/racine/app" /sortie/paquet.ext4 "${TAILLE_PAQUET_MIB}M"
e2fsck -fn /sortie/paquet.ext4 > /dev/null

echo "[paquet] graine.ext4 : ${TAILLE_GRAINE_MIB} Mio (données, ext4 journalisé)…" >&2
rm -f /sortie/graine.ext4
# Les mêmes options qu'aujourd'hui pour le disque applicatif (#209) : journal présent, tables
# d'inodes et journal initialisés à la fabrication, pour que le guest n'écrive pas en tâche de fond
# des barrières que nulle requête n'a demandées.
mke2fs -q -t ext4 -b "$BLOC" -O has_journal -E lazy_itable_init=0,lazy_journal_init=0 \
  -d "$TRAVAIL/racine/graine" /sortie/graine.ext4 "${TAILLE_GRAINE_MIB}M"
e2fsck -fn /sortie/graine.ext4 > /dev/null

echo "[paquet] prêts : paquet $(stat -c%s /sortie/paquet.ext4) octets, graine $(stat -c%s /sortie/graine.ext4) octets" >&2
