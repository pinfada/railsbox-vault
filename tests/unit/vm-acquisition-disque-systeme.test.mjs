/**
 * L'ACQUISITION du disque système composé (#236, ADR 0041).
 *
 * Le guest ne reçoit plus un rootfs nu : il reçoit un disque partitionné que la coquille compose à
 * partir de DEUX artefacts servis séparément, chacun sous son adresse par empreinte. Ce module-là
 * est celui qui les range — et c'est le seul endroit où les octets du réseau deviennent un disque.
 *
 * Ce qui est exigé ici :
 *
 *  - **un seul tampon**, alloué une fois à la taille du plan : un téléchargement dans un tampon
 *    intermédiaire ferait cohabiter deux fois 385 Mio, sur un budget mémoire de 1,2 Gio (#67) ;
 *  - **l'empreinte de CHAQUE morceau confrontée** avant que le disque ne serve — un rootfs
 *    substitué est un noyau qui exécute autre chose ;
 *  - **une taille inattendue refusée** : un flux tronqué laisserait un système de fichiers dont le
 *    guest ne découvrirait le manque qu'au montage ;
 *  - **la table de partitions écrite** en tête, et le rootfs à l'octet près à son décalage.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { acquerirLeDisqueSysteme } from "../../src/vm/acquisition-du-disque-systeme.mjs";
import { composerDisqueSysteme, entreesDeLaTable } from "../../src/vm/disque-compose.mjs";

const MIO = 1024 * 1024;
const empreinteDe = (octets) => createHash("sha256").update(octets).digest("hex");

/** Un artefact d'essai : des octets reconnaissables, et sa description servie. */
function artefact(taille, marque) {
  const octets = new Uint8Array(taille);
  for (let index = 0; index < taille; index += 1) octets[index] = (marque + index) % 251;
  return { octets, sha256: empreinteDe(octets) };
}

/** Sert les artefacts par leur URL, en flux. */
function origine(table, { morceauOctets = 512 * 1024 } = {}) {
  return async (url) => {
    const octets = table.get(url);
    if (octets === undefined) return { ok: false, status: 404, body: null };
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          let position = 0;
          return {
            async read() {
              if (position >= octets.byteLength) return { done: true, value: undefined };
              const fin = Math.min(octets.byteLength, position + morceauOctets);
              const value = octets.subarray(position, fin);
              position = fin;
              return { done: false, value };
            },
          };
        },
      },
    };
  };
}

function cas({ rootfsOctets = 4 * MIO, paquetOctets = 2 * MIO } = {}) {
  const rootfs = artefact(rootfsOctets, 7);
  const paquet = artefact(paquetOctets, 61);
  const table = new Map([
    ["/artifacts/rootfs.ext4", rootfs.octets],
    ["/artifacts/paquet.ext4", paquet.octets],
  ]);
  return {
    rootfs,
    paquet,
    recuperer: origine(table),
    description: {
      rootfs: { url: "/artifacts/rootfs.ext4", octets: rootfsOctets, sha256: rootfs.sha256 },
      paquet: { url: "/artifacts/paquet.ext4", octets: paquetOctets, sha256: paquet.sha256 },
    },
  };
}

test("les deux morceaux sont rangés aux décalages du plan, dans un seul tampon", async () => {
  const { rootfs, paquet, recuperer, description } = cas();
  const plan = composerDisqueSysteme({ rootfsOctets: 4 * MIO, paquetOctets: 2 * MIO });

  const disque = await acquerirLeDisqueSysteme({ ...description, recuperer });

  assert.equal(disque.tampon.byteLength, plan.octets);
  assert.deepEqual(
    disque.tampon.subarray(plan.rootfs.debut, plan.rootfs.debut + 64),
    rootfs.octets.subarray(0, 64),
  );
  assert.deepEqual(
    disque.tampon.subarray(plan.paquet.debut, plan.paquet.debut + 64),
    paquet.octets.subarray(0, 64),
  );
  assert.equal(disque.vues.rootfs.byteLength, 4 * MIO);
  assert.equal(disque.vues.paquet.byteLength, 2 * MIO);
  assert.equal(disque.vues.rootfs.buffer, disque.tampon.buffer, "des VUES, pas des copies");
});

test("la table de partitions est écrite en tête et décrit les deux morceaux", async () => {
  const { recuperer, description } = cas();

  const disque = await acquerirLeDisqueSysteme({ ...description, recuperer });
  const [partition1, partition2] = entreesDeLaTable(disque.tampon);

  assert.equal(disque.tampon[510], 0x55);
  assert.equal(disque.tampon[511], 0xaa);
  assert.equal(partition1.premierSecteur, disque.plan.rootfs.debut / 512);
  assert.equal(partition2.premierSecteur, disque.plan.paquet.debut / 512);
});

test("une empreinte qui ne correspond pas refuse le disque, en nommant le morceau", async () => {
  for (const morceau of ["rootfs", "paquet"]) {
    const { recuperer, description } = cas();
    description[morceau] = { ...description[morceau], sha256: "0".repeat(64) };

    await assert.rejects(
      acquerirLeDisqueSysteme({ ...description, recuperer }),
      (erreur) => {
        assert.match(erreur.message, new RegExp(morceau));
        assert.match(erreur.message, /empreinte/i);
        return true;
      },
      morceau,
    );
  }
});

test("un morceau plus court ou plus long que déclaré est refusé", async () => {
  const court = cas();
  court.description.rootfs = { ...court.description.rootfs, octets: 4 * MIO + 4096 };
  await assert.rejects(
    acquerirLeDisqueSysteme({ ...court.description, recuperer: court.recuperer }),
    /octets/i,
  );

  const long = cas();
  long.description.paquet = { ...long.description.paquet, octets: MIO };
  await assert.rejects(
    acquerirLeDisqueSysteme({ ...long.description, recuperer: long.recuperer }),
    /octets/i,
  );
});

test("un artefact indisponible est nommé, avec son état HTTP", async () => {
  const { recuperer, description } = cas();
  description.paquet = { ...description.paquet, url: "/artifacts/absent.ext4" };

  await assert.rejects(acquerirLeDisqueSysteme({ ...description, recuperer }), /404/);
});

test("l'acquisition publie ce qu'elle a transféré et ce que le disque pèse", async () => {
  const { recuperer, description } = cas();

  const disque = await acquerirLeDisqueSysteme({ ...description, recuperer });

  assert.equal(disque.mesures.transfereOctets, 6 * MIO);
  assert.equal(disque.mesures.disqueOctets, disque.tampon.byteLength);
  assert.ok(disque.mesures.acquisitionMs >= 0);
});

test("un disque système hors budget est refusé AVANT d'allouer le tampon (revue #237, 4)", async () => {
  // Le tampon est alloué sur les tailles ANNONCÉES, avant le premier octet reçu : sans cette borne,
  // deux morceaux chacun sous la borne individuelle rendaient un `RangeError` nu, hors budget (#67).
  const { recuperer, description } = cas();
  description.rootfs = { ...description.rootfs, octets: 700 * MIO };
  description.paquet = { ...description.paquet, octets: 700 * MIO };

  await assert.rejects(acquerirLeDisqueSysteme({ ...description, recuperer }), (erreur) => {
    assert.match(erreur.message, /budget|plafond/i);
    // Rien n'a été demandé à l'origine : le refus précède l'acquisition.
    return true;
  });
});
