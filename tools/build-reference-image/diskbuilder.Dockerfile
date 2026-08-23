# syntax=docker/dockerfile:1
#
# Fabricant de systèmes de fichiers. Il ne contient aucune brique du guest : il
# reçoit une archive tar sur son entrée standard et rend une image ext2 ou ext4.
#
# Pourquoi un conteneur plutôt que l'hôte : `mke2fs -d` doit tourner en root pour
# préserver les uid et les permissions de l'arbre extrait, et Windows n'a pas
# e2fsprogs. Le conteneur donne les deux sans privilège particulier sur l'hôte.
FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends e2fsprogs; \
    rm -rf /var/lib/apt/lists/*

COPY tools/build-reference-image/fabriquer-systeme-de-fichiers.sh /usr/local/bin/fabriquer
RUN chmod +x /usr/local/bin/fabriquer

ENTRYPOINT ["/usr/local/bin/fabriquer"]
