#!/bin/sh
# Le `secret_key_base` FOURNI PAR LE COFFRE à toute application Rails (#351, ADR 0055).
#
#   sh secret-du-coffre.sh <dossier des données>     # imprime le secret sur la sortie standard
#
# Rails exige un `secret_key_base` en production, et une application conventionnelle le lit dans
# `SECRET_KEY_BASE` ou dans ses credentials — que le paquet n'apporte pas, puisque la clé maîtresse
# n'y entre jamais. Sans lui : `ArgumentError: Missing secret_key_base`, et l'application s'arrête.
#
# RailsBox (même propriétaire, MIT) tire la valeur au hasard À LA CONSTRUCTION de son image. Ici
# l'image est PUBLIQUE : une valeur cuite à la construction serait connue de tout visiteur. Elle est
# donc tirée au PREMIER DÉMARRAGE du coffre, dans le guest, et gardée sur le disque de DONNÉES
# (`/app/var`, chiffré par le coffre) : propre à ce coffre, stable d'un boot à froid à l'autre, et
# jamais publiée. Ce qu'elle protège et ce qu'elle ne protège pas est dit dans `SECURITY.md`.
#
# Si le disque de données refuse l'écriture (`errors=remount-ro`), une valeur ÉPHÉMÈRE est rendue et
# le script le dit sur sa sortie d'erreur : l'application démarre, ses sessions ne survivront pas au
# prochain boot. Un fichier illisible ou mal formé est remplacé, jamais servi.
set -eu

dossier="${1:?usage : secret-du-coffre.sh <dossier des donnees>}"
fichier="$dossier/.vault-secret-key-base"

# 64 octets, soit 128 chiffres hexadécimaux, et rien d'autre.
bien_forme() {
  [ -f "$1" ] || return 1
  [ "$(wc -c < "$1")" -eq 128 ] || return 1
  [ "$(tr -d '0-9a-f' < "$1" | wc -c)" -eq 0 ]
}

tirer() {
  od -An -tx1 -N64 /dev/urandom | tr -d ' \n'
}

if bien_forme "$fichier"; then
  cat "$fichier"
  exit 0
fi

umask 077
provisoire="$fichier.$$"
if tirer > "$provisoire" 2>/dev/null && sync "$provisoire" 2>/dev/null \
  && mv "$provisoire" "$fichier" 2>/dev/null && bien_forme "$fichier"; then
  echo "[vault] secret_key_base tire pour ce coffre" >&2
  cat "$fichier"
  exit 0
fi
rm -f "$provisoire" 2>/dev/null || true
echo "[vault] secret_key_base EPHEMERE : le disque de donnees refuse l'ecriture" >&2
tirer
