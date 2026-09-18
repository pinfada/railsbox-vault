// Requêtes Rails des bancs de `public/vm/` : ce qu'un navigateur poserait, le cookie de session, le
// jeton anti-CSRF — et le PILOTE DE MUTATION de la phase `live-couper` (#236).
//
// Le pilote existe parce que le boot ne mute plus le disque de données. Jusqu'à T1, `/app` entier
// vivait sur `hdb` et Puma y écrivait `tmp/pids`, son cache et ses journaux : 48 écritures et
// 15 barrières au boot, mesurées sur `main`. Depuis l'ADR 0041, le code vit sur `sda2` (écritures
// éphémères) et `log/` sur un tmpfs, si bien que le boot n'écrit plus sur `hdb` que ce que le
// montage demande — une écriture, une barrière. C'est le comportement VOULU : seules les données
// survivent. Mais une coupure qui porte sur un volume que personne ne mute ne mesure rien ; elle
// doit porter sur une vraie mutation Rails, celle qu'un utilisateur ferait : une note enregistrée.
//
// Aucun import : ce module est lu par le Worker du banc ET par l'épreuve unitaire sous Node.

/**
 * Les en-têtes qu'un NAVIGATEUR poserait sur une navigation ordinaire : mesurer ou muter sous
 * `Accept: application/json` rendrait une page que personne ne demande.
 */
export const ENTETES_DE_PAGE = Object.freeze([
  ["Host", "127.0.0.1"],
  ["Accept", "text/html,application/xhtml+xml"],
  ["User-Agent", "railsbox-vault-mesure"],
]);

/** Le cookie de session, tel que la réponse le pose. Le premier attribut suffit à le renvoyer. */
export function cookieDeSession(reponse, courant) {
  const poses = reponse.entetesRepetees
    .filter(([nom]) => nom === "set-cookie")
    .map(([, valeur]) => valeur.split(";", 1)[0]);
  return poses.length === 0 ? courant : poses.join("; ");
}

/** Le jeton anti-CSRF que le formulaire porte. Une soumission qui l'omettrait rendrait un 422. */
export function jetonDuFormulaire(octets) {
  const html = new TextDecoder().decode(octets);
  return html.match(/name="authenticity_token" value="([^"]+)"/)?.[1] ?? null;
}

/**
 * Borne du pilote : au-delà, il s'arrête de lui-même. La page coupe bien avant — dès que le guet a
 * vu 8 écritures et une barrière acquittée, soit quelques notes —, mais une page que le scénario
 * oublierait de fermer ne doit pas muter le volume sans fin.
 */
export const SOUMISSIONS_MAX_AVANT_COUPURE = 200;

/** Une note soumise comme le formulaire de la page la soumet : libellé et jeton, encodés. */
async function soumettreUneNote(requeteHttp, { rang, cookie, jeton }) {
  const corps = new TextEncoder().encode(
    `libelle=${encodeURIComponent(`note ${rang} ecrite avant la coupure (#16)`)}` +
      `&authenticity_token=${encodeURIComponent(jeton)}`,
  );
  const entetes = ENTETES_DE_PAGE.map((paire) => [...paire]);
  if (cookie !== null) entetes.push(["Cookie", cookie]);
  entetes.push(["Content-Type", "application/x-www-form-urlencoded"]);
  entetes.push(["Content-Length", String(corps.byteLength)]);
  const reponse = await requeteHttp("POST", "/notes", { headers: entetes, body: corps });
  // 303 et rien d'autre : la note est COMMISE avant la redirection. Un 422 ou un 500 ne mute rien,
  // et boucler dessus ferait attendre le scénario jusqu'à son délai sans dire pourquoi.
  if (reponse.statut !== 303) {
    throw new Error(
      `POST /notes rendu ${reponse.statut} au lieu de 303 : la note n'est pas écrite`,
    );
  }
  return cookieDeSession(reponse, cookie);
}

/**
 * MUTE le disque de données jusqu'à la coupure : lit le jeton de la page, puis enregistre des notes
 * l'une après l'autre. Chaque note est une transaction SQLite sous `/app/var`, donc des écritures sur
 * `hdb` et une barrière du journal ext4 : exactement ce que la coupure doit interrompre.
 *
 * Il ne rend la main que si `continuer()` devient faux ou si la borne est atteinte ; dans le
 * scénario de coupure, la page se ferme avant, et le Worker meurt en pleine soumission.
 *
 * @param {(methode: string, chemin: string, reglages?: object) => Promise<object>} requeteHttp
 * @param {{ continuer?: () => boolean }} [reglages]
 * @returns {Promise<{ soumissions: number }>}
 */
export async function muterJusquALaCoupure(requeteHttp, { continuer = () => true } = {}) {
  const page = await requeteHttp("GET", "/", { headers: ENTETES_DE_PAGE.map((p) => [...p]) });
  const jeton = jetonDuFormulaire(page.corps);
  if (jeton === null) {
    throw new Error(
      "la page de l'application ne porte aucun jeton anti-CSRF : aucune note possible",
    );
  }
  let cookie = cookieDeSession(page, null);
  let soumissions = 0;
  while (soumissions < SOUMISSIONS_MAX_AVANT_COUPURE && continuer()) {
    cookie = await soumettreUneNote(requeteHttp, { rang: soumissions, cookie, jeton });
    soumissions += 1;
  }
  return { soumissions };
}
