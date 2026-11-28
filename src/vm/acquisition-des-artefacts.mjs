// L'ACQUISITION des artefacts du démarrage : ce que le boot va chercher AVANT d'ouvrir quoi que ce
// soit — module v86, wasm, BIOS, noyau, initrd, rootfs, paquet (#255).
//
// Scindé de `boot-de-reference.mjs` (700 lignes, seuil d'alerte) : ce module ne boote rien, il
// TÉLÉCHARGE et CONFRONTE aux empreintes du descripteur. Et c'est ici, au seul endroit qui sait de
// quoi il parle, que les échecs d'acquisition sont MARQUÉS — plus loin, la coquille ne savait plus
// distinguer « cette adresse n'a pas servi l'application » d'une panne quelconque, et rendait le
// fourre-tout que le projet a banni ailleurs (#240, #244 ; contrôle QA du 20/09/2026, rootfs en 403).

import { artefactALAdresse, chargerAdressesV86, empreinteSha256Hex } from "../v86-adresses.mjs";
import { artefactAbsentHorsConnexion } from "./artefact-absent-hors-connexion.mjs";
import { acquerirLeDisqueSysteme } from "./acquisition-du-disque-systeme.mjs";
import { admissionSelonLeBudget, ouvrirLeMagasinOpfs } from "./magasin-opfs.mjs";
import { bindNavigatorStorage, createStorageBudget } from "./storage-budget.mjs";
import { verifierEmpreintesV86, verifierLeModuleV86 } from "./empreintes-du-runtime-v86.mjs";
import { empreinteDeLImage } from "./instantane-du-boot.mjs";
import { exigerContexteExecutable } from "./runtime-environment.mjs";
import { PHASES_DU_BOOT, poserLaPhase } from "./phase-du-boot.mjs";
import { sousLeVerrouDesArtefacts } from "./verrou-des-artefacts.mjs";

/**
 * Le boot va chercher des octets sur le RÉSEAU : la phase le dit (#348). Servi par le magasin, il ne
 * télécharge rien, et la phase reste celle de la préparation.
 */
export const direQueLeBootTelecharge = () => poserLaPhase(PHASES_DU_BOOT.telechargement);

/**
 * MARQUE un échec d'ACQUISITION, et laisse passer tout le reste.
 *
 * Une acquisition refusée, coupée ou altérée jette une erreur ORDINAIRE, sans code : c'est ce
 * marquage, et lui seul, qui permet à la coquille de dire ensuite que l'adresse n'a pas fourni
 * l'application. Les erreurs TYPÉES nomment déjà ce qui s'est passé et ressortent intactes ;
 * l'erreur d'origine reste sous `cause`, où le détail technique se relit.
 *
 * @param {() => Promise<unknown>} acquerir
 */
export async function marquerLAcquisitionDesArtefacts(acquerir) {
  try {
    return await acquerir();
  } catch (erreur) {
    if (erreur?.code !== undefined) throw erreur;
    throw Object.assign(new Error(erreur?.message ?? "cause inconnue"), {
      artefactDuDemarrage: true,
      cause: erreur,
    });
  }
}

async function fetchBytes(url, recuperer = globalThis.fetch, options = { cache: "no-store" }) {
  const response = await recuperer(url, options);
  if (!response.ok) {
    throw new Error(`Artefact ${url} indisponible (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Les artefacts du démarrage qui passent par le magasin, dans l'ordre où le boot les attend. */
export const PETITS_ARTEFACTS = Object.freeze(["wasm", "bios", "vgaBios", "kernel", "initrd"]);

/**
 * Les ÉPINGLES — empreinte et taille — de ces cinq artefacts : celle du wasm vient du manifeste v86
 * (`vendor/v86/MANIFEST.json`), les quatre autres du descripteur (`boot.empreintes`, #247 D1g). Une
 * épingle absente est REFUSÉE (`exigerLesEpingles`) : aucun octet n'atteint le guest sans empreinte.
 *
 * @param {Record<string, any>} runtime @param {{ artifacts: object[] }} manifeste
 */
export function epinglesDuRuntime(runtime, manifeste) {
  const wasm = artefactALAdresse(manifeste, runtime.wasm);
  return {
    wasm: wasm === null ? null : { sha256: wasm.sha256, octets: wasm.bytes },
    bios: runtime.empreintes?.bios ?? null,
    vgaBios: runtime.empreintes?.vgaBios ?? null,
    kernel: runtime.empreintes?.kernel ?? null,
    initrd: runtime.empreintes?.initrd ?? null,
  };
}

/** Un artefact reçu du réseau est confronté à son épingle avant d'être rangé : taille, puis empreinte. */
async function verifierContreLEpingle(nom, octets, pin) {
  if (octets.byteLength !== pin.octets) {
    throw new Error(
      `Artefact ${nom} refusé : ${octets.byteLength} octets reçus, le descripteur en annonce ${pin.octets}.`,
    );
  }
  const mesure = await empreinteSha256Hex(octets);
  if (mesure !== pin.sha256) {
    throw new Error(
      `Artefact ${nom} refusé : empreinte ${mesure}, le descripteur déclare ${pin.sha256}.`,
    );
  }
}

/**
 * Aucun octet n'atteint le guest sans empreinte épinglée : une épingle absente refuse AVANT tout
 * téléchargement. Hors connexion c'est le refus typé de l'artefact absent ; en ligne, une erreur
 * ordinaire que l'acquisition marque (« cette adresse n'a pas fourni l'application »).
 */
function exigerLesEpingles(pins, horsConnexion) {
  for (const nom of PETITS_ARTEFACTS) {
    if (pins[nom] !== null && pins[nom] !== undefined) continue;
    if (horsConnexion) throw artefactAbsentHorsConnexion(nom, "n'a pas d'empreinte épinglée");
    throw new Error(
      `Artefact ${nom} refusé : aucune empreinte épinglée, aucun octet sans épingle.`,
    );
  }
}

/**
 * ACQUIERT un petit artefact : servi par le magasin s'il y est et vérifié, sinon téléchargé, confronté
 * à son épingle, puis rangé. Exporté pour le téléchargement anticipé (#348), qui le joue artefact par
 * artefact.
 */
export async function acquerirUnPetit({ nom, url, pin, magasin, recuperer, horsConnexion }) {
  if (magasin) {
    const cible = new Uint8Array(pin.octets);
    const servi = await magasin
      .servir({ sha256: pin.sha256, octets: pin.octets }, cible)
      .catch(() => false);
    if (servi) return { octets: cible, transfere: 0, magasin: "servi" };
  }
  if (horsConnexion) throw artefactAbsentHorsConnexion(nom, "manque à la réserve");
  direQueLeBootTelecharge();
  const octets = await fetchBytes(url, recuperer);
  await verifierContreLEpingle(nom, octets, pin);
  if (!magasin) return { octets, transfere: octets.byteLength, magasin: "absent" };
  try {
    await magasin.admettre({ sha256: pin.sha256, octets });
    return { octets, transfere: octets.byteLength, magasin: "admis" };
  } catch (erreur) {
    return { octets, transfere: octets.byteLength, magasin: erreur?.code ?? "echec" };
  }
}

const DANS_LA_RESERVE = new Set(["servi", "admis"]);
const dansLaReserve = (statut) => DANS_LA_RESERVE.has(statut);

/**
 * ACQUIERT wasm, BIOS, VGA BIOS, noyau et initrd : servis par le magasin s'ils y sont et vérifiés,
 * sinon téléchargés, confrontés à leur épingle, puis rangés. Hors connexion, seul le magasin répond :
 * un manque est un refus typé (`VAULT_COQUILLE_HORS_LIGNE_ARTEFACT_ABSENT`), jamais un téléchargement.
 *
 * `complet` dit si la réserve tient les CINQ : c'est lui — avec le disque système — qui autorise à
 * ranger le descripteur (`hors-connexion.mjs`).
 *
 * @param {{ runtime: Record<string, any>, pins: Record<string, { sha256: string, octets: number } | null>,
 *           magasin: object | null, recuperer?: typeof fetch, horsConnexion?: boolean }} entrees
 */
export async function acquerirLesPetitsArtefacts({
  runtime,
  pins,
  magasin,
  recuperer = globalThis.fetch,
  horsConnexion = false,
}) {
  exigerLesEpingles(pins, horsConnexion);
  // En SÉRIE : un artefact de plusieurs Mio en vol à la fois ne sert à rien sur une origine unique.
  const octets = {};
  const statuts = {};
  let transfereOctets = 0;
  for (const nom of PETITS_ARTEFACTS) {
    const acquis = await acquerirUnPetit({
      nom,
      url: runtime[nom],
      pin: pins[nom],
      magasin,
      recuperer,
      horsConnexion,
    });
    octets[nom] = acquis.octets;
    statuts[nom] = acquis.magasin;
    transfereOctets += acquis.transfere;
  }
  return {
    octets,
    transfereOctets,
    magasin: statuts,
    complet: PETITS_ARTEFACTS.every((nom) => dansLaReserve(statuts[nom])),
  };
}

/**
 * La réserve tient-elle TOUT ce que le boot a lu — les cinq petits artefacts, le rootfs et le paquet ?
 * Seul un oui autorise à ranger le descripteur (`hors-connexion.mjs`) : sinon il promettrait un
 * démarrage hors connexion que la réserve ne tient pas.
 *
 * @param {{ complet: boolean }} petits @param {{ magasin: Record<string, string> }} disque
 */
export function reserveTientTout(petits, disque) {
  return petits.complet && Object.values(disque.magasin).every(dansLaReserve);
}

/**
 * RÉTENTION de la réserve après une acquisition : le rootfs et le paquet courants (et le paquet
 * précédent), plus les cinq petits artefacts courants, que le démarrage hors connexion lira (#247, D1g).
 * Le magasin est un cache : la rétention ne fait jamais échouer un boot, et elle est bornée dans le
 * temps comme `servir` et `admettre` (revue du 04/10/2026, constat 3).
 */
async function retenirLaReserve({ magasin, runtime, pins }) {
  await magasin
    ?.retenir({
      rootfs: runtime.disqueSysteme.rootfs.sha256,
      paquet: runtime.disqueSysteme.paquet.sha256,
      autres: Object.values(pins)
        .filter((pin) => pin !== null)
        .map((pin) => pin.sha256),
    })
    .catch(() => {});
}

/**
 * Les cinq petits artefacts, le disque système et la rétention, sous le VERROU des artefacts (#348) :
 * un téléchargement anticipé encore en cours — ici ou dans un autre onglet — finit de ranger ce qu'il
 * télécharge, puis le boot le SERT au lieu de le redemander. L'attente se dit comme un téléchargement.
 */
function acquerirSousLeVerrou({ runtime, pins, magasin, horsConnexion, acquerirLeDisque }) {
  return sousLeVerrouDesArtefacts(
    async () => {
      const petits = await acquerirLesPetitsArtefacts({ runtime, pins, magasin, horsConnexion });
      const disque = await acquerirLeDisque({ ...runtime.disqueSysteme, magasin, horsConnexion });
      await retenirLaReserve({ magasin, runtime, pins });
      return { petits, disqueSysteme: disque };
    },
    { quandIlFautAttendre: direQueLeBootTelecharge },
  );
}

/**
 * Charge les tampons du runtime. Les DONNÉES n'en font PAS partie : elles vivent dans OPFS.
 *
 * Le disque système (`hda`) n'est plus un artefact mais une COMPOSITION : le rootfs et le paquet
 * applicatif, chacun servi sous son empreinte, rangés aux décalages d'un tampon partitionné
 * (#236, ADR 0041). Les deux morceaux restent exposés comme artefacts — ce sont eux, et non le
 * disque composé, que l'empreinte d'image et la liaison d'un instantané nomment.
 */
export async function loadRuntime(
  runtime,
  {
    magasin = ouvrirLeMagasinOpfs({
      peutAdmettre: admissionSelonLeBudget(
        createStorageBudget(bindNavigatorStorage(globalThis.navigator?.storage)),
      ),
    }),
    acquerirLeDisque = acquerirLeDisqueSysteme,
  } = {},
) {
  const horsConnexion = runtime.horsConnexion === true;
  const manifeste = runtime.manifesteV86 ?? (await chargerAdressesV86()).manifeste;
  const pins = epinglesDuRuntime(runtime, manifeste);
  const { petits, disqueSysteme } = await acquerirSousLeVerrou({
    runtime,
    pins,
    magasin,
    horsConnexion,
    acquerirLeDisque,
  });
  const { wasm, bios, vgaBios, kernel, initrd } = petits.octets;
  const artifacts = {
    wasm,
    bios,
    vgaBios,
    kernel,
    initrd,
    rootfs: disqueSysteme.vues.rootfs,
    paquet: disqueSysteme.vues.paquet,
    // Ce que v86 reçoit en `hda` : le disque ENTIER, table de partitions comprise. Il n'entre pas
    // dans l'empreinte d'image — ses deux morceaux y sont déjà, et la table est calculée.
    disqueSysteme: disqueSysteme.tampon,
  };
  const transferredBytes = petits.transfereOctets + disqueSysteme.mesures.transfereOctets;
  const empreintesV86Ms = await verifierEmpreintesV86(runtime, artifacts, { manifeste });
  return {
    artifacts,
    transferredBytes,
    empreintesV86Ms,
    disqueSysteme: disqueSysteme.mesures,
    empreintesVerifiees: disqueSysteme.empreintesVerifiees,
    // La réserve tient-elle TOUT ce que le boot a lu ? Seul un oui autorise à ranger le descripteur.
    // UNE seule définition, celle que le boot exécute : `reserveTientTout`.
    reserveComplete: reserveTientTout(petits, disqueSysteme.mesures),
    petitsArtefacts: petits.magasin,
  };
}

/**
 * Importe la classe V86, après l'avoir confrontée au manifeste v86 épinglé.
 *
 * **Dans l'arbre publié, la liaison existe** (ADR 0048 § 3, qui amende l'ADR 0046 § 6) : `libv86` est dans
 * la réserve du Service Worker de la coquille, qui relit ses octets et les RE-HACHE à chaque service ; la
 * `Response` qu'il construit depuis des octets vérifiés est ce que `import()` exécute dans un Worker, sur
 * les trois moteurs. Hors connexion, la lecture ci-dessous et l'`import()` sont servis par la réserve, sans
 * aucun accès au réseau ni au cache HTTP : il n'y a plus de chemin « cache du navigateur ».
 * La liaison est relative à la liste du SW (ADR 0048 § « Ce que le Service Worker ne protège PAS »).
 *
 * La confrontation à `manifeste` est CONSERVÉE : c'est un recoupement « `libv86` de la réserve ↔
 * manifeste v86 scellé du descripteur », qui protège d'une réserve plus récente que le `v86.wasm` rangé
 * au magasin. Dans le dépôt vivant (sans réserve), `libv86` reste de confiance d'origine, comme le code de
 * la coquille (limite de l'ADR 0046 § 6, historique).
 */
async function importV86(libUrl, { manifeste }) {
  await verifierLeModuleV86(libUrl, (url) => fetchBytes(url), { manifeste });
  const module = await import(libUrl);
  return module.V86;
}

/**
 * Acquiert TOUT ce qui vient du réseau : la classe V86 et les tampons du runtime. Chaque échec sans
 * code en ressort MARQUÉ, quel que soit l'appelant — le boot comme la reprise hors ligne (#255).
 */
export function acquerirRuntime(runtime) {
  return marquerLAcquisitionDesArtefacts(() => acquerirLesArtefacts(runtime));
}

async function acquerirLesArtefacts(runtime) {
  await exigerContexteExecutable();
  const manifeste = runtime.manifesteV86 ?? (await chargerAdressesV86()).manifeste;
  const V86 = await importV86(runtime.lib, { manifeste });
  const {
    artifacts,
    transferredBytes,
    empreintesV86Ms,
    disqueSysteme,
    empreintesVerifiees,
    reserveComplete,
    petitsArtefacts,
  } = await loadRuntime(runtime);
  // L'EMPREINTE DE L'IMAGE est prise ICI, sur les octets tout juste acquis, et jamais plus tard.
  // Le rootfs est un tampon que le guest ÉCRIT (#65) : le hacher après un boot donnerait l'empreinte
  // d'une session, pas celle d'une image. Le défaut est tombé sur le scénario de bout en bout de
  // #65 — la reprise écartait l'instantané au motif ECART_IMAGE, sur la même image exactement.
  return {
    V86,
    artifacts,
    transferredBytes,
    empreintesV86Ms,
    disqueSysteme,
    reserveComplete,
    petitsArtefacts,
    empreinteImage: await empreinteDeLImage(artifacts, empreintesVerifiees),
  };
}
