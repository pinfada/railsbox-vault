import assert from "node:assert/strict";
import { test } from "node:test";

import { reassembleCommandOutput } from "../../src/vm/serial-console.mjs";

// Le terminal du guest (BusyBox sur ttyS0) replie toute ligne de plus de 80 colonnes en insérant
// une séquence de repli « \r\r\n » (double retour chariot), distincte du « \r\n » d'une vraie fin
// de ligne. Les flux ci-dessous reproduisent ce que la console série émet réellement — mesuré en
// bootant `linux4.iso` — pour une ligne logique dépassant 80 colonnes.
const REPLI = "\r\r\n";

test("une ligne de sortie de plus de 80 colonnes repliée par le terminal est recollée", () => {
  // Réponse JSON d'une seule ligne logique, plus longue que 80 colonnes : le cas des scénarios
  // riches (#7) que la contrainte « sous 80 colonnes » interdisait jusqu'ici.
  const payload = `{"invariant":"conforming","sha256":"${"a".repeat(40)}","records":128}`;
  assert.ok(payload.length > 80, "le scénario n'a de sens que si la ligne dépasse 80 colonnes");

  const replie = payload.slice(0, 80) + REPLI + payload.slice(80);
  const transcript = `cat /vault/etat.json; echo R""B7\r\n${replie}\r\nRB7\r\n~% `;

  assert.equal(reassembleCommandOutput(transcript, 7), payload);
});

test("un jeton de fin coupé en deux par le repli reste détecté", () => {
  // Capture réelle : commande dont l'écho atteint 80 colonnes pile au milieu de `R""B`, si bien
  // que la marque de fin est scindée en `R"` + `"B2`. Sans recollage, la frontière écho/sortie est
  // introuvable et l'écho entier est pris pour la sortie.
  const corps = "Z" + "y".repeat(62);
  const transcript = `echo ${corps}; echo R"${REPLI}"B2\r\n${corps}\r\nRB2\r\n~% `;

  assert.equal(reassembleCommandOutput(transcript, 2), corps);
});

test("les vraies fins de ligne d'une sortie multiligne sont préservées", () => {
  // Garde-fou : le recollage ne doit retirer que le repli du terminal, jamais les « \r\n » qui
  // séparent de vraies lignes (ex. `dmesg | tail`).
  const transcript = "dmesg | tail -2; echo R\"\"B3\r\nligne un\r\nligne deux\r\nRB3\r\n~% ";

  assert.equal(reassembleCommandOutput(transcript, 3), "ligne un\nligne deux");
});
