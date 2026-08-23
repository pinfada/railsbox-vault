#!/bin/bash
# Lit une archive tar sur l'entrée standard, en extrait un sous-arbre, et en
# fabrique une image de système de fichiers dans /sortie.
#
#   fabriquer <nom-de-sortie> <ext2|ext4> <sous-arbre|.> [taille-Mio]
#
# Sans taille explicite, elle est calculée sur l'occupation réelle plus une
# marge : un système de fichiers trop juste échoue à la première écriture du
# guest, un système trop large gonfle l'artefact que tous les visiteurs
# téléchargent.
#
# Le noyau et l'initrd sont recopiés dans /sortie quand ils sont présents dans
# l'arbre : ils ne peuvent pas être extraits d'une image ext4 par l'hôte.
set -euo pipefail

NOM="${1:?nom de sortie attendu}"
TYPE="${2:?type de systeme de fichiers attendu (ext2|ext4)}"
SOUS_ARBRE="${3:-.}"
TAILLE_MIB="${4:-}"

MARGE_POURCENT="${MARGE_POURCENT:-25}"
MARGE_MIB="${MARGE_MIB:-96}"
BLOC="${BLOC:-4096}"

case "$TYPE" in
  ext2 | ext4) ;;
  *)
    echo "type de systeme de fichiers non gere : $TYPE" >&2
    exit 2
    ;;
esac

TRAVAIL="$(mktemp -d)"
trap 'rm -rf "$TRAVAIL"' EXIT

echo "[fabriquer] extraction de l'archive (sous-arbre : $SOUS_ARBRE)…" >&2
mkdir -p "$TRAVAIL/racine"
if [ "$SOUS_ARBRE" = "." ]; then
  tar -x -C "$TRAVAIL/racine" --exclude='dev/*' --exclude='proc/*' --exclude='sys/*'
  ARBRE="$TRAVAIL/racine"
else
  tar -x -C "$TRAVAIL/racine" "$SOUS_ARBRE"
  ARBRE="$TRAVAIL/racine/$SOUS_ARBRE"
fi

[ -d "$ARBRE" ] || {
  echo "[fabriquer] sous-arbre absent de l'archive : $SOUS_ARBRE" >&2
  exit 1
}

# Noyau et initrd : extraits AVANT la fabrication, sinon ils ne sont plus
# atteignables que depuis le guest.
for motif in "$ARBRE"/boot/vmlinuz-* "$ARBRE"/boot/initrd.img-*; do
  [ -e "$motif" ] || continue
  case "$(basename "$motif")" in
    vmlinuz-*) cp "$motif" "/sortie/$NOM-vmlinuz" ;;
    initrd.img-*) cp "$motif" "/sortie/$NOM-initrd" ;;
  esac
done

if [ -z "$TAILLE_MIB" ]; then
  UTILISE_MIB="$(du -sm "$ARBRE" | cut -f1)"
  TAILLE_MIB=$((UTILISE_MIB + UTILISE_MIB * MARGE_POURCENT / 100 + MARGE_MIB))
fi

echo "[fabriquer] $NOM.$TYPE : ${TAILLE_MIB} Mio ($TYPE, blocs de $BLOC octets)…" >&2
rm -f "/sortie/$NOM.$TYPE"
mke2fs -q -t "$TYPE" -b "$BLOC" -d "$ARBRE" "/sortie/$NOM.$TYPE" "${TAILLE_MIB}M"

# Une image que e2fsck refuse n'est pas une image : le guest ne la monterait pas
# et l'échec n'apparaîtrait qu'au boot, sans diagnostic exploitable.
e2fsck -fn "/sortie/$NOM.$TYPE" > /dev/null

echo "[fabriquer] $NOM.$TYPE prete ($(stat -c%s "/sortie/$NOM.$TYPE") octets)" >&2
