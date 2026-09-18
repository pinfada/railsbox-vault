import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SOUMISSIONS_MAX_AVANT_COUPURE,
  cookieDeSession,
  jetonDuFormulaire,
  muterJusquALaCoupure,
} from "../../public/vm/requetes-rails-du-banc.mjs";

// Épreuve du PILOTE DE MUTATION de la phase `live-couper` (#236, recette rouge de la PR #237).
//
// Jusqu'à T1, le boot seul suffisait à muter le disque de données : `/app` entier vivait sur `hdb`,
// et Puma y écrivait `tmp/pids`, son cache et ses journaux — 48 écritures et 15 barrières mesurées
// sur `main`. Depuis que le code vit sur `sda2` et `log/` sur un tmpfs (ADR 0041), le boot n'écrit
// plus sur `hdb` que ce que le montage demande : 1 écriture, 1 barrière. Le guet de mutation, qui
// attend 8 écritures, n'annonçait donc jamais rien, et le scénario de coupure attendait jusqu'à son
// délai de garde. La coupure doit porter sur une VRAIE mutation Rails : c'est ce pilote qui la fait.

const encodeur = new TextEncoder();
const decodeur = new TextDecoder();

/** Une réponse du pont telle que `requeteHttp` la rend. */
function reponse({ statut = 200, html = "", cookies = [], location = null } = {}) {
  return {
    statut,
    entetes: location === null ? {} : { location },
    entetesRepetees: cookies.map((valeur) => ["set-cookie", valeur]),
    corps: encodeur.encode(html),
  };
}

const PAGE_AVEC_JETON =
  '<form><input type="hidden" name="authenticity_token" value="jeton+/=" /></form>';

/** Un faux guest Rails : il enregistre chaque requête et crée une note par POST accepté. */
function fauxRails({ page = PAGE_AVEC_JETON, statutDuPost = 303 } = {}) {
  const requetes = [];
  let notes = 0;
  const requeteHttp = async (methode, chemin, reglages = {}) => {
    requetes.push({ methode, chemin, reglages });
    if (methode === "GET" && chemin === "/") {
      return reponse({ html: page, cookies: ["_session=s0; path=/; HttpOnly"] });
    }
    if (methode === "POST" && chemin === "/notes") {
      if (statutDuPost !== 303) return reponse({ statut: statutDuPost, html: "refus" });
      notes += 1;
      return reponse({
        statut: 303,
        location: `http://127.0.0.1/notes/${notes}`,
        cookies: [`_session=s${notes}; path=/; HttpOnly`],
      });
    }
    return reponse({ statut: 404 });
  };
  return { requeteHttp, requetes, notes: () => notes };
}

test("le pilote lit le jeton de la page, puis soumet des notes tant qu'on ne l'arrête pas", async () => {
  const rails = fauxRails();
  let tours = 0;
  const bilan = await muterJusquALaCoupure(rails.requeteHttp, { continuer: () => tours++ < 3 });

  assert.equal(bilan.soumissions, 3);
  assert.equal(rails.notes(), 3);
  assert.deepEqual(
    rails.requetes.map(({ methode, chemin }) => `${methode} ${chemin}`),
    ["GET /", "POST /notes", "POST /notes", "POST /notes"],
  );
});

test("chaque soumission porte le jeton anti-CSRF et le DERNIER cookie posé par Rails", async () => {
  const rails = fauxRails();
  let tours = 0;
  await muterJusquALaCoupure(rails.requeteHttp, { continuer: () => tours++ < 2 });

  const [premier, second] = rails.requetes.filter(({ methode }) => methode === "POST");
  const corps = decodeur.decode(premier.reglages.body);
  assert.match(corps, /(^|&)libelle=[^&]+/);
  assert.match(corps, /authenticity_token=jeton%2B%2F%3D/);
  const entete = (requete, nom) => requete.reglages.headers.find(([cle]) => cle === nom)?.[1];
  assert.equal(entete(premier, "Cookie"), "_session=s0");
  assert.equal(entete(second, "Cookie"), "_session=s1");
  assert.equal(entete(premier, "Content-Type"), "application/x-www-form-urlencoded");
  assert.equal(entete(premier, "Content-Length"), String(premier.reglages.body.byteLength));
});

test("sans jeton dans la page, le pilote REFUSE au lieu de boucler sur des 422", async () => {
  const rails = fauxRails({ page: "<p>pas de formulaire</p>" });
  await assert.rejects(
    muterJusquALaCoupure(rails.requeteHttp, { continuer: () => true }),
    /jeton anti-CSRF/,
  );
  assert.equal(rails.notes(), 0);
});

test("une soumission refusée par Rails arrête le pilote et DIT le statut", async () => {
  const rails = fauxRails({ statutDuPost: 422 });
  await assert.rejects(
    muterJusquALaCoupure(rails.requeteHttp, { continuer: () => true }),
    /POST \/notes.*422/,
  );
});

test("sans coupure, le pilote s'arrête de lui-même à sa borne : une page oubliée ne mute pas sans fin", async () => {
  const rails = fauxRails();
  const bilan = await muterJusquALaCoupure(rails.requeteHttp);
  assert.equal(bilan.soumissions, SOUMISSIONS_MAX_AVANT_COUPURE);
  assert.equal(rails.notes(), SOUMISSIONS_MAX_AVANT_COUPURE);
});

test("les aides partagées avec la mesure du relais lisent cookie et jeton comme avant", () => {
  const avecDeuxCookies = reponse({ cookies: ["a=1; path=/", "b=2; HttpOnly"] });
  assert.equal(cookieDeSession(avecDeuxCookies, null), "a=1; b=2");
  assert.equal(cookieDeSession(reponse(), "courant=1"), "courant=1");
  assert.equal(jetonDuFormulaire(encodeur.encode(PAGE_AVEC_JETON)), "jeton+/=");
  assert.equal(jetonDuFormulaire(encodeur.encode("<p></p>")), null);
});
