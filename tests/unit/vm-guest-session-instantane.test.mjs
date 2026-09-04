import assert from "node:assert/strict";
import test from "node:test";

import { BlockJournal } from "../../src/vm/block-journal.mjs";
import { createGuestSession } from "../../src/vm/guest-session.mjs";
import { ATA } from "../../src/vm/v86-flush-bridge.mjs";

// CAPTURE et RESTAURATION sur la session de guest À SHELL (#65, revue de la PR #133).
//
// La session de référence — celle qui boote Rails — savait déjà capturer et restaurer. Celle-ci,
// qui parle à un shell par le port série, ne le savait pas : aucune épreuve ne pouvait donc faire
// ÉCRIRE une session reprise, puisque l'application de référence n'expose que deux routes en
// lecture. C'est la limite que la revue a nommée, et c'est ici qu'elle se lève.
//
// Ce que ces épreuves tiennent, et pourquoi chaque point compte :
//
//  - `capturer()` ARRÊTE l'émulateur avant de sérialiser. Capturer une machine qui bat rendrait un
//    état que rien ne décrit ;
//  - la restauration a lieu APRÈS la pose du pont et AVANT `run()`. Après le pont, parce que
//    `restore_state` rend au guest un paquet IDENTIFY déjà lu — le guest capturé savait son disque
//    en « write back », et un pont posé ensuite n'aurait plus d'IDENTIFY à corriger. Avant `run()`,
//    parce qu'un guest lancé à froid puis écrasé aurait battu pour rien ;
//  - un boot QUI RESTAURE n'attend pas l'invite. Elle a été imprimée avant la capture : l'attendre
//    ferait expirer un boot parfaitement sain.

/**
 * Double d'`IDEInterface` réduit à ce que le pont de durabilité touche.
 *
 * La CLASSE est refabriquée à chaque banc, et ce n'est pas une coquetterie : le pont opère sur le
 * PROTOTYPE — les vraies instances de v86 sont scellées — et refuse d'être posé deux fois sur le
 * même. Une classe partagée entre deux épreuves ferait échouer la seconde sur un état laissé par la
 * première.
 */
function fabriquerIdeDouble() {
  return class IdeDouble {
    constructor(buffer) {
      this.buffer = buffer;
      this.is_atapi = false;
      this.data = new Uint8Array(512);
      this.status_reg = 0;
      this.error_reg = 0;
      this.handled = [];
    }

    ata_command(commande) {
      this.handled.push(commande);
      this.status_reg = ATA.srDrdy | ATA.srDsc;
    }

    create_identify_packet() {
      this.data.fill(0);
    }

    push_irq() {}
  };
}

/**
 * Émulateur double qui JOURNALISE l'ordre de ses gestes. C'est l'ordre qui est le contrat : la
 * restauration entre la pose du pont et `run()`, l'arrêt avant la sérialisation.
 */
function emulateurDouble(gestes, adapter) {
  const IdeDouble = fabriquerIdeDouble();
  return function V86Double() {
    this.v86 = { cpu: { devices: { ide: { primary: { master: new IdeDouble(adapter) } } } } };
    this.add_listener = () => {};
    this.run = () => gestes.push("run");
    this.stop = () => gestes.push("stop");
    this.save_state = async () => {
      gestes.push("save_state");
      return Uint8Array.from([1, 2, 3, 4]).buffer;
    };
    this.restore_state = async () => gestes.push("restore_state");
  };
}

function banc(gestes) {
  const adapter = { flush: (ack) => ack() };
  return {
    V86: emulateurDouble(gestes, adapter),
    artifacts: {
      wasm: new Uint8Array(0),
      bios: new Uint8Array(0),
      vgaBios: new Uint8Array(0),
      cdrom: new Uint8Array(0),
    },
    adapter,
    journal: new BlockJournal(),
  };
}

test("la capture ARRÊTE l'émulateur avant de sérialiser son état", async () => {
  const gestes = [];
  const session = createGuestSession(banc(gestes));
  await session.boot({ timeout: 2_000, etatARestaurer: new Uint8Array([9]) });

  const etat = await session.capturer();
  assert.ok(etat instanceof Uint8Array, "la capture rend des octets, jamais un ArrayBuffer nu");
  assert.deepEqual([...etat], [1, 2, 3, 4]);
  assert.deepEqual(
    gestes.slice(-2),
    ["stop", "save_state"],
    "l'arrêt vient AVANT la sérialisation",
  );
});

test("un boot QUI RESTAURE pose le pont, restaure, puis lance — et n'attend pas l'invite", async () => {
  const gestes = [];
  const session = createGuestSession(banc(gestes));
  // Le double n'imprime JAMAIS l'invite du guest. Un boot à froid expirerait donc ; celui-ci rend
  // la main, ce qui est la preuve qu'il ne l'attend pas.
  await session.boot({ timeout: 2_000, etatARestaurer: new Uint8Array([9]) });
  assert.deepEqual(gestes, ["restore_state", "run"]);
});

test("un boot À FROID, lui, attend toujours l'invite", async () => {
  const gestes = [];
  const session = createGuestSession(banc(gestes));
  await assert.rejects(session.boot({ timeout: 300 }), /invite du guest/);
  assert.deepEqual(gestes, ["run"], "rien n'a été restauré : il n'y avait pas d'état");
});

test("« suspendre » arrête sans sérialiser : c'est la quiescence par l'arrêt", async () => {
  const gestes = [];
  const session = createGuestSession(banc(gestes));
  await session.boot({ timeout: 2_000, etatARestaurer: new Uint8Array([9]) });
  session.suspendre();
  assert.deepEqual(gestes.slice(-1), ["stop"]);
  assert.equal(session.deltaRootfsOctets(), null, "cette session n'a pas de rootfs à elle");
});
