/**
 * Les AGRÉGATS du banc mémoire : le pic, et ce qui est vrai AU pic (#236, revue de sécurité, 5).
 *
 * Le banc publie une colonne « privé au pic ». Elle était calculée par un `Math.max` INDÉPENDANT sur
 * la série du privé : deux grandeurs prises à deux instants différents, présentées comme un
 * encadrement du même. La colonne publiée (1 843 Mio) dépassait ainsi le « pic » annoncé
 * (1 552 Mio), ce qui est impossible pour un même échantillon — le privé est une part du résident.
 *
 * Ce que cette suite exige : tout ce qui est dit « au pic » vient de L'ÉCHANTILLON du pic, et le
 * maximum d'une série, quand il est publié, est nommé comme tel.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { agregerLesReleves } from "../../tools/memoire-agregats.mjs";

const releve = (resident, prive, plusGros = "renderer") => ({
  residentOctets: resident,
  priveOctets: prive,
  plusGrosProcessus: plusGros,
  processus: 4,
});

test("le privé publié est celui de l'ÉCHANTILLON du pic, pas le maximum de sa série", () => {
  // Le second relevé porte le plus grand privé, le troisième le plus grand résident : un `Math.max`
  // indépendant rendrait 900, qui n'a jamais coexisté avec le pic de 1 000.
  const agregat = agregerLesReleves([releve(400, 300), releve(800, 900), releve(1000, 600, "gpu")]);

  assert.equal(agregat.residentPicOctets, 1000);
  assert.equal(agregat.priveAuPicOctets, 600);
  assert.equal(agregat.plusGrosProcessusAuPic, "gpu");
});

test("le privé au pic et le maximum du privé sont DEUX grandeurs, jamais confondues", () => {
  // Elles ne sont pas comparables entre elles : le « résident » est un working set (ce que le
  // système garde en mémoire physique), le « privé » un engagement (`PrivatePageCount` sous Windows,
  // `RssAnon` sous Linux), qui peut lui être supérieur. Ce qui est exigé n'est donc PAS que l'un
  // borne l'autre, mais que chacun dise ce qu'il dit : l'un vient de l'échantillon du pic, l'autre
  // est le plus grand de la phase.
  const agregat = agregerLesReleves([releve(1552, 1200), releve(1400, 1843)]);

  assert.equal(agregat.priveAuPicOctets, 1200, "le privé AU pic vient de l'échantillon du pic");
  assert.equal(agregat.priveMaximumOctets, 1843, "le maximum est celui de la série");
  assert.notEqual(agregat.priveAuPicOctets, agregat.priveMaximumOctets);
});

test("le maximum du privé reste publié, sous son propre nom", () => {
  const agregat = agregerLesReleves([releve(1552, 1200), releve(1400, 1843)]);

  assert.equal(agregat.priveMaximumOctets, 1843);
});

test("une série sans privé connu rend null plutôt qu'un nombre inventé", () => {
  const agregat = agregerLesReleves([releve(500, null), releve(700, null)]);

  assert.equal(agregat.priveAuPicOctets, null);
  assert.equal(agregat.priveMaximumOctets, null);
  assert.equal(agregat.residentPicOctets, 700);
});

test("la moyenne et le compte décrivent la série entière", () => {
  const agregat = agregerLesReleves([releve(100, 50), releve(200, 60), releve(300, 70)]);

  assert.equal(agregat.releves, 3);
  assert.equal(agregat.residentMoyenOctets, 200);
});

test("une série vide n'est pas un agrégat", () => {
  assert.equal(agregerLesReleves([]), null);
});
