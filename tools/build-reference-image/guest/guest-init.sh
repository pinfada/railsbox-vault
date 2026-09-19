#!/bin/sh
# Init du guest (passé au noyau par `init=`), à la place de systemd.
#
# Il n'y a pas de réseau émulé sous v86 : la seule voie entre l'hôte et Rails
# est le port série. Cet init monte les pseudo-systèmes de fichiers, monte le
# paquet applicatif puis le disque de données, lance Puma, puis rend ttyS0 au
# pont série — qui devient le processus 1 pour le reste de la vie de la VM.
set -eu

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

mount -o remount,rw / 2>/dev/null || true
mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys || mount -t sysfs sysfs /sys
mountpoint -q /dev || mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts /dev/shm /run /tmp /app /var/log
mountpoint -q /dev/pts || mount -t devpts devpts /dev/pts
mount -t tmpfs -o mode=1777 tmpfs /dev/shm 2>/dev/null || true
mount -t tmpfs tmpfs /run 2>/dev/null || true
mount -t tmpfs tmpfs /tmp 2>/dev/null || true

hostname railsbox-vault-reference
ip link set lo up 2>/dev/null || ifconfig lo up 2>/dev/null || true
# `docker export` ne conserve pas /etc/hosts : Docker le monte à l'exécution.
printf '127.0.0.1\tlocalhost railsbox-vault-reference\n::1\tlocalhost\n' > /etc/hosts

# PAQUET APPLICATIF : seconde partition du disque système (#236, ADR 0041).
#
# `hda` porte une table de partitions composée par la coquille : /dev/sda1 est le rootfs (monté par
# le noyau), /dev/sda2 le paquet — le CODE de l'application. Il est monté en LECTURE-ÉCRITURE, et
# ces écritures sont ÉPHÉMÈRES : elles vivent dans le delta en RAM du tampon du disque système et
# disparaissent au boot à froid, sans erreur. Une application qui doit conserver quelque chose
# l'écrit sous /app/var, et nulle part ailleurs (SECURITY.md, #210).
#
# Pas de journal sur cette partition : il ne serait jamais rejoué, puisque rien de ce qui est écrit
# ici ne survit. Les options de durabilité de #209 s'appliquent au disque de DONNÉES, plus bas.
if ! mountpoint -q /app; then
  echo "[init] montage du paquet applicatif /dev/sda2 sur /app (ecritures ephemeres)"
  mount -t ext4 -o rw /dev/sda2 /app || {
    echo "[init] ECHEC : /dev/sda2 n'est pas un ext4 montable — aucun paquet applicatif"
    exec sh
  }
fi

# Les journaux de l'application vont sur un tmpfs : la partition du paquet a une marge RÉDUITE
# (+5 % + 16 Mio), et un journal qui grossit pendant une longue session la remplirait — or chaque
# bloc écrit entre dans le delta en RAM, donc dans l'instantané.
mkdir -p /app/log /app/tmp
mountpoint -q /app/log || mount -t tmpfs tmpfs /app/log

# DISQUE DE DONNÉES attaché en hdb par v86 : /dev/sdb, un ext4 AVEC journal
# (#209, ADR 0004 note du 13/09/2026). Les options par défaut sont celles que la
# durabilité exige : barrières actives (chaque commit du journal émet un FLUSH
# CACHE, acquitté après validation de la génération OPFS) et `data=ordered`. Le
# journal est rejoué ici, au montage, après un verrouillage ou une coupure. Ne
# jamais ajouter `nobarrier`, `data=writeback` ni `noload`. `errors=remount-ro`
# (revue #211, constat 5) : un système de fichiers en erreur CESSE d'écrire au
# lieu de continuer, si bien qu'une écriture qui réussit après un boot à froid
# dit quelque chose de l'état du disque.
if ! mountpoint -q /app/var; then
  echo "[init] montage du disque de donnees /dev/sdb sur /app/var"
  mount -t ext4 -o barrier=1,data=ordered,errors=remount-ro /dev/sdb /app/var || {
    echo "[init] ECHEC : /dev/sdb n'est pas un ext4 montable — aucune donnee a servir"
    exec sh
  }
fi

# L'ÉTAT du disque de données, relevé à CHAQUE boot (revue #211, constat 5) :
# options réellement montées, compteur d'erreurs persistant du superbloc (une
# erreur d'une session précédente y reste), lignes `EXT4-fs error` et
# `mounting unchecked` du noyau, rejeu du journal. Il est dit sur la série pour
# qui lit un diagnostic, et déposé dans /run (tmpfs, neuf à chaque boot) pour
# que l'application le publie et qu'un scénario de bout en bout l'asserte sans
# toucher au pont. La console du noyau n'est rendue muette qu'APRÈS : jusqu'ici,
# les erreurs du montage atteignent la série.
etat_disque=/run/vault-disque-de-donnees
{
  echo "options=$(grep ' /app/var ' /proc/mounts | cut -d ' ' -f 4)"
  echo "erreurs=$(cat /sys/fs/ext4/sdb/errors_count 2>/dev/null || echo inconnu)"
  echo "alertes=$(dmesg 2>/dev/null | grep -c -E 'EXT4-fs error|mounting unchecked' || true)"
  echo "rejeu=$(dmesg 2>/dev/null | grep -c 'EXT4-fs (sdb): recovery complete' || true)"
} > "$etat_disque"
sed 's/^/[init] disque de donnees : /' "$etat_disque"
dmesg 2>/dev/null | grep 'EXT4-fs' | sed 's/^/[init] noyau : /' || true
# Muette avant l'application et le pont : un message du noyau intercalé dans le
# flux série corromprait une trame.
dmesg -n 1 2>/dev/null || true

# Le pont suit ces journaux ; ils doivent exister avant qu'il ne démarre.
touch /var/log/puma.log /var/log/bridge-err.log

# Le SCHÉMA des données est confronté au paquet AVANT Rails (#236 T2, ADR 0042) : une migration
# n'est jouée que si le paquet le dépasse, et Rails n'est PAS lancé si les données sont plus
# récentes que le code ou ne disent pas ce que le manifeste attend. Synchrone, et dit sur la série :
# le Worker de confiance relève ces lignes. Le pont démarre dans tous les cas — un guest qui refuse
# reste joignable, et son refus se lit au lieu de se deviner.
if sh /opt/vault/schema-du-volume.sh; then
  echo "[init] lancement de l'application"
  sh /opt/vault/start-app.sh >> /var/log/puma.log 2>&1 &
else
  echo "[init] application NON lancee : le schema des donnees l'interdit"
fi

echo "[init] pont serie actif sur ttyS0"
# `raw` : en mode canonique le tty tronque les lignes au-delà de 4096
# caractères, or une trame base64 est bien plus longue. `-echo` : sans lui,
# chaque trame reçue est renvoyée en écho et corrompt le flux de réponse.
stty -F /dev/ttyS0 raw -echo

# Pas d'`exec` : le pont est le processus 1, et un processus 1 qui se termine
# provoque une panique du noyau. Le message de panique remplacerait alors le
# diagnostic — c'est exactement ce qui est arrivé le 2026-08-23, où
# `python3-minimal` privait le pont de `http.client` sans que rien ne le dise.
python3 /opt/vault/serial-bridge.py < /dev/ttyS0 > /dev/ttyS0 2> /var/log/bridge-err.log
code=$?
{
  echo "[init] ECHEC : le pont serie s'est arrete (code $code)"
  tail -n 40 /var/log/bridge-err.log 2>/dev/null
  echo "[init] la VM reste en vie pour que ce diagnostic soit lisible"
} > /dev/ttyS0 2>&1
while true; do sleep 3600; done
