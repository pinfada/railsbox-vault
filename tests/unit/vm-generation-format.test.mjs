import assert from "node:assert/strict";
import test from "node:test";

import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import {
  ENTETE_OCTETS,
  FORMAT_DE_VOLUME_A_DEUX_COMPTEURS,
  GENERATION_FORMAT,
  GENERATION_FORMAT_DEUX_COMPTEURS,
  GENERATION_FORMAT_SANS_FRAICHEUR,
  RACINE_ENTETE_V5_OCTETS,
  enregistrementsSousIdentiteDeBloc,
  formatEcritSousFraicheur,
  RACINE_ENTETE_V2_OCTETS,
  RACINES,
  RACINE_ENTETE_OCTETS,
  PAGE_HOTE_OCTETS,
  RACINE_OCTETS,
  SURCOUT_ENREGISTREMENT,
  decoderRacine,
  encoderEnteteEnregistrement,
  encoderRacine,
  longueurPhysiqueDeCharge,
  offsetDeRacine,
  racineDeSequence,
} from "../../src/vm/generation-format.mjs";
import { FRAICHEUR_OCTETS } from "../../src/vm/generation-fraicheur.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { FORMAT_VOLUME_V4, identifiantVolumeEnOctets } from "../../src/vm/volume-chiffre-format.mjs";

// Format de l'enregistrement de validation d'une génération (#16, ADR 0014 ; #18, ADR 0016).
//
// Ces épreuves fixent ce qu'un support doit rendre pour qu'une génération soit VALIDÉE. La règle est
// stricte dans un seul sens : tout doute est un refus.
//
// **Ce que #18 déplace, et qu'il faut lire avant tout le reste.** En v2, `decoderRacine` refusait un
// octet retourné n'importe où dans l'en-tête, grâce à un CRC-32. En v3 il n'y a plus de CRC : le
// module de format refuse ce qu'on peut refuser SANS CLÉ — secteur vierge, marqueur absent, format
// inconnu, autre taille de secteur, autre taille de volume — et rend le sceau à l'appelant. Ce qui
// refuse un octet retourné dans un champ AUTHENTIFIÉ est l'ÉTIQUETTE, vérifiée par `ouvrirRacine`.
// Les deux moitiés sont éprouvées ici, l'une après l'autre, parce que croire que la première suffit
// serait exactement la confusion que l'ADR 0015 refuse : classer avant d'avoir vérifié.

const TAILLE_VOLUME = 16384;
const IDENTIFIANT = "0123456789abcdef0123456789abcdef";

/** Octets d'un sceau de racine, distincts pour qu'un décalage se voie. */
function motif(longueur, graine) {
  return Uint8Array.from({ length: longueur }, (_, index) => (index * 13 + graine) % 256);
}

function racineValide(surcharge = {}) {
  return {
    // Le FORMAT que la session écrit. Une racine de volume v3 en porte quatre ; une racine de volume
    // v4 en porte cinq, et publie alors le second compteur (#182).
    format: GENERATION_FORMAT,
    sequence: 5,
    generation: 3,
    tailleVolume: TAILLE_VOLUME,
    nombreEntrees: 2,
    longueurCharge: 1024,
    identifiantVolume: identifiantVolumeEnOctets(IDENTIFIANT),
    scellementsCumulesVolume: 42,
    nonce: motif(12, 1),
    chiffre: motif(32, 2),
    etiquette: motif(16, 3),
    // La FRAÎCHEUR de l'ADR 0019 : le sceau de l'empreinte de région, puis son chiffré. Elle est
    // obligatoire — `null` pour dire qu'aucune n'est scellée —, jamais facultative.
    fraicheur: motif(FRAICHEUR_OCTETS, 4),
    ...surcharge,
  };
}

test("une racine encodée tient dans un seul secteur et se relit à l'identique", () => {
  const octets = encoderRacine(racineValide());
  assert.equal(octets.byteLength, RACINE_OCTETS);
  assert.ok(RACINE_OCTETS <= 512, "la commutation doit tenir dans une écriture d'un seul secteur");
  assert.equal(
    RACINE_ENTETE_OCTETS,
    202,
    "136 octets de l'ADR 0016, plus les 66 de la fraîcheur de l'ADR 0019 : c'est un contrat",
  );

  const relue = decoderRacine(octets, { tailleVolume: TAILLE_VOLUME });
  assert.equal(relue.valide, true, relue.raison ?? "");
  assert.equal(relue.racine.sequence, 5);
  assert.equal(relue.racine.generation, 3);
  assert.equal(relue.racine.nombreEntrees, 2);
  assert.equal(relue.racine.longueurCharge, 1024);
  assert.equal(relue.racine.scellementsCumulesVolume, 42);
  assert.equal(
    relue.racine.scellementsCumulesJournal,
    null,
    "une racine de format 4 ne publie qu'un compteur, et le dit par « null » plutôt que par zéro",
  );
  assert.equal(relue.racine.format, GENERATION_FORMAT);
  assert.deepEqual(relue.racine.identifiantVolume, identifiantVolumeEnOctets(IDENTIFIANT));
  assert.deepEqual(relue.racine.scelle.nonce, motif(12, 1));
  assert.deepEqual(relue.racine.scelle.chiffre, motif(32, 2));
  assert.deepEqual(relue.racine.scelle.etiquette, motif(16, 3));
  assert.deepEqual(relue.racine.fraicheur, motif(FRAICHEUR_OCTETS, 4));
});

test("une racine SANS fraîcheur reste lisible, et se relit pour ce qu'elle est", () => {
  // C'est la compatibilité que l'ADR 0019 décide : un volume scellé par #18 porte une racine de
  // format 2, et il doit rester OUVRABLE. Le décodeur la rend avec `fraicheur: null` — jamais une
  // empreinte de zéros, qui serait une empreinte comme une autre et ferait refuser le volume.
  const octets = encoderRacine(racineValide({ fraicheur: null }));
  assert.deepEqual(
    [...octets.subarray(RACINE_ENTETE_V2_OCTETS)],
    [...new Uint8Array(RACINE_OCTETS - RACINE_ENTETE_V2_OCTETS)],
    "une racine sans fraîcheur ne pose rien dans la réserve",
  );
  const relue = decoderRacine(octets, { tailleVolume: TAILLE_VOLUME });
  assert.equal(relue.valide, true, relue.raison ?? "");
  assert.equal(relue.racine.format, GENERATION_FORMAT_SANS_FRAICHEUR);
  assert.equal(relue.racine.fraicheur, null);
});

test("une racine dont la fraîcheur est OUBLIÉE est refusée à l'encodage", () => {
  // `null` déclare l'absence, `undefined` est un oubli — et un oubli aurait écrit une racine
  // d'avant l'ADR 0019 sans que personne le décide. C'est la règle des attentes de l'ADR 0015,
  // appliquée au champ que #19 ajoute.
  const { fraicheur, ...sansLeChamp } = racineValide();
  assert.equal(fraicheur.byteLength, FRAICHEUR_OCTETS);
  assert.throws(() => encoderRacine(sansLeChamp), /obligatoire/);
});

test("le format du journal vaut 4 : un runtime antérieur refuse cette racine sans la comprendre", () => {
  // #18 l'avait porté de 1 à 2, #19 de 2 à 3, et #143 de 3 à 4 — la charge du journal change, parce
  // qu'un enregistrement porte désormais sa propre étiquette de domaine. Un runtime plus ancien
  // refuse cette racine comme un format inconnu, ce qui est le comportement voulu : il ouvrirait les
  // enregistrements dans l'espace d'identités du VOLUME.
  assert.equal(GENERATION_FORMAT, 4);
  assert.equal(GENERATION_FORMAT_DEUX_COMPTEURS, 5);
  const octets = encoderRacine(racineValide());
  const ancienne = Uint8Array.from(octets);
  new DataView(ancienne.buffer).setUint32(8, 1, true);
  const relue = decoderRacine(ancienne, { tailleVolume: TAILLE_VOLUME });
  assert.equal(relue.valide, false);
  assert.match(relue.raison, /format/i);
});

test("une racine de format 5 publie DEUX compteurs, et se relit pour ce qu'elle est (#182)", () => {
  const octets = encoderRacine(
    racineValide({
      format: GENERATION_FORMAT_DEUX_COMPTEURS,
      scellementsCumulesVolume: 42,
      scellementsCumulesJournal: 7,
    }),
  );
  assert.equal(octets.byteLength, RACINE_OCTETS);
  assert.equal(
    RACINE_ENTETE_V5_OCTETS,
    210,
    "202 octets du format 4, plus les huit du compteur du journal : c'est un contrat",
  );

  const relue = decoderRacine(octets, { tailleVolume: TAILLE_VOLUME });
  assert.equal(relue.valide, true, relue.raison ?? "");
  assert.equal(relue.racine.format, GENERATION_FORMAT_DEUX_COMPTEURS);
  assert.equal(relue.racine.scellementsCumulesVolume, 42);
  assert.equal(relue.racine.scellementsCumulesJournal, 7);

  // Les 202 premiers octets sont ceux du format 4, INCHANGÉS : ce qui est déjà sur un support se
  // relit à la même place, et c'est ce qui rend l'ajout compatible plutôt que destructeur.
  const quatre = encoderRacine(racineValide());
  assert.deepEqual(
    [...octets.subarray(16, RACINE_ENTETE_OCTETS)],
    [...quatre.subarray(16, RACINE_ENTETE_OCTETS)],
    "seul le champ de format et la queue changent entre une racine 4 et une racine 5",
  );
});

test("une racine de format 5 SANS son second compteur est refusée à l'encodage (#182)", () => {
  // Le journal a sa propre clé depuis #182, donc son propre budget. Une racine qui ne le publierait
  // pas rendrait ce budget invérifiable — c'est-à-dire referait exactement le défaut que #182 corrige.
  const { scellementsCumulesJournal, ...sansLeChamp } = racineValide({
    format: GENERATION_FORMAT_DEUX_COMPTEURS,
    scellementsCumulesJournal: 7,
  });
  assert.equal(scellementsCumulesJournal, 7);
  assert.throws(() => encoderRacine(sansLeChamp), /obligatoire/);
});

test("le format écrit suit la version du VOLUME, et les deux nombres se recoupent (#182)", () => {
  assert.equal(formatEcritSousFraicheur(true, 3), GENERATION_FORMAT);
  assert.equal(formatEcritSousFraicheur(true, 4), GENERATION_FORMAT_DEUX_COMPTEURS);
  assert.equal(formatEcritSousFraicheur(false, 3), GENERATION_FORMAT_SANS_FRAICHEUR);
  // Les deux modules nomment la même frontière, et une seule d'entre elles est la bonne : on les
  // confronte ici plutôt que de laisser l'un importer l'autre — un module du journal qui
  // dépendrait de la disposition du volume serait un module de volume.
  assert.equal(FORMAT_DE_VOLUME_A_DEUX_COMPTEURS, FORMAT_VOLUME_V4);
});

test("un octet retourné dans un champ de LOCALISATION est refusé SANS clé", () => {
  // Marqueur, format, taille de secteur : ils ne sont pas dans les données associées, et c'est
  // délibéré — ils localisent, ils n'autorisent pas. Le module doit donc les refuser lui-même.
  const octets = encoderRacine(racineValide());
  for (const position of [0, 4, 12]) {
    const abimee = Uint8Array.from(octets);
    abimee[position] ^= 0x01;
    const relue = decoderRacine(abimee, { tailleVolume: TAILLE_VOLUME });
    assert.equal(relue.valide, false, `l'octet ${position} doit invalider la racine`);
    assert.match(relue.raison, /\S/);
  }
});

test("un format RETOURNÉ vers un format connu ne change RIEN de ce que le lecteur fait", async () => {
  // **Ce que #182 a changé ici, et qu'il vaut mieux écrire que découvrir.** Tant que 5 était un
  // format inconnu, un bit retourné dans le champ de format faisait 4 → 5 et le décodeur refusait
  // sans clé. Depuis que la v4 écrit du format 5, ce refus-là tombe : les deux nombres sont connus.
  //
  // Ce qui le remplace n'est pas une garde, c'est une ABSENCE DE CONSÉQUENCE, et elle se mesure.
  // Le nombre de champs des données associées suit la version de VOLUME — champ 3, AUTHENTIFIÉ — et
  // non cet octet-ci : `Scellement#ouvrirRacine` pose le second compteur d'après elle, et le retire
  // quand le volume n'en a qu'un. Un bit retourné entre 4 et 5 ne déplace donc ni l'étiquette de
  // domaine des enregistrements — `enregistrementsSousIdentiteDeBloc` rend faux pour les deux — ni
  // le nombre de champs scellés. La racine s'ouvre, et c'est le verdict juste.
  const scellement = await Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: CLE_DE_TEST,
    formatVersion: 3,
  });
  const scelle = await scellement.scellerRacine(
    { sequence: 5, generation: 3, tailleVolume: TAILLE_VOLUME },
    [],
    { sequencePrecedente: null },
  );
  const octets = encoderRacine({
    format: GENERATION_FORMAT,
    sequence: 5,
    generation: 3,
    tailleVolume: TAILLE_VOLUME,
    nombreEntrees: scelle.entete.nombreEntrees,
    longueurCharge: scelle.entete.longueurCharge,
    identifiantVolume: identifiantVolumeEnOctets(IDENTIFIANT),
    scellementsCumulesVolume: scelle.entete.scellementsCumulesVolume,
    nonce: scelle.nonce,
    chiffre: scelle.chiffre,
    etiquette: scelle.etiquette,
    // Une fraîcheur est POSÉE : sans elle le format écrit serait celui de #18, et le bit retourné
    // ne ferait pas le saut qu'on veut mesurer.
    fraicheur: motif(FRAICHEUR_OCTETS, 9),
  });

  const abimee = Uint8Array.from(octets);
  abimee[8] ^= 0x01; // 4 → 5
  const relue = decoderRacine(abimee, { tailleVolume: TAILLE_VOLUME });
  assert.equal(relue.valide, true, "le format 5 est CONNU : le décodeur le rend");
  assert.equal(relue.racine.format, GENERATION_FORMAT_DEUX_COMPTEURS);
  assert.equal(
    enregistrementsSousIdentiteDeBloc(relue.racine.format),
    enregistrementsSousIdentiteDeBloc(GENERATION_FORMAT),
    "les deux formats scellent les enregistrements sous la même étiquette de domaine",
  );

  const ouverte = await scellement.ouvrirRacine(
    {
      sequence: relue.racine.sequence,
      generation: relue.racine.generation,
      tailleVolume: relue.racine.tailleVolume,
      nombreEntrees: relue.racine.nombreEntrees,
      longueurCharge: relue.racine.longueurCharge,
      scellementsCumulesVolume: relue.racine.scellementsCumulesVolume,
      // Ce que le décodeur a lu dans la RÉSERVE, présenté tel quel. Le scellement le retire, parce
      // que ce volume est un v3 : c'est la version AUTHENTIFIÉE qui décide, pas l'octet 8.
      scellementsCumulesJournal: relue.racine.scellementsCumulesJournal,
    },
    relue.racine.scelle,
    [],
    { tailleVolume: TAILLE_VOLUME, sequenceMinimale: null },
  );
  assert.equal(ouverte.entete.sequence, 5);
});

test("une racine à UN seul compteur est refusée par un volume v4 : pas de budget complété par zéro", async () => {
  const scellement = await Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V4,
  });
  const scelle = await scellement.scellerRacine(
    { sequence: 1, generation: 1, tailleVolume: TAILLE_VOLUME },
    [],
    { sequencePrecedente: null },
  );
  const entete = {
    sequence: 1,
    generation: 1,
    tailleVolume: TAILLE_VOLUME,
    nombreEntrees: scelle.entete.nombreEntrees,
    longueurCharge: scelle.entete.longueurCharge,
    scellementsCumulesVolume: scelle.entete.scellementsCumulesVolume,
    scellementsCumulesJournal: scelle.entete.scellementsCumulesJournal,
  };
  // Témoin positif : complète, elle s'ouvre.
  await scellement.ouvrirRacine(entete, scelle, [], {
    tailleVolume: TAILLE_VOLUME,
    sequenceMinimale: null,
  });

  await assert.rejects(
    () =>
      scellement.ouvrirRacine(
        { ...entete, scellementsCumulesJournal: null },
        scelle,
        [],
        { tailleVolume: TAILLE_VOLUME, sequenceMinimale: null },
      ),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt),
  );
});

test("un volume v4 sans source de fraîcheur ne peut pas écrire de racine, et le dit", () => {
  // La combinaison n'a aucun encodage : onze champs dans les données associées, et pas de place sur
  // le disque pour le second compteur. La refuser vaut mieux que d'écrire une racine illisible.
  assert.throws(() => formatEcritSousFraicheur(false, FORMAT_VOLUME_V4), /fraîcheur/);
});

test("une racine de format 4 dont la place du second compteur n'est pas nulle est refusée", () => {
  // Le miroir de la garde que #19 a posée sur la fraîcheur : ce runtime n'écrit jamais l'un sans
  // l'autre, et un format qui SE DIT à un compteur au-dessus d'octets non nuls dans la place du
  // second ne peut pas avoir été écrit ainsi. Sans cette garde, un bit retourné 5 → 4 masquerait
  // un compteur de journal que plus rien ne relirait.
  const octets = encoderRacine(
    racineValide({
      format: GENERATION_FORMAT_DEUX_COMPTEURS,
      scellementsCumulesJournal: 7,
    }),
  );
  const abimee = Uint8Array.from(octets);
  abimee[8] ^= 0x01; // 5 → 4
  const relue = decoderRacine(abimee, { tailleVolume: TAILLE_VOLUME });
  assert.equal(relue.valide, false);
  assert.match(relue.raison, /compteur/i);
});

test("un octet retourné dans un champ AUTHENTIFIÉ se décode encore, et c'est l'étiquette qui refuse", async () => {
  // Le module de format n'a pas la clé : prétendre refuser ici serait deviner. Le refus vient de
  // `ouvrirRacine`, sur les données associées — et il vient à coup sûr, ce que cette épreuve montre
  // plutôt qu'elle ne l'affirme.
  const scellement = await Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: CLE_DE_TEST,
    formatVersion: 3,
  });
  const entrees = [];
  const scelle = await scellement.scellerRacine(
    { sequence: 5, generation: 3, tailleVolume: TAILLE_VOLUME },
    entrees,
    { sequencePrecedente: null },
  );
  const octets = encoderRacine({
    sequence: 5,
    generation: 3,
    tailleVolume: TAILLE_VOLUME,
    nombreEntrees: scelle.entete.nombreEntrees,
    longueurCharge: scelle.entete.longueurCharge,
    identifiantVolume: identifiantVolumeEnOctets(IDENTIFIANT),
    scellementsCumulesVolume: scelle.entete.scellementsCumulesVolume,
    nonce: scelle.nonce,
    chiffre: scelle.chiffre,
    etiquette: scelle.etiquette,
    // Cette épreuve porte sur les champs AUTHENTIFIÉS de l'en-tête, pas sur la fraîcheur : elle
    // déclare donc n'en sceller aucune plutôt que d'en fabriquer une qui brouillerait le verdict.
    fraicheur: null,
  });

  const ouvrir = (source) => {
    const relue = decoderRacine(source, { tailleVolume: TAILLE_VOLUME });
    assert.equal(relue.valide, true, "le champ authentifié se DÉCODE : seule l'étiquette juge");
    return scellement.ouvrirRacine(
      {
        sequence: relue.racine.sequence,
        generation: relue.racine.generation,
        tailleVolume: relue.racine.tailleVolume,
        nombreEntrees: relue.racine.nombreEntrees,
        longueurCharge: relue.racine.longueurCharge,
        scellementsCumulesVolume: relue.racine.scellementsCumulesVolume,
      },
      relue.racine.scelle,
      entrees,
      { tailleVolume: TAILLE_VOLUME, sequenceMinimale: null },
    );
  };

  await ouvrir(octets); // témoin positif : intacte, elle s'ouvre.

  // Séquence, génération, compteur de scellements, nonce, chiffré, étiquette.
  //
  // L'IDENTIFIANT DE VOLUME (octet 52) n'est PAS dans cette liste, et c'est une propriété qu'il vaut
  // mieux écrire que découvrir : la valeur qui entre dans les données associées est celle que le
  // MANIFESTE déclare, pas celle qu'on lit sur le disque. Retourner la copie sur disque ne change
  // donc pas l'étiquette. Elle n'est pas crue pour autant : `generation-store.mjs` la CONFRONTE à
  // l'identité du manifeste et refuse l'écart par `VAULT_STORAGE_IDENTITE_VOLUME`. La copie sur
  // disque est un localisateur, pas une autorité — exactement comme l'en-tête v3 (ADR 0016).
  for (const position of [16, 24, 68, 76, 88, 120]) {
    const abimee = Uint8Array.from(octets);
    abimee[position] ^= 0x01;
    await assert.rejects(
      () => ouvrir(abimee),
      (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
      `l'octet ${position} aurait dû être refusé par l'étiquette`,
    );
  }
});

test("une racine dont l'en-tête est tronqué par une déchirure n'est jamais une racine", () => {
  const octets = encoderRacine(racineValide());
  for (const atteints of [8, 40, RACINE_ENTETE_OCTETS - 1]) {
    const tronquee = new Uint8Array(RACINE_OCTETS);
    tronquee.set(octets.subarray(0, atteints));
    const relue = decoderRacine(tronquee, { tailleVolume: TAILLE_VOLUME });
    // Une troncature dans un champ authentifié laisse un en-tête DÉCODABLE mais des octets nuls là
    // où le sceau vivait : l'étiquette ne vérifiera pas. Ce que l'épreuve exige est donc qu'aucune
    // troncature ne rende une racine à la fois décodable ET munie de ses deux sceaux d'origine —
    // celui de l'en-tête, et celui de la fraîcheur de région que #19 ajoute derrière lui. Une
    // déchirure à 201 octets laisse l'étiquette intacte et ampute la fraîcheur : c'est la
    // confrontation de région qui refuse alors, et le format doit le rendre visible.
    const ampute = (depuis, longueur) =>
      relue.valide &&
      Array.from({ length: longueur }).some(
        (_, index) => tronquee[depuis + index] !== octets[depuis + index],
      );
    const perdu =
      !relue.valide || ampute(120, 16) || ampute(RACINE_ENTETE_V2_OCTETS, FRAICHEUR_OCTETS);
    assert.ok(perdu, `${atteints} octet(s) atteints ne doivent pas rendre une racine complète`);
  }
});

test("une déchirure AU-DELÀ de l'en-tête ne fait rien perdre, et le format le dit", () => {
  // Le reste du secteur est une réserve de zéros : elle ne porte aucune information. Une racine dont
  // seuls les 136 premiers octets ont atteint le support est donc COMPLÈTE, et la traiter comme
  // abîmée refuserait une génération parfaitement validée. C'est une propriété du format, pas un
  // trou de la vérification — et elle est écrite ici pour ne pas être découverte en production.
  const octets = encoderRacine(racineValide());
  const partielle = new Uint8Array(RACINE_OCTETS);
  partielle.set(octets.subarray(0, RACINE_ENTETE_OCTETS));
  const relue = decoderRacine(partielle, { tailleVolume: TAILLE_VOLUME });
  assert.equal(relue.valide, true);
  assert.equal(relue.racine.generation, 3);
  assert.deepEqual(
    [...octets.subarray(RACINE_ENTETE_OCTETS)],
    [...new Uint8Array(RACINE_OCTETS - RACINE_ENTETE_OCTETS)],
  );
});

test("une racine écrite pour un autre volume est refusée, pas adoptée", () => {
  const octets = encoderRacine(racineValide());
  const relue = decoderRacine(octets, { tailleVolume: TAILLE_VOLUME * 2 });
  assert.equal(relue.valide, false);
  assert.match(relue.raison, /taille/i);
});

test("un secteur vierge est une absence de racine, pas une corruption", () => {
  const relue = decoderRacine(new Uint8Array(RACINE_OCTETS), { tailleVolume: TAILLE_VOLUME });
  assert.equal(relue.valide, false);
  assert.equal(relue.vierge, true);
});

test("les deux racines alternent, et une validation n'écrase jamais celle qui fait autorité", () => {
  assert.equal(RACINES, 2);
  assert.equal(racineDeSequence(1), 1 % RACINES);
  assert.notEqual(racineDeSequence(1), racineDeSequence(2));
  assert.equal(offsetDeRacine(0), 0);
  // Une PAGE HÔTE sépare les deux emplacements, pas un secteur : refuser l'atomicité sectorielle
  // tout en supposant qu'une écriture n'abîme pas le secteur voisin de la même page serait
  // incohérent. L'hypothèse qui reste — deux pages distinctes ne tombent pas ensemble — est écrite
  // dans l'ADR 0014.
  assert.equal(offsetDeRacine(1), PAGE_HOTE_OCTETS);
  assert.ok(PAGE_HOTE_OCTETS > RACINE_OCTETS);
});

test("l'en-tête d'un enregistrement porte son offset logique et sa longueur", () => {
  const entete = encoderEnteteEnregistrement({ offset: 4096, longueur: 512 });
  assert.equal(entete.byteLength, ENTETE_OCTETS);
});

test("le surcoût d'un enregistrement est FIXE, et la longueur physique s'en déduit", () => {
  // Deux grandeurs stockées peuvent diverger ; une grandeur dérivée ne le peut pas. C'est la raison
  // pour laquelle la racine ne stocke que la longueur des CLAIRS (ADR 0016, décision 3).
  assert.equal(SURCOUT_ENREGISTREMENT, ENTETE_OCTETS + 34);
  assert.equal(SURCOUT_ENREGISTREMENT, 50);
  assert.equal(
    longueurPhysiqueDeCharge({ nombreEntrees: 3, longueurCharge: 1536 }),
    1536 + 3 * SURCOUT_ENREGISTREMENT,
  );
  assert.equal(longueurPhysiqueDeCharge({ nombreEntrees: 0, longueurCharge: 0 }), 0);
});

test("un sceau de racine incomplet est refusé À L'ENCODAGE : jamais complété par des zéros", () => {
  for (const champ of ["nonce", "chiffre", "etiquette", "identifiantVolume"]) {
    assert.throws(
      () => encoderRacine(racineValide({ [champ]: new Uint8Array(3) })),
      RangeError,
      `« ${champ} » tronqué aurait dû être refusé`,
    );
  }
});
