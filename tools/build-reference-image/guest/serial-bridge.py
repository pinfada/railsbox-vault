# Pont serie du guest : seule voie entre l'hote et Rails, faute de reseau emule
# sous v86.
#
# PROVENANCE. Le principe de trame et le decoupage base64 acquitte sont repris
# de RailsBox Live (MIT), fichier tools/build-v86-image/base/rib/serial-bridge.py
# au commit a36baf0bcbdec65ca3749ba1fb6d7b94e4abd594. Ce fichier n'en est pas une
# copie : il en reimplemente un sous-ensemble strict, sans synchronisation
# d'horloge, sans injection d'environnement et sans redemarrage a chaud, aucun
# de ces trois besoins n'existant pour l'invariant de reference. Le prefixe de
# trame est donc VOLONTAIREMENT different (@VLT1 et non @RIB1) : les deux
# protocoles ne sont pas interchangeables et ne doivent pas etre confondus.
#
# PROTOCOLE (une trame par ligne, ASCII).
#
#   Hote -> guest
#     @VLT1 REQ <id> <base64 du descripteur JSON>
#         descripteur : {"method": str, "path": str,
#                        "headers": [[nom, valeur], ...], "bodyLength": int}
#     @VLT1 BOD <id> <base64 d'une tranche du corps>   -> acquittee par ACK
#     @VLT1 FIN <id>
#
#   Guest -> hote
#     @VLT1 ACK <id>                  tranche recue et ecrite
#     @VLT1 RSB <id> <octets bruts>   debut de reponse, taille AVANT base64
#     @VLT1 DAT <id> <base64>         tranche de reponse, longueur multiple de 4
#     @VLT1 END <id>                  fin de reponse
#     @VLT1 ERR <id> <code> <libelle> echec, jamais un succes silencieux
#     @VLT1 LOG <texte>               journal du pont
#
# Toute ligne qui ne commence pas par @VLT1 est un journal applicatif relaye
# tel quel : l'hote l'affiche et ne tente pas de la decoder.
import base64
import http.client
import json
import os
import sys
import threading
import time

MAGIC = "@VLT1"
# Multiple de 4 : chaque tranche base64 est decodable isolement, donc l'hote
# peut ecrire au fur et a mesure sans reconstituer une chaine monolithique.
CHUNK = 8000
HTTP_HOST = "127.0.0.1"
HTTP_PORT = int(os.environ.get("PORT", "3000"))
HTTP_TIMEOUT = 120
LOG_FILES = ["/var/log/puma.log", "/var/log/bridge-err.log"]
LOG_POLL_SECONDS = 1.0

# Un seul ecrivain sur le port serie. Sans ce verrou, une ligne de journal
# s'intercale au milieu d'une trame DAT et corrompt la reponse.
write_lock = threading.Lock()
inflight = {}


def emit(line):
    with write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def emit_error(req_id, code, libelle):
    emit("%s ERR %s %d %s" % (MAGIC, req_id, code, libelle))


def emit_response(req_id, raw_bytes):
    payload = base64.b64encode(raw_bytes).decode("ascii")
    emit("%s RSB %s %d" % (MAGIC, req_id, len(raw_bytes)))
    for start in range(0, len(payload), CHUNK):
        emit("%s DAT %s %s" % (MAGIC, req_id, payload[start:start + CHUNK]))
    emit("%s END %s" % (MAGIC, req_id))


def handle_request(req_id, descriptor, body):
    try:
        headers = {nom: valeur for nom, valeur in descriptor.get("headers", [])}
        conn = http.client.HTTPConnection(HTTP_HOST, HTTP_PORT, timeout=HTTP_TIMEOUT)
        # body=None pour un corps vide : evite un Content-Length: 0 parasite sur
        # les GET, que certains middlewares Rack traitent differemment.
        conn.request(descriptor["method"], descriptor["path"],
                     body=body if body else None, headers=headers)
        response = conn.getresponse()
        response_body = response.read()
        conn.close()
    except ConnectionRefusedError:
        emit_error(req_id, 7, "application-injoignable")
        return
    except TimeoutError:
        emit_error(req_id, 28, "delai-depasse")
        return
    except Exception as erreur:  # noqa: BLE001 - le libelle part sur le fil
        emit_error(req_id, 56, "echec-" + type(erreur).__name__)
        return

    entete = ["HTTP/1.1 %d %s" % (response.status, response.reason or "")]
    for nom, valeur in response.getheaders():
        if nom.lower() in ("transfer-encoding", "connection"):
            continue
        entete.append(nom + ": " + valeur)
    brut = ("\r\n".join(entete) + "\r\n\r\n").encode("utf-8", "replace") + response_body
    emit_response(req_id, brut)


def start_request(line):
    try:
        _, _, req_id, encode = line.split(" ", 3)
        descriptor = json.loads(base64.b64decode(encode))
    except Exception as erreur:  # noqa: BLE001
        emit("%s LOG descripteur illisible: %s" % (MAGIC, type(erreur).__name__))
        return
    inflight[req_id] = {"descriptor": descriptor, "body": bytearray(), "broken": False}


def append_body(line):
    try:
        _, _, req_id, encode = line.split(" ", 3)
    except ValueError:
        return
    entree = inflight.get(req_id)
    if entree is None:
        return
    try:
        entree["body"].extend(base64.b64decode(encode))
    except Exception:  # noqa: BLE001
        entree["broken"] = True
    # Acquittement APRES ecriture : l'hote n'envoie la tranche suivante qu'ici,
    # ce qui borne les octets en vol a une seule tranche et evite le debordement
    # du tampon d'entree du tty.
    emit("%s ACK %s" % (MAGIC, req_id))


def finish_request(line):
    try:
        req_id = line.split(" ", 2)[2].strip()
    except IndexError:
        return
    entree = inflight.pop(req_id, None)
    if entree is None:
        return
    attendu = entree["descriptor"].get("bodyLength", 0)
    if entree["broken"] or len(entree["body"]) != attendu:
        emit_error(req_id, 56, "corps-incomplet-%d-sur-%d" % (len(entree["body"]), attendu))
        return
    threading.Thread(target=handle_request,
                     args=(req_id, entree["descriptor"], bytes(entree["body"])),
                     daemon=True).start()


def follow_logs():
    positions = {}
    while True:
        for chemin in LOG_FILES:
            try:
                with open(chemin, "r", errors="replace") as fichier:
                    depart = positions.get(chemin, 0)
                    if os.path.getsize(chemin) < depart:
                        depart = 0  # journal tronque : on repart du debut
                    fichier.seek(depart)
                    for ligne in fichier:
                        ligne = ligne.rstrip("\n").replace("\x00", "").strip()
                        if ligne:
                            emit(ligne)
                    positions[chemin] = fichier.tell()
            except OSError:
                pass
        time.sleep(LOG_POLL_SECONDS)


def main():
    threading.Thread(target=follow_logs, daemon=True).start()
    emit("%s LOG pont serie pret" % MAGIC)
    for line in sys.stdin:
        line = line.strip()
        if line.startswith(MAGIC + " REQ "):
            start_request(line)
        elif line.startswith(MAGIC + " BOD "):
            append_body(line)
        elif line.startswith(MAGIC + " FIN "):
            finish_request(line)


main()
