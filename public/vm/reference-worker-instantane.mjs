// CAPTURE et REPRISE par instantané, côté Worker de référence (#65, ADR 0024).
//
// Ce module tient les six gestes que le banc enchaîne, et rien d'autre : il ne boote pas, ne vérifie
// aucun invariant et ne décide d'aucune assertion. Il vit à part de `reference-worker-boot.mjs`
// parce que la capture est un PROTOCOLE — point de contrôle, liaison, quiescence, scellement,
// reprise du service — dont chaque étape a une raison d'être à sa place.
//
// ## L'ordre de la capture, et pourquoi il ne se réarrange pas
//
//  1. **SUSPENDRE l'émulateur.** Tant que le guest bat, il dépose, valide et fait ranger — donc il
//     change la région d'authentification APRÈS que la liaison a été lue.
//  2. **Attendre le REPOS de l'adaptateur** : aucune E/S en vol. Une écriture partie n'est pas
//     encore chez le support, et la mémoire capturée l'aurait pourtant vue.
//  3. **SOLDER le journal** — valider ce qui est déposé, ranger par un point de contrôle —, puis
//     VÉRIFIER qu'il ne porte plus rien. Voir `solderLeJournal` : c'est le geste le plus discuté de
//     cette tranche, et celui que le scénario de bout en bout a imposé.
//  4. **Lire la LIAISON**, après le solde. C'est le seul instant où elle décrit ce que le volume
//     porte réellement — le vidage qui clôt un point de contrôle rescelle l'empreinte de région.
//  5. **QUIESCER**, capturer, sceller, écrire par le chemin de production.
//  6. **RENDRE le service.** Une capture qui a vu la moindre E/S est ABANDONNÉE, fichier retiré : il
//     n'y a pas de capture partielle, il n'y a pas de capture « probablement bonne ».
//
// L'empreinte de l'IMAGE, elle, ne se prend pas ici : elle est prise à l'ACQUISITION du runtime,
// avant le premier battement du guest. Voir `empreinteDeLImage`.

import { capturerInstantane, ouvrirInstantaneDeReprise } from "/src/vm/instantane-de-reprise.mjs";
import { supportInstantaneOpfs } from "/src/vm/instantane/support-opfs.mjs";
import { octetsEnHex } from "/src/vm/format-chiffre/octets.mjs";
import { createSha256Stream } from "/src/vm/sha256-stream.mjs";

/** Ordre CANONIQUE des artefacts dans l'empreinte d'image. Deux ordres donneraient deux empreintes. */
const ARTEFACTS_DE_L_IMAGE = Object.freeze([
  "wasm",
  "bios",
  "vgaBios",
  "kernel",
  "initrd",
  "rootfs",
]);

/**
 * EMPREINTE de l'image de référence : SHA-256 de la suite des empreintes de ses artefacts.
 *
 * Elle est calculée sur les OCTETS RÉELLEMENT ACQUIS, pas sur un manifeste : le Worker ne reçoit
 * aucun manifeste d'image, et une empreinte déclarée par celui qui la présente ne prouverait rien.
 * Le coût est un hachage des artefacts acquis — mesuré et publié par le banc.
 *
 * **Elle se prend À L'ACQUISITION, avant le premier battement du guest, et jamais plus tard.** Le
 * rootfs est un tampon que le guest ÉCRIT : le hacher après un boot rendrait l'empreinte d'une
 * SESSION, pas celle d'une image, et deux boots de la même image en rendraient deux différentes. Le
 * défaut est tombé sur le scénario de bout en bout de #65 — la reprise écartait l'instantané au
 * motif ECART_IMAGE, sur la même image exactement.
 *
 * L'ordre des artefacts est FIXE : deux ordres donneraient deux empreintes pour la même image, et
 * un instantané parfaitement valide serait alors écarté sans raison.
 */
export async function empreinteDeLImage(artifacts) {
  const flux = createSha256Stream();
  for (const nom of ARTEFACTS_DE_L_IMAGE) {
    const octets = artifacts[nom];
    if (!(octets instanceof Uint8Array)) {
      throw new Error(`Empreinte d'image impossible : l'artefact « ${nom} » manque.`);
    }
    const partiel = createSha256Stream();
    partiel.update(octets);
    flux.update(new TextEncoder().encode(`${nom}:`));
    flux.update(partiel.digest());
  }
  return flux.digest();
}

/**
 * L'ÉTAT PRÉSENT du volume, tel que la liaison d'un instantané le nomme.
 *
 * Il est lu APRÈS le point de contrôle, et il faut le dire : la séquence avance au vidage qui clôt
 * un point de contrôle, si bien qu'une liaison lue avant décrirait un état que la fermeture allait
 * périmer.
 */
export async function etatPresentDuVolume(backend, empreinteImage) {
  const racine = await backend.generation.racineValidee();
  if (racine.empreinteRegion === null) {
    throw new Error(
      "Instantané impossible : ce volume est ouvert SANS fraîcheur, donc sans empreinte de région. Un instantané lié à trente-deux zéros se lierait à n'importe quel volume.",
    );
  }
  return {
    formatVolume: backend.chiffre.scellement.formatVersion,
    sequence: racine.sequence,
    generation: racine.generation,
    empreinteRegion: racine.empreinteRegion,
    empreinteImage,
  };
}

/**
 * SOLDE le journal d'un guest ARRÊTÉ : valider ce qu'il a déposé, ranger, puis VÉRIFIER.
 *
 * Rend `null` quand le journal ne porte plus rien — la seule situation où une capture a un sens — ou
 * le détail de ce qui reste.
 *
 * **Valider les dépôts d'un guest ARRÊTÉ n'est pas une licence : c'est la condition de la
 * correction.** Les octets déposés ont atteint le périphérique. La mémoire qu'on s'apprête à
 * capturer les tient donc pour écrits — propres dans son cache de pages — et ne les relira jamais
 * depuis le disque. Les laisser non validés les ferait ÉCARTER à la prochaine ouverture, et le guest
 * restauré lirait alors, à la première éviction de cache, un secteur d'avant : une divergence
 * SILENCIEUSE entre la mémoire et le disque, exactement ce que l'ADR 0024 refuse.
 *
 * **Ce geste ne contredit pas la règle de `close()`** — « une génération non validée n'est PAS
 * rangée : personne ne l'a acquittée ». Cette règle protège la sémantique d'une COUPURE, où
 * ressusciter des écritures non acquittées serait inventer un état. Ici il n'y a pas de coupure : le
 * guest est arrêté proprement, et l'on rend le volume ÉGAL à la mémoire qu'on capture plutôt que
 * d'en capturer une qui le dépasse.
 *
 * **`SEC-DURABLE-001` est intact** : rien n'est annoncé durable à personne — le guest est arrêté et
 * ne recevra aucun acquittement —, et la barrière du support est franchie avant la racine, comme
 * partout ailleurs.
 *
 * La VÉRIFICATION finale n'est pas une politesse : ce qui resterait dans le journal serait rejoué
 * dans le volume à la prochaine ouverture. La région d'authentification changerait, la génération
 * non, et l'instantané serait écarté au motif `ECART_REGION` sur un volume que personne d'autre
 * n'aurait touché. Le scénario de bout en bout de cette tranche l'a mesuré avant que ce solde
 * n'existe.
 */
async function solderLeJournal(backend) {
  if (backend.generation.enAttente) await backend.generation.valider();
  if (backend.generation.rangeable) await backend.generation.pointDeControle();
  if (!backend.generation.enAttente) return null;
  return { octetsDeCharge: backend.generation.octetsDeCharge };
}

/** Attend que l'adaptateur n'ait plus d'E/S en vol. Rend le compte observé, borné dans le temps. */
async function attendreLeRepos(adapter, { essais = 400, pasMs = 5 } = {}) {
  for (let essai = 0; essai < essais && adapter.status().inFlight > 0; essai += 1) {
    await new Promise((resoudre) => setTimeout(resoudre, pasMs));
  }
  return adapter.status().inFlight;
}

/**
 * SCELLE et ÉCRIT l'instantané sous quiescence, puis rend le service.
 *
 * Le `finally` est le cœur de cette fonction, et c'est pourquoi elle vit seule : quoi qu'il arrive à
 * la capture, l'adaptateur est RENDU au guest. Un adaptateur laissé quiescé refuserait toutes les
 * E/S suivantes, et la fermeture du volume échouerait sur une faute que la capture aurait créée.
 */
async function sousQuiescence({ adapter, session, backend, volume, etatPresent, support }) {
  adapter.quiescer();
  try {
    const etat = await session.capturer();
    const capture = await capturerInstantane({
      scellement: backend.chiffre.scellement,
      volume,
      etatPresent,
      etat,
      support,
    });
    return { capture, violations: adapter.status().violations };
  } finally {
    adapter.reprendre();
  }
}

/**
 * Le compte rendu d'une capture REFUSÉE. Aucune exception ne sort d'ici : une capture ratée ne doit
 * pas faire échouer une fermeture par ailleurs propre — le volume est intact, et la prochaine
 * ouverture bootera à froid. Ce qui sort, c'est le MOTIF, et le banc le publie.
 */
function captureRefusee(motif, details = {}) {
  return { capture: false, motif, millisecondes: null, octets: null, ...details };
}

/** Le compte rendu d'une capture ABOUTIE. Séparé pour que la fonction qui capture reste un protocole. */
function captureAboutie({ capture, session, etatPresent, debut }) {
  return {
    capture: true,
    motif: null,
    violations: 0,
    octets: capture.octets,
    etatV86Octets: capture.liaison.longueurEtat,
    deltaRootfsOctets: session.deltaRootfsOctets(),
    // L'empreinte de RÉGION est publiée : c'est la liaison la plus fragile — elle change à chaque
    // secteur rescellé —, et sans elle un écart au retour se lit « les empreintes diffèrent » sans
    // qu'on sache laquelle a bougé, ni de combien.
    empreinteRegion: octetsEnHex(etatPresent.empreinteRegion),
    sequence: etatPresent.sequence,
    generation: etatPresent.generation,
    millisecondes: Number((performance.now() - debut).toFixed(1)),
  };
}

/**
 * CAPTURE un instantané après un point de contrôle. Rend le compte rendu, jamais un verdict.
 *
 * Aucune exception ne remonte d'ici pour un motif de capture : une capture ratée ne doit pas faire
 * échouer une fermeture par ailleurs propre — le volume est intact, et la prochaine ouverture
 * bootera à froid. Ce qui remonte, c'est le RAPPORT, et le banc le publie.
 */
export async function capturerApresPointDeControle({
  backend,
  session,
  adapter,
  volume,
  empreinteImage,
}) {
  const debut = performance.now();
  const support = supportInstantaneOpfs(volume);
  try {
    // 1. Le guest est SUSPENDU d'abord. Tant qu'il bat, il peut déposer, valider et faire ranger
    //    une génération — donc changer la région d'authentification APRÈS que la liaison a été lue.
    //    L'ordre inverse a été mesuré par le scénario de bout en bout de cette tranche : la reprise
    //    écartait l'instantané au motif ECART_REGION, sur un volume que personne n'avait touché
    //    d'autre que le guest, entre la lecture de la liaison et l'arrêt.
    session.suspendre();
    // 2. Plus aucune E/S en vol : une écriture partie n'est pas encore chez le support.
    const enVol = await attendreLeRepos(adapter);
    if (enVol > 0) return captureRefusee("eS-en-vol", { enVol });

    const ouverte = await solderLeJournal(backend);
    if (ouverte !== null) return captureRefusee("generation-ouverte", ouverte);

    const etatPresent = await etatPresentDuVolume(backend, empreinteImage);

    const { capture, violations } = await sousQuiescence({
      adapter,
      session,
      backend,
      volume,
      etatPresent,
      support,
    });
    if (violations > 0) {
      // Il n'y a pas de capture partielle : le fichier écrit décrirait une mémoire qui a vu ce que
      // le support n'a pas reçu. Il est retiré, et le motif est publié.
      await support.retirer();
      return captureRefusee("quiescence-rompue", { violations });
    }
    return captureAboutie({ capture, session, etatPresent, debut });
  } catch (cause) {
    await support.retirer().catch(() => {});
    return captureRefusee(cause?.code ?? cause?.name ?? "erreur", {
      message: cause?.message ?? null,
    });
  } finally {
    support.fermer();
  }
}

/**
 * OUVRE l'instantané d'un volume, ou dit pourquoi il est écarté.
 *
 * Elle ne restaure rien : elle rend l'état v86 et le compte rendu, et c'est le boot qui décide. La
 * séparation n'est pas de la coquetterie — le banc doit pouvoir publier « écarté au motif X, boot à
 * froid » sans que le chemin de boot ait à connaître les motifs.
 */
export async function ouvrirInstantanePourReprise({ backend, volume, empreinteImage }) {
  const debut = performance.now();
  const support = supportInstantaneOpfs(volume);
  try {
    const etatPresent = await etatPresentDuVolume(backend, empreinteImage);
    const rapport = await ouvrirInstantaneDeReprise({
      scellement: backend.chiffre.scellement,
      volume,
      etatPresent,
      support,
    });
    // L'objet rendu n'est PAS gelé, et c'est délibéré : il porte 250 Mio d'état v86, et l'appelant
    // doit pouvoir lâcher cette référence dès que la restauration a eu lieu. Un objet gelé aurait
    // retenu un quart de gibioctet pendant tout le boot, en plus de la mémoire du guest et des
    // artefacts — sur un budget navigateur de 1,5 Gio.
    return {
      ...rapport,
      millisecondes: Number((performance.now() - debut).toFixed(1)),
      sequence: etatPresent.sequence,
      generation: etatPresent.generation,
      empreinteRegion: octetsEnHex(etatPresent.empreinteRegion),
    };
  } finally {
    support.fermer();
  }
}
