/**
 * UN RÉ-ÉPINGLAGE, DE BOUT EN BOUT (#123, critère 4 — ADR 0003, ADR 0017, ADR 0023).
 *
 * Adresser par empreinte ne vaut que si la montée de version se déroule COMPLÈTEMENT : l'ancienne
 * adresse cesse d'être référencée ET d'être servie, la nouvelle est servie, l'inventaire de l'ADR
 * 0017 change de racine, et le retour arrière retrouve la racine d'avant au bit près.
 *
 * Ce fichier déroule cette séquence sur des arbres réels écrits dans un répertoire temporaire, avec
 * la vérification d'épinglage de la PUBLICATION — `verifierEpinglageV86`, celle qui rend le code 5
 * — et l'inventaire de la publication. Il ne simule ni l'une ni l'autre : une épreuve de
 * ré-épinglage qui réimplémenterait la règle ne mesurerait que sa propre copie.
 *
 * Ce qu'il ne prouve pas : aucun navigateur ne visite ces arbres. Le fait qu'un moteur GARDE
 * l'ancienne adresse un an, puis ne la demande plus, relève de #125 ; le fait qu'un hébergeur réel
 * serve la politique écrite relève de #124.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  adresseDe,
  empreinteDeLAdresse,
  nomAdresse,
  nomAdresseDuManifeste,
} from "../../src/v86-adresses.mjs";
import { empreinte, empreinteDeRacine, relever } from "../../tools/publier-inventaire.mjs";
import {
  SITUATIONS_EPINGLAGE,
  ecrireManifesteEpingle,
  verifierEpinglageV86,
} from "../../tools/publier-sources.mjs";

const encodeur = new TextEncoder();

/** Deux « versions » de l'émulateur : des octets, donc des empreintes, donc des adresses. */
const VERSIONS = {
  v1: { "libv86.mjs": "export const V86 = 1;\n", "v86.wasm": "\0asm-un" },
  v2: { "libv86.mjs": "export const V86 = 1;\n", "v86.wasm": "\0asm-deux" },
};

/** Le manifeste que l'ADR 0003 publierait pour une version : noms, tailles, empreintes. */
function manifestePour(version) {
  return {
    contract: { id: "railsbox-vault-vendor-v86", version: 1 },
    artifacts: Object.entries(VERSIONS[version]).map(([name, contenu]) => ({
      name,
      bytes: encodeur.encode(contenu).byteLength,
      sha256: empreinte(encodeur.encode(contenu)),
    })),
  };
}

/**
 * Écrit l'arbre publié d'une version : le manifeste à son adresse stable, les artefacts à leurs
 * adresses dérivées, et la copie du manifeste adressée par sa propre empreinte.
 *
 * `ecrireManifesteEpingle` est celui de la PUBLICATION : l'épreuve ne recopie pas sa règle.
 */
async function ecrireArbre(racine, version) {
  const manifeste = manifestePour(version);
  const dossier = join(racine, "vendor", "v86", "artefacts");
  await mkdir(dossier, { recursive: true });
  const texte = `${JSON.stringify(manifeste, null, 2)}\n`;
  await writeFile(join(racine, "vendor", "v86", "MANIFEST.json"), texte, "utf8");
  for (const [nom, contenu] of Object.entries(VERSIONS[version])) {
    const sha = empreinte(encodeur.encode(contenu));
    await writeFile(join(dossier, nomAdresse(nom, sha)), contenu, "utf8");
  }
  await ecrireManifesteEpingle(racine, empreinte);
  return manifeste;
}

async function nouvelleRacine() {
  return mkdtemp(join(tmpdir(), "vault-reepinglage-"));
}

async function racineDeLArbre(racine) {
  return empreinteDeRacine(await relever(racine, []));
}

test("un arbre fraîchement publié est conforme, et chaque octet servi nomme son empreinte", async () => {
  const racine = await nouvelleRacine();
  try {
    await ecrireArbre(racine, "v1");
    const verdict = await verifierEpinglageV86(racine, empreinte);
    assert.equal(verdict.verifie, true);
    assert.deepEqual(verdict.ecarts, []);

    const servis = await readdir(join(racine, "vendor", "v86", "artefacts"));
    assert.equal(servis.length, 3, "deux artefacts et la copie épinglée du manifeste");
    for (const nom of servis) {
      assert.ok(empreinteDeLAdresse(nom) !== null, `${nom} est servi sans nommer son empreinte`);
    }
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("après un ré-épinglage, l'ANCIENNE adresse n'est plus référencée et la NOUVELLE est servie", async () => {
  const racine = await nouvelleRacine();
  try {
    const avant = await ecrireArbre(racine, "v1");
    const ancienne = adresseDe(
      "v86.wasm",
      avant.artifacts.find((a) => a.name === "v86.wasm").sha256,
    );

    await rm(join(racine, "vendor"), { recursive: true, force: true });
    const apres = await ecrireArbre(racine, "v2");
    const nouvelle = adresseDe(
      "v86.wasm",
      apres.artifacts.find((a) => a.name === "v86.wasm").sha256,
    );

    assert.notEqual(nouvelle, ancienne);
    const servis = await relever(racine, []);
    const chemins = servis.map(({ chemin }) => `/${chemin}`);
    assert.ok(chemins.includes(nouvelle), "la nouvelle adresse n'est pas servie");
    assert.ok(!chemins.includes(ancienne), "l'ancienne adresse est encore servie");

    // L'artefact INCHANGÉ garde son adresse : c'est ce qui évite de re-télécharger tout l'ensemble
    // épinglé pour un octet, et c'est la moitié « seulement si » du critère 1.
    const inchange = adresseDe(
      "libv86.mjs",
      apres.artifacts.find((a) => a.name === "libv86.mjs").sha256,
    );
    assert.ok(chemins.includes(inchange));
    assert.equal(
      inchange,
      adresseDe("libv86.mjs", avant.artifacts.find((a) => a.name === "libv86.mjs").sha256),
    );

    assert.equal((await verifierEpinglageV86(racine, empreinte)).ecarts.length, 0);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("un ré-épinglage change l'empreinte de RACINE de l'inventaire (ADR 0017)", async () => {
  const racine = await nouvelleRacine();
  try {
    await ecrireArbre(racine, "v1");
    const racineV1 = await racineDeLArbre(racine);
    await rm(join(racine, "vendor"), { recursive: true, force: true });
    await ecrireArbre(racine, "v2");
    const racineV2 = await racineDeLArbre(racine);
    assert.notEqual(racineV1, racineV2);

    // RETOUR ARRIÈRE : republier la version d'avant, c'est retrouver sa racine AU BIT PRÈS. C'est
    // la propriété que `publication.yml` confronte à l'empreinte inscrite lors de la publication
    // d'alors, et l'adressage par empreinte ne doit pas la briser — une adresse qui dépendrait de
    // l'ordre du disque ou d'une date la briserait.
    await rm(join(racine, "vendor"), { recursive: true, force: true });
    await ecrireArbre(racine, "v1");
    assert.equal(await racineDeLArbre(racine), racineV1);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("un ré-épinglage INACHEVÉ est REFUSÉ : les octets d'hier restent sous une adresse d'hier", async () => {
  // C'est le mode de panne que l'adressage par empreinte ne doit pas rendre silencieux. Le
  // manifeste passe à v2 mais les octets de v1 traînent encore dans le répertoire : sans refus, un
  // fichier périmé serait servi UN AN sous `immutable`, sans révocation possible.
  const racine = await nouvelleRacine();
  try {
    await ecrireArbre(racine, "v1");
    const dossier = join(racine, "vendor", "v86", "artefacts");
    const restes = await readdir(dossier);
    await rm(join(racine, "vendor", "v86", "MANIFEST.json"));
    for (const nom of restes) {
      if (nom.startsWith("MANIFEST-")) await rm(join(dossier, nom));
    }
    const manifeste = manifestePour("v2");
    await writeFile(
      join(racine, "vendor", "v86", "MANIFEST.json"),
      `${JSON.stringify(manifeste, null, 2)}\n`,
      "utf8",
    );
    await ecrireManifesteEpingle(racine, empreinte);

    const verdict = await verifierEpinglageV86(racine, empreinte);
    const motifs = verdict.ecarts.map(({ artefact, motif }) => `${artefact} ${motif}`).join(" | ");
    assert.ok(
      verdict.ecarts.some(({ motif }) => motif.includes("absent")),
      `le nouvel artefact absent doit être un écart : ${motifs}`,
    );
    assert.ok(
      verdict.ecarts.some(({ motif }) => motif.includes("non déclaré")),
      `l'octet d'hier resté sous son adresse d'hier doit être un écart : ${motifs}`,
    );
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("un fichier dont le NOM ne correspond pas à ses octets est refusé", async () => {
  // Le cliquet qui autorise `immutable` : ce qui est servi sous le préfixe immuable nomme sa propre
  // empreinte, et cette empreinte est RECALCULÉE sur les octets. Renommer un fichier pour lui faire
  // porter l'adresse d'un autre — un déploiement partiel, un cache empoisonné, une main humaine —
  // est refusé avant que l'arbre ne parte.
  const racine = await nouvelleRacine();
  try {
    const manifeste = await ecrireArbre(racine, "v1");
    const dossier = join(racine, "vendor", "v86", "artefacts");
    const wasm = manifeste.artifacts.find((a) => a.name === "v86.wasm");
    await writeFile(join(dossier, nomAdresse("v86.wasm", wasm.sha256)), "\0asm-substitue", "utf8");
    const verdict = await verifierEpinglageV86(racine, empreinte);
    assert.ok(verdict.ecarts.some(({ motif }) => motif.includes("empreinte")));
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("la copie épinglée du manifeste est vérifiée comme les octets qu'elle nomme", async () => {
  // Elle est publiée sous `immutable` : elle doit donc, elle aussi, nommer sa propre empreinte et
  // décrire exactement le manifeste servi à l'adresse stable. Sinon un lecteur qui remonte d'une
  // adresse d'artefact au manifeste qui l'a nommée lirait un épinglage qui n'a jamais existé.
  const racine = await nouvelleRacine();
  try {
    await ecrireArbre(racine, "v1");
    const dossier = join(racine, "vendor", "v86", "artefacts");
    const nom = (await readdir(dossier)).find((entree) => entree.startsWith("MANIFEST-"));
    assert.ok(nom !== undefined, "la copie épinglée du manifeste doit être publiée");
    assert.equal(nom, nomAdresseDuManifeste(empreinteDeLAdresse(nom).padEnd(64, "0")));

    await writeFile(join(dossier, nom), "{}\n", "utf8");
    const verdict = await verifierEpinglageV86(racine, empreinte);
    assert.ok(verdict.ecarts.some(({ artefact }) => artefact === nom));
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("un CLONE VIERGE reste une INCOMPLÉTUDE, jamais une rupture d'épinglage", async () => {
  // Le piège que #123 pose et referme. Avant l'adressage par empreinte, l'incomplétude se
  // reconnaissait à l'absence du RÉPERTOIRE d'artefacts. Depuis que la publication y dépose la copie
  // épinglée du manifeste, ce répertoire existe toujours : un verdict fondé sur son existence
  // rendrait « ÉPINGLAGE ROMPU » (code 5) à tout `npm run check` lancé sans `npm run vm:fetch` —
  // c'est-à-dire au cas ORDINAIRE, celui de l'intégration continue. C'est le CONTENU qui décide.
  const racine = await nouvelleRacine();
  try {
    const manifeste = manifestePour("v1");
    await mkdir(join(racine, "vendor", "v86", "artefacts"), { recursive: true });
    await writeFile(
      join(racine, "vendor", "v86", "MANIFEST.json"),
      `${JSON.stringify(manifeste, null, 2)}
`,
      "utf8",
    );
    await ecrireManifesteEpingle(racine, empreinte);

    const verdict = await verifierEpinglageV86(racine, empreinte);
    assert.equal(verdict.situation, SITUATIONS_EPINGLAGE.artefactsAbsents);
    assert.deepEqual(verdict.ecarts, [], "une absence de runtime n'est pas un écart d'épinglage");
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("un intrus est refusé MÊME dans un arbre incomplet", async () => {
  // Le corollaire : la tolérance à l'incomplétude ne doit pas devenir une tolérance à ce qui traîne.
  // Un fichier déposé sous le préfixe immuable partirait chez l'hébergeur pour un an, que le runtime
  // soit là ou non.
  const racine = await nouvelleRacine();
  try {
    const manifeste = manifestePour("v1");
    const dossier = join(racine, "vendor", "v86", "artefacts");
    await mkdir(dossier, { recursive: true });
    await writeFile(
      join(racine, "vendor", "v86", "MANIFEST.json"),
      `${JSON.stringify(manifeste, null, 2)}
`,
      "utf8",
    );
    await ecrireManifesteEpingle(racine, empreinte);
    await writeFile(join(dossier, "trace-de-debogage.bin"), "ce qui traîne sur un poste", "utf8");

    const verdict = await verifierEpinglageV86(racine, empreinte);
    assert.equal(verdict.ecarts.length, 1);
    assert.equal(verdict.ecarts[0].artefact, "trace-de-debogage.bin");
    assert.match(verdict.ecarts[0].motif, /non déclaré/i);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("deux octets qui réclameraient la MÊME adresse sont refusés", async () => {
  // La table des attendus est indexée par ADRESSE : sans ce refus, la seconde entrée écraserait la
  // première, et l'artefact perdu ne serait plus exigé de personne — son absence deviendrait
  // invisible, sous une classe de cache d'un an. Le cas est improbable (collision sur 64 bits, ou
  // manifeste qui déclare deux fois le même nom) et c'est exactement pour cela qu'il se mesure : la
  // troncature invite à ne pas le regarder.
  const racine = await nouvelleRacine();
  try {
    const contenu = "des octets";
    const sha256 = empreinte(encodeur.encode(contenu));
    const manifeste = {
      artifacts: [
        { name: "v86.wasm", bytes: contenu.length, sha256 },
        { name: "v86.wasm", bytes: contenu.length, sha256 },
      ],
    };
    const dossier = join(racine, "vendor", "v86", "artefacts");
    await mkdir(dossier, { recursive: true });
    await writeFile(join(dossier, nomAdresse("v86.wasm", sha256)), contenu, "utf8");
    await writeFile(
      join(racine, "vendor", "v86", "MANIFEST.json"),
      `${JSON.stringify(manifeste, null, 2)}\n`,
      "utf8",
    );
    await ecrireManifesteEpingle(racine, empreinte);

    const verdict = await verifierEpinglageV86(racine, empreinte);
    assert.ok(
      verdict.ecarts.some(({ motif }) => motif.includes("la même adresse")),
      `la collision d'adresse doit être refusée : ${JSON.stringify(verdict.ecarts)}`,
    );
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});
