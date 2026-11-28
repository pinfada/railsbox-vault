/**
 * Les DÉCISIONS du relais HTTP (#192, ADR 0038), mesurées sans navigateur et sans machine virtuelle.
 *
 * Ce que ce fichier juge : ce qu'une requête relayée a le droit d'être, ce qu'une réponse relayée a
 * le droit de montrer, ce que le bocal à cookies retient, et ce qu'une `Location` devient. Ce qu'il
 * ne juge pas : le branchement — le Worker, le canal de relais, le Service Worker et le courtier
 * sont mesurés par `tests/browser/coquille-service-applicatif.spec.mjs` (trois moteurs) et par
 * `tests/e2e/parcours-page-rails.spec.mjs` (une page Rails réelle).
 *
 * La règle que tout le fichier vérifie, sous six formes : **rien ne traverse qui n'ait été NOMMÉ**.
 * C'est l'inverse de ce qu'un proxy fait d'ordinaire — recopier et retirer ce qui gêne —, et
 * l'inversion est le point : une liste de retraits est une liste qu'on oublie d'allonger.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHEMINS_DE_LA_COQUILLE_DE_CADRE,
  ENTETES_DE_REPONSE_RENDUES,
  ENTETES_DE_REQUETE_RELAYEES,
  METHODES_RELAYEES,
  PLAFOND_CORPS_DE_REQUETE_OCTETS,
  PLAFOND_CORPS_DE_REPONSE_OCTETS,
  cheminRelayable,
  creerBocalDeCookies,
  emplacementRendu,
  entetesDeReponseRendues,
  entetesDeRequeteRelayees,
  estUnCheminDeLaCoquilleDeCadre,
  evaluerRequeteRelayee,
  tailleEnBase64,
  DELAI_RELAIS_COQUILLE_MS,
  ENTETES_DE_L_HEBERGEUR_APPLICATIF,
  relaisAbandonne,
} from "../../src/coquille/relais-http.mjs";
import { cheminApplicatifAdmis } from "../../src/coquille/origines-de-la-coquille.mjs";
import {
  CODES_REFUS_COQUILLE,
  codeDeRefusAdmis,
  messageDeRefus,
} from "../../src/coquille/refus-de-coquille.mjs";
import { DELAI_DU_COURTIER_MS, ENTETES_RELEVEES } from "../../public/cadre/contrat-du-cadre.mjs";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../../src/vm/serial-http-client.mjs";
import { securityHeaders } from "../../tools/serve-headers.mjs";

const ORIGINE = "http://127.0.0.1";

/** Une requête relayée BIEN FORMÉE. Les épreuves en dérivent leurs cas en changeant UN champ. */
function requete(champs = {}) {
  return { methode: "GET", chemin: "/", entetes: {}, corps: null, ...champs };
}

// --- Les méthodes, les chemins, les corps ---------------------------------------------------------

test("les méthodes relayées sont TROIS, et tout le reste est refusé", () => {
  assert.deepEqual([...METHODES_RELAYEES], ["GET", "POST", "HEAD"]);
  for (const methode of ["GET", "POST", "HEAD", "get", "post"]) {
    assert.equal(evaluerRequeteRelayee(requete({ methode })).ok, true, methode);
  }
  for (const methode of ["PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", ""]) {
    assert.equal(evaluerRequeteRelayee(requete({ methode })).ok, false, methode);
  }
});

test("un chemin cesse d'être un chemin dès qu'il déplace ce que le guest sert", () => {
  assert.equal(cheminRelayable("/"), "/");
  assert.equal(cheminRelayable("/notes/42?filtre=a#b"), "/notes/42?filtre=a#b");
  // Les trois formes qui déplaceraient l'origine, et que l'ADR 0028 refuse déjà pour le chemin
  // ENCADRÉ : une URL relative au schéma, une URL absolue, une barre inversée.
  assert.equal(cheminRelayable("//exemple.test/"), null);
  assert.equal(cheminRelayable("https://exemple.test/"), null);
  assert.equal(cheminRelayable("/a\\b"), null);
  // Et ce qui n'est pas un chemin du tout.
  assert.equal(cheminRelayable("notes"), null);
  assert.equal(cheminRelayable(""), null);
  assert.equal(cheminRelayable(null), null);
  assert.equal(cheminRelayable(`/${"a".repeat(4096)}`), null);
});

test("un caractère de CONTRÔLE dans un chemin est une seconde ligne de requête HTTP", () => {
  // Ce n'est pas une coquetterie d'encodage : le pont série compose une requête HTTP à partir de ce
  // chemin, et un retour chariot y écrirait une ligne que personne n'a demandée.
  assert.equal(cheminRelayable("/notes\r\nX-Injecte: oui"), null);
  assert.equal(cheminRelayable("/notes\n"), null);
  assert.equal(cheminRelayable("/notes\u0000"), null);
  assert.equal(cheminRelayable("/notes\u007f"), null);
});

test("une ESPACE dans un chemin est refusée comme le pont la refuse (revue #203, constat 12)", () => {
  // Le pont la refuse (`serial-bridge.py`), et une garde qui l'admettrait rendrait un refus MUET
  // (`GESTE_ROMPU`) là où le § 10.5 promet `REQUETE_HTTP_REFUSEE`.
  assert.equal(cheminRelayable("/a HTTP/1.1"), null);
  assert.equal(cheminRelayable("/a?b=c d"), null);
});

/** La barre INVERSÉE, écrite par son code : un littéral qui la porte se relit mal. */
const BARRE_INVERSEE = String.fromCharCode(0x5c);

test("un chemin qui se NORMALISE en une autre origine n'est pas un chemin (revue #203, constat 4)", () => {
  // Les formes du relecteur : elles commencent par UNE barre, et se replient pourtant en `//…`.
  for (const detour of ["/..//evil.test/", "/./..//evil.test", "/..//evil.test?a=1"]) {
    assert.equal(cheminRelayable(detour), null, detour);
  }
  // Leurs variantes : un séparateur ou un point ENCODÉS, une barre inversée, un segment vide ou
  // repliable n'importe où dans le chemin.
  for (const detour of [
    "/..%2F/evil.test",
    "/%2F%2Fevil.test",
    "/%2e%2e//evil.test",
    "/%5Cevil.test",
    `/a/..${BARRE_INVERSEE}evil.test`,
    "/a//b",
    "/a/./b",
    "/a/../b",
    "/a/.",
    "/a/..",
  ]) {
    assert.equal(cheminRelayable(detour), null, detour);
  }
  // Ce qui reste un chemin ordinaire, et doit le rester : un segment final vide, des points dans un
  // nom, un séparateur encodé dans la REQUÊTE, que la normalisation ne replie pas.
  assert.equal(cheminRelayable("/notes/"), "/notes/");
  assert.equal(cheminRelayable("/vault.css"), "/vault.css");
  assert.equal(cheminRelayable("/a..b/c.d"), "/a..b/c.d");
  assert.equal(cheminRelayable("/?retour=%2Fnotes%2F42"), "/?retour=%2Fnotes%2F42");
});

test("le chemin du document ENCADRÉ suit la même règle que le chemin relayé", () => {
  for (const detour of ["/..//evil.test/", "/..%2Fevil.test", "/a//b", "/a b"]) {
    assert.equal(cheminApplicatifAdmis(detour), null, detour);
  }
  assert.equal(cheminApplicatifAdmis("/document-applicatif.html"), "/document-applicatif.html");
});

test("un refus posté depuis un gestionnaire d'erreur ne JETTE jamais (revue #203, constat 3)", () => {
  // Une `DOMException` d'`atob` porte `code: 5` : c'est ce code-là qui faisait jeter
  // `messageDeRefus` dans le chemin de refus du Worker, et laissait la corrélation sans réponse.
  for (const etranger of [5, "5", null, undefined, "VAULT_INVENTE", { code: 1 }]) {
    const code = codeDeRefusAdmis(etranger);
    assert.equal(code, CODES_REFUS_COQUILLE.gesteRompu);
    assert.doesNotThrow(() => messageDeRefus(code));
  }
  assert.equal(
    codeDeRefusAdmis(CODES_REFUS_COQUILLE.tropDeRequetes),
    CODES_REFUS_COQUILLE.tropDeRequetes,
  );
});

test("une valeur d'en-tête de RÉPONSE à caractère de contrôle n'est pas rendue (revue #203, 11)", () => {
  // `Headers.set` la refuserait en jetant dans le Service Worker : le cadre verrait la page d'échec
  // du navigateur au lieu d'une réponse.
  const rendus = entetesDeReponseRendues({
    "content-type": "text/html",
    etag: `"a${String.fromCharCode(0)}b"`,
    vary: `accept${String.fromCharCode(13, 10)}x-injecte: oui`,
  });
  assert.deepEqual(rendus, { "content-type": "text/html" });
});

test("un corps sur une méthode qui n'en porte pas est refusé, jamais arbitré par le guest", () => {
  assert.equal(evaluerRequeteRelayee(requete({ corps: "QQ==" })).ok, false);
  assert.equal(evaluerRequeteRelayee(requete({ methode: "HEAD", corps: "QQ==" })).ok, false);
  assert.equal(evaluerRequeteRelayee(requete({ methode: "POST", corps: "QQ==" })).ok, true);
});

test("un corps qui n'est pas du base64, ou qui franchit le plafond, est refusé", () => {
  const admis = (corps) => evaluerRequeteRelayee(requete({ methode: "POST", corps })).ok;
  assert.equal(admis(""), true);
  assert.equal(admis("QUJD"), true);
  assert.equal(admis("QQ=="), true);
  assert.equal(admis("pas du base64 !"), false);
  assert.equal(admis("QQ==QQ"), false);
  assert.equal(admis(42), false);
  // Ce que `atob` refuse est refusé ICI, avant l'admission : les deux formes que la revue de
  // sécurité #203 (constat 3) a fait passer la garde puis jeter le Worker.
  assert.equal(admis("A"), false);
  assert.equal(admis("AAAA="), false);
  assert.equal(admis("QQ="), false);
  assert.equal(admis("QQ"), false);
  assert.equal(admis("Q==="), false);
  assert.equal(admis("QUJDRA=="), true);
  assert.equal(admis("QUJDREU="), true);
  // Et la garde ne dit jamais « oui » à ce que le décodeur refuserait : sur toutes les longueurs
  // de 0 à 9 et tous les remplissages, l'admission et `atob` tombent d'accord.
  for (let longueur = 0; longueur <= 9; longueur += 1) {
    for (const remplissage of ["", "=", "=="]) {
      const corps = "Q".repeat(longueur) + remplissage;
      if (!admis(corps)) continue;
      assert.doesNotThrow(() => atob(corps), `« ${corps} » admis puis refusé par atob`);
    }
  }
  // Le plafond porte sur la chaîne ENCODÉE, parce que c'est elle que le port transporte.
  assert.equal(admis("A".repeat(tailleEnBase64(PLAFOND_CORPS_DE_REQUETE_OCTETS))), true);
  assert.equal(admis("A".repeat(tailleEnBase64(PLAFOND_CORPS_DE_REQUETE_OCTETS) + 1)), false);
});

test("le plafond d'une RÉPONSE est très au-dessus du cas réel, et il est nommé", () => {
  // 1 083 octets pour la page d'accueil et 2 053 pour le plus lourd des actifs, mesurés le
  // 12 septembre 2026 : le plafond est à plus de quatre mille fois le cas réel. Il n'économise
  // rien — il empêche qu'une réponse pathologique soit recopiée trois fois en mémoire.
  assert.equal(PLAFOND_CORPS_DE_REPONSE_OCTETS, 8 * 1024 * 1024);
  assert.ok(PLAFOND_CORPS_DE_REPONSE_OCTETS > 4000 * 2053);
});

// --- Les en-têtes, dans les deux sens -------------------------------------------------------------

test("le document ne choisit que TROIS en-têtes ; le reste est laissé, jamais transmis", () => {
  assert.deepEqual([...ENTETES_DE_REQUETE_RELAYEES], ["accept", "accept-language", "content-type"]);
  const verdict = entetesDeRequeteRelayees({
    Accept: "text/html",
    "Content-Type": "application/x-www-form-urlencoded",
    // Quatre que le document n'a pas le droit de choisir. Ils sont LAISSÉS, pas refusés : la
    // propriété qui compte — le guest ne reçoit que ce qui est nommé — est tenue par le filtre.
    Cookie: "session=vole",
    Host: "ailleurs.test",
    Origin: "https://ailleurs.test",
    Authorization: "Bearer x",
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.entetes, [
    ["accept", "text/html"],
    ["content-type", "application/x-www-form-urlencoded"],
  ]);
});

test("une VALEUR d'en-tête illisible est un refus, parce qu'elle ne peut pas être « à peu près » transmise", () => {
  assert.equal(entetesDeRequeteRelayees({ accept: "text/html\r\nX: oui" }).ok, false);
  assert.equal(entetesDeRequeteRelayees({ accept: "a".repeat(1025) }).ok, false);
  assert.equal(entetesDeRequeteRelayees({ accept: 42 }).ok, false);
  assert.equal(entetesDeRequeteRelayees(["accept", "text/html"]).ok, false);
  assert.equal(entetesDeRequeteRelayees(undefined).ok, true);
});

test("`Set-Cookie` n'est JAMAIS rendu au cadre, et c'est la décision centrale du module", () => {
  const rendus = entetesDeReponseRendues({
    "content-type": "text/html; charset=utf-8",
    "set-cookie": "_vault_session=abc; path=/; HttpOnly",
    server: "puma",
    "x-runtime": "0.01",
    "x-request-id": "deadbeef",
  });
  assert.deepEqual(rendus, { "content-type": "text/html; charset=utf-8" });
  assert.ok(!ENTETES_DE_REPONSE_RENDUES.includes("set-cookie"));
  // Ce que le document VOIT est une liste fermée, et chacun de ses membres sert au rendu.
  assert.deepEqual(
    [...ENTETES_DE_REPONSE_RENDUES],
    [
      "content-type",
      "content-language",
      "content-disposition",
      "location",
      "cache-control",
      "etag",
      "last-modified",
      "vary",
    ],
  );
});

test("le Service Worker relève EXACTEMENT les en-têtes que le relais admet", () => {
  // Une recopie qui diverge est pire qu'une recopie : le Service Worker relèverait un en-tête que
  // la coquille jetterait ensuite, et personne ne saurait lequel des deux a raison.
  assert.deepEqual([...ENTETES_RELEVEES], [...ENTETES_DE_REQUETE_RELAYEES]);
});

// --- La redirection -------------------------------------------------------------------------------

test("une `Location` absolue vers le guest rend un CHEMIN, jamais une adresse", () => {
  // Rails rend des Location ABSOLUES : l'hôte y est celui que le relais a posé, et le cadre n'a
  // aucune raison d'apprendre où l'application écoute dans la machine virtuelle.
  assert.equal(emplacementRendu("http://127.0.0.1/notes/42", ORIGINE), "/notes/42");
  assert.equal(emplacementRendu("http://127.0.0.1/notes/42?a=b#c", ORIGINE), "/notes/42?a=b#c");
  assert.equal(emplacementRendu("/notes/42", ORIGINE), "/notes/42");
});

test("une `Location` en https vers le guest (config.assume_ssl de Rails) rend son chemin", () => {
  // `rails new` écrit `config.assume_ssl = true` en production : la redirection qui suit un
  // formulaire vise `https://<hôte du guest>/…`. C'est le guest ; une autre machine ne l'est pas.
  assert.equal(emplacementRendu("https://127.0.0.1/notes/42", ORIGINE), "/notes/42");
  assert.equal(emplacementRendu("https://127.0.0.1/notes?x=1#y", ORIGINE), "/notes?x=1#y");
  assert.equal(emplacementRendu("https://exemple.test/notes/42", ORIGINE), null);
  assert.equal(emplacementRendu("https://127.0.0.1:9999/notes/42", ORIGINE), null);
  assert.equal(emplacementRendu("https://127.0.0.1/..//evil.test/", ORIGINE), null);
});

test("une redirection HORS du guest n'est pas rendue : le cadre ne navigue pas sur son ordre", () => {
  assert.equal(emplacementRendu("https://exemple.test/", ORIGINE), null);
  assert.equal(emplacementRendu("http://127.0.0.1:9999/ailleurs", ORIGINE), null);
  assert.equal(emplacementRendu("", ORIGINE), null);
  assert.equal(emplacementRendu(undefined, ORIGINE), null);
  // Une `Location` de la BONNE origine dont le chemin se normalise en `//…` : le cadre la lirait
  // comme une URL relative au schéma, donc une autre origine (revue de sécurité #203, constat 4).
  assert.equal(emplacementRendu("/..//evil.test/", ORIGINE), null);
  assert.equal(emplacementRendu("/./..//evil.test", ORIGINE), null);
  assert.equal(emplacementRendu("/..//evil.test?a=1", ORIGINE), null);
  assert.equal(emplacementRendu("http://127.0.0.1/..//evil.test/", ORIGINE), null);
});

// --- Le bocal à cookies ---------------------------------------------------------------------------

test("le bocal retient ce qu'une réponse pose, et le rend au guest sous `Cookie`", () => {
  const bocal = creerBocalDeCookies();
  assert.equal(bocal.entete(), null);
  assert.equal(bocal.compte(), 0);

  const poses = bocal.deposer([
    ["content-type", "text/html"],
    ["set-cookie", "_vault_session=abc; path=/; HttpOnly; SameSite=Lax"],
    ["set-cookie", "autre=def; path=/"],
  ]);
  assert.equal(poses, 2);
  assert.equal(bocal.compte(), 2);
  assert.equal(bocal.entete(), "_vault_session=abc; autre=def");
});

test("la LISTE d'en-têtes est lue, et non la table : deux cookies s'y écraseraient", () => {
  // C'est le motif de `entetesRepetees` dans `src/vm/serial-protocol.mjs` : la table des en-têtes
  // perd ce qui se répète, et un serveur qui pose deux cookies le fait par deux en-têtes.
  const bocal = creerBocalDeCookies();
  bocal.deposer([
    ["set-cookie", "a=1"],
    ["set-cookie", "b=2"],
    ["set-cookie", "c=3"],
  ]);
  assert.equal(bocal.compte(), 3);
});

test("un cookie réécrit remplace sa valeur et passe au DERNIER rang", () => {
  // L'ordre est celui de la DERNIÈRE pose, et le nom de l'épreuve dit ce qu'elle mesure (revue
  // d'intégration #203, constat 10).
  const bocal = creerBocalDeCookies();
  bocal.deposer([
    ["set-cookie", "a=1"],
    ["set-cookie", "b=2"],
  ]);
  bocal.deposer([["set-cookie", "a=3"]]);
  assert.equal(bocal.entete(), "b=2; a=3");
});

test("le bocal est BORNÉ : un guest qui poserait mille cookies ne fait pas grossir la confiance", () => {
  const bocal = creerBocalDeCookies({ plafond: 3 });
  bocal.deposer([
    ["set-cookie", "a=1"],
    ["set-cookie", "b=2"],
    ["set-cookie", "c=3"],
    ["set-cookie", "d=4"],
  ]);
  assert.equal(bocal.compte(), 3);
  assert.equal(bocal.entete(), "b=2; c=3; d=4");
});

test("ce qui n'est pas un cookie n'entre pas dans le bocal", () => {
  const bocal = creerBocalDeCookies();
  bocal.deposer([
    ["set-cookie", "=sans-nom"],
    ["set-cookie", "sans-egal"],
    ["set-cookie", ""],
  ]);
  assert.equal(bocal.compte(), 0);
  assert.equal(bocal.entete(), null);
  assert.equal(bocal.deposer(undefined), 0);
});

test("le bocal se VIDE, et ce qui est vidé ne revient pas", () => {
  const bocal = creerBocalDeCookies();
  bocal.deposer([["set-cookie", "_vault_session=abc"]]);
  bocal.vider();
  assert.equal(bocal.compte(), 0);
  assert.equal(bocal.entete(), null);
});

// --- Les chemins de la coquille de cadre ----------------------------------------------------------

test("les chemins de la COQUILLE DE CADRE ne sont jamais relayés au guest", () => {
  // Sans cette liste, le Service Worker relaierait au guest le document qui le porte, le module qui
  // l'enregistre et le contrat qu'ils importent : il scierait la branche sur laquelle il est assis.
  for (const chemin of [
    "/document-applicatif.html",
    "/document-applicatif.mjs",
    "/service-worker-du-cadre.mjs",
    "/cadre/courtier-du-cadre.mjs",
    "/src/coquille/contrat-de-messages.mjs",
    // Ce que l'ARBRE APPLICATIF publie d'autre : la place tenante, l'inventaire, les en-têtes.
    // Le témoin d'en-têtes de l'ADR 0017 mesure la première, et il a mesuré un 504 du relais
    // avant que cette famille n'entre dans la liste.
    "/index.html",
    "/inventaire.json",
    "/_headers",
    // Les bancs et les épreuves que ce dépôt sert sur la MÊME origine en local : un Service Worker
    // qui les relaierait ferait rougir des suites qui n'ont rien demandé.
    "/vm/reference.html",
    "/coquille-epreuve/hostile.html",
    "/spike/origin/app.html",
    "/compat.html",
  ]) {
    assert.equal(estUnCheminDeLaCoquilleDeCadre(chemin), true, chemin);
  }
  // Et ce que le guest sert, lui, passe — y compris les chemins qu'un PRÉFIXE sans frontière avalait
  // (revue d'intégration de la PR #203, constat 5).
  for (const chemin of [
    "/",
    "/notes/42",
    "/vault.css",
    "/vault/health",
    "/documents",
    "/compatibilite-des-notes",
    "/document-applicatifs-de-mon-app",
    "/index.html.bak",
    "/srcs/x",
  ]) {
    assert.equal(estUnCheminDeLaCoquilleDeCadre(chemin), false, chemin);
  }
  assert.ok(CHEMINS_DE_LA_COQUILLE_DE_CADRE.length >= 11);
});

// --- La forme complète ----------------------------------------------------------------------------

test("une requête bien formée rend ses quatre champs, normalisés", () => {
  const verdict = evaluerRequeteRelayee({
    methode: "post",
    chemin: "/notes",
    entetes: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "vole=oui" },
    corps: "bGliZWxsZT1h",
  });
  assert.deepEqual(verdict, {
    ok: true,
    methode: "POST",
    chemin: "/notes",
    entetes: [["content-type", "application/x-www-form-urlencoded"]],
    corps: "bGliZWxsZT1h",
  });
});

// --- Les bornes et les en-têtes ---------------------------------------------------------------------

test("les trois bornes s'EMBOÎTENT : la plus extérieure attend le plus longtemps (revue #203, 6)", () => {
  // Pont série < coquille < Service Worker. Dans cet ordre, une borne intérieure qui expire rend son
  // refus TYPÉ avant que la suivante ne se taise : le cadre lit la cause la plus précise.
  assert.ok(
    DEFAULT_REQUEST_TIMEOUT_MS < DELAI_RELAIS_COQUILLE_MS,
    `pont ${DEFAULT_REQUEST_TIMEOUT_MS} ms ≥ coquille ${DELAI_RELAIS_COQUILLE_MS} ms`,
  );
  assert.ok(
    DELAI_RELAIS_COQUILLE_MS < DELAI_DU_COURTIER_MS,
    `coquille ${DELAI_RELAIS_COQUILLE_MS} ms ≥ Service Worker ${DELAI_DU_COURTIER_MS} ms`,
  );
});

test("le Service Worker rejoue EXACTEMENT les en-têtes de politique de l'hébergeur (revue #203, 7)", () => {
  const hebergeur = securityHeaders({
    role: "app",
    pathname: "/notes/42",
    isolation: null,
    appOrigin: "http://localhost:4180",
  });
  for (const [nom, valeur] of Object.entries(ENTETES_DE_L_HEBERGEUR_APPLICATIF)) {
    assert.equal(hebergeur[nom], valeur, nom);
  }
  // Et la table n'oublie aucun des trois en-têtes de politique que l'hébergeur pose sur ce rôle.
  for (const nom of ["Cache-Control", "X-Content-Type-Options", "Cross-Origin-Resource-Policy"]) {
    assert.ok(nom in ENTETES_DE_L_HEBERGEUR_APPLICATIF, nom);
  }
});

test("la garde d'ABANDON : un cadre retiré ou un Worker mort ne reçoit plus rien (revue #203, 6)", () => {
  assert.equal(relaisAbandonne({ relaisAbandonne: false, workerMort: false }), false);
  // Le verrouillage — réussi OU refusé — retire le cadre : c'est le cas qui dure, puisqu'un refus ne
  // recharge pas la coquille.
  assert.equal(relaisAbandonne({ relaisAbandonne: true, workerMort: false }), true);
  assert.equal(relaisAbandonne({ relaisAbandonne: false, workerMort: true }), true);
  assert.equal(relaisAbandonne({ relaisAbandonne: true, workerMort: true }), true);
});
