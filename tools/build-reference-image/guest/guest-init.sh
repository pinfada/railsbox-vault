#!/bin/sh
# Init du guest (passé au noyau par `init=`), à la place de systemd.
#
# Il n'y a pas de réseau émulé sous v86 : la seule voie entre l'hôte et Rails
# est le port série. Cet init monte les pseudo-systèmes de fichiers, monte le
# disque applicatif, lance Puma, puis rend ttyS0 au pont série — qui devient le
# processus 1 pour le reste de la vie de la VM.
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
dmesg -n 1 2>/dev/null || true

# Disque applicatif attaché en hdb par v86 : /dev/sdb, un ext4 AVEC journal
# (#209, ADR 0004 note du 13/09/2026). Les options par défaut sont celles que la
# durabilité exige : barrières actives (chaque commit du journal émet un FLUSH
# CACHE, acquitté après validation de la génération OPFS) et `data=ordered`. Le
# journal est rejoué ici, au montage, après un verrouillage ou une coupure. Ne
# jamais ajouter `nobarrier`, `data=writeback` ni `noload`.
if ! mountpoint -q /app; then
  echo "[init] montage du disque applicatif /dev/sdb sur /app"
  mount -t ext4 -o barrier=1,data=ordered /dev/sdb /app || {
    echo "[init] ECHEC : /dev/sdb n'est pas un ext4 montable — aucune application a lancer"
    exec sh
  }
fi

# Le pont suit ces journaux ; ils doivent exister avant qu'il ne démarre.
touch /var/log/puma.log /var/log/bridge-err.log

echo "[init] lancement de l'application"
sh /opt/vault/start-app.sh >> /var/log/puma.log 2>&1 &

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
