import { expect, test } from "../support/test.mjs";

// FRONTIÈRE de la HIÉRARCHIE DE CLÉS, sur les trois moteurs (#182, ADR 0033 décision 6 ; `SEC-KEY-001`).
//
// L'ADR 0033 écrit un **GARANTI**, au vocabulaire de la décision 7 de l'ADR 0021 : « la DEK ne peut
// pas chiffrer ». Ce n'est pas une discipline du dépôt, c'est un refus de la PLATE-FORME — une
// `CryptoKey` dont les usages ne portent pas `encrypt` fait rejeter `crypto.subtle.encrypt` par la
// spécification WebCrypto elle-même.
//
// **Un GARANTI qui repose sur la plate-forme se mesure SUR la plate-forme**, et sur les trois, pas
// sur celle du développeur. Une suite sous Node dirait ce que `node:crypto` fait ; ce que le produit
// exécute est le WebCrypto d'un moteur de navigateur, dans un contexte sécurisé. Si un seul des
// trois acceptait `encrypt` sur un matériau HKDF, la phrase de l'ADR serait fausse pour un tiers des
// utilisateurs, et le dépôt l'écrirait quand même.
//
// Ces épreuves n'ont besoin d'aucun artefact v86, ne touchent aucun stockage et durent quelques
// secondes : les trois moteurs de la matrice #2 sont donc TOUJOURS exécutés, exactement comme la
// frontière de CSP, et indépendamment de `VAULT_MOTEURS`.
//
// Ce qu'elles ne mesurent PAS : que le produit importe bien la DEK ainsi. C'est
// `tests/unit/vm-hierarchie-de-cles.test.mjs` et la campagne de mutation
// `tools/muter-gardes-hierarchie-de-cles.mjs` qui le tiennent. Ici, on mesure la PLATE-FORME.

/** Trente-deux octets publics, sans entropie : la clé de TEST du dépôt. Elle ne protège rien. */
const CLE = Array.from({ length: 32 }, (_, index) => index);

/** L'info d'un domaine, posée à la main dans la page : elle n'a pas à être la bonne, ici. */
const INFO = Array.from({ length: 16 }, (_, index) => index * 3);

test.beforeEach(async ({ page }) => {
  // N'importe quelle page servie fait l'affaire : ce qui compte est le CONTEXTE SÉCURISÉ, sans
  // lequel `crypto.subtle` n'existe pas. On ne charge aucun banc, aucun Worker, aucun volume.
  await page.goto("/");
  expect(
    await page.evaluate(() => globalThis.isSecureContext && typeof crypto?.subtle === "object"),
    "le contexte doit être sécurisé et offrir crypto.subtle",
  ).toBe(true);
});

test("la DEK importée en matériau HKDF n'a QUE l'usage `deriveKey`", async ({ page }) => {
  const rendu = await page.evaluate(async (octets) => {
    const cle = await crypto.subtle.importKey("raw", new Uint8Array(octets), "HKDF", false, [
      "deriveKey",
    ]);
    return {
      algorithme: cle.algorithm.name,
      usages: [...cle.usages],
      extractible: cle.extractable,
    };
  }, CLE);

  expect(rendu.algorithme).toBe("HKDF");
  expect(rendu.usages).toEqual(["deriveKey"]);
  expect(rendu.extractible, "une clé maîtresse ne sort jamais de WebCrypto").toBe(false);
});

test("crypto.subtle.encrypt REFUSE la DEK importée en matériau HKDF — le GARANTI de l'ADR 0033", async ({
  page,
}) => {
  const rendu = await page.evaluate(async (octets) => {
    const materiau = await crypto.subtle.importKey("raw", new Uint8Array(octets), "HKDF", false, [
      "deriveKey",
    ]);
    try {
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: new Uint8Array(12) },
        materiau,
        new Uint8Array(64),
      );
      return { refuse: false, nom: null };
    } catch (erreur) {
      return { refuse: true, nom: erreur?.name ?? String(erreur) };
    }
  }, CLE);

  expect(
    rendu.refuse,
    "ce moteur a CHIFFRÉ sous la clé maîtresse : le GARANTI de l'ADR 0033, décision 6, est faux ici",
  ).toBe(true);
  // Le NOM de l'erreur n'est pas épinglé : la spécification WebCrypto laisse le choix entre
  // `InvalidAccessError` et `NotSupportedError` selon l'étape qui refuse, et exiger l'un des deux
  // ferait rougir cette suite sur un moteur parfaitement conforme. Ce qui est épinglé est le REFUS.
  expect(rendu.nom, "le refus doit porter un nom").toBeTruthy();
});

test("la même DEK importée en AES-GCM chiffre, elle : le refus vient des USAGES, pas des octets", async ({
  page,
}) => {
  // TÉMOIN POSITIF, et il est indispensable. Sans lui, un moteur qui refuserait `encrypt` pour une
  // tout autre raison — un tampon vide, un nonce interdit, une politique — passerait pour tenir le
  // GARANTI. Les MÊMES octets, importés avec `encrypt` dans leurs usages, doivent chiffrer.
  const rendu = await page.evaluate(async (octets) => {
    const cle = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(octets),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    const scelle = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(12) },
      cle,
      new Uint8Array(64),
    );
    return { octets: scelle.byteLength };
  }, CLE);

  expect(rendu.octets, "64 octets de clair, plus les 16 de l'étiquette").toBe(80);
});

test("le matériau HKDF DÉRIVE, et deux infos distinctes tirent deux clés distinctes", async ({
  page,
}) => {
  // La seconde moitié du GARANTI : interdire de chiffrer ne servirait à rien si la dérivation ne
  // séparait pas. Le moteur doit rendre deux clés différentes pour deux infos différentes, et il le
  // montre par la seule voie qui n'extrait rien — sceller sous l'une, échouer à ouvrir sous l'autre.
  const rendu = await page.evaluate(
    async ({ octets, info }) => {
      const materiau = await crypto.subtle.importKey("raw", new Uint8Array(octets), "HKDF", false, [
        "deriveKey",
      ]);
      const deriver = (suffixe) =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(0),
            info: new Uint8Array([...info, suffixe]),
          },
          materiau,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );

      const premiere = await deriver(1);
      const seconde = await deriver(2);
      const nonce = new Uint8Array(12);
      const clair = new Uint8Array(64).fill(7);
      const scelle = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, premiere, clair);

      const relu = await crypto.subtle
        .decrypt({ name: "AES-GCM", iv: nonce }, premiere, scelle)
        .then((rendu) => new Uint8Array(rendu).every((octet) => octet === 7))
        .catch(() => false);
      const traverse = await crypto.subtle
        .decrypt({ name: "AES-GCM", iv: nonce }, seconde, scelle)
        .then(() => true)
        .catch(() => false);

      // Le SEL VIDE est celui des domaines à compteur (ADR 0033, décision 3) : ce moteur doit
      // l'accepter, faute de quoi aucun volume ne s'ouvrirait deux fois.
      return { relu, traverse, selVideAccepte: true };
    },
    { octets: CLE, info: INFO },
  );

  expect(
    rendu.selVideAccepte,
    "le sel VIDE doit être admis : c'est le régime d'un domaine à compteur",
  ).toBe(true);
  expect(rendu.relu, "ce qui est scellé sous une clé doit s'ouvrir sous elle").toBe(true);
  expect(
    rendu.traverse,
    "deux infos distinctes doivent tirer deux clés distinctes : rien ne traverse",
  ).toBe(false);
});
