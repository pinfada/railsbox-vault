// Les ADRESSES du runtime : ce que le boot doit récupérer, et contre quelles empreintes (#123, #247).
//
// Scindé de `application-de-reference.mjs` (seuil d'alerte de 700 lignes, `taille-des-fichiers`) ;
// `application-de-reference.mjs` le ré-exporte, et les appelants ne changent pas.

import { adressesDuManifeste, chargerAdressesV86, exigerAdresse } from "../v86-adresses.mjs";

/**
 * Les adresses que le boot doit récupérer : deux artefacts v86 épinglés par empreinte (#123), cinq
 * de l'image de référence servis sous leur nom.
 *
 * @param {object} descripteur
 * @param {{ recuperer?: typeof fetch }} [options]
 */
export async function adressesDuRuntime(
  descripteur,
  { recuperer = globalThis.fetch, horsConnexion = null } = {},
) {
  // En ligne, le manifeste v86 est LU ; hors connexion, il vient du descripteur scellé et le réseau
  // n'est pas appelé (#247, D1g).
  const { adresses, manifeste } =
    horsConnexion === null
      ? await chargerAdressesV86({ fetch: recuperer })
      : {
          manifeste: horsConnexion.manifesteV86,
          adresses: adressesDuManifeste(horsConnexion.manifesteV86),
        };
  const prefixe = descripteur.prefixeDesArtefacts;
  const morceau = (cle) => ({
    url: `${prefixe}${descripteur[cle].nom}`,
    octets: descripteur[cle].octets,
    sha256: descripteur[cle].sha256,
    compression: descripteur[cle].compression ?? null,
    transfertOctets: descripteur[cle].transfertOctets ?? null,
    // La racine des tranches (#247) : le magasin vérifie contre ELLE, tenue par le descripteur.
    ...(descripteur[cle].racine ? { racine: descripteur[cle].racine } : {}),
  });
  return {
    // Le manifeste v86 et les empreintes du boot : le boot épingle ses artefacts contre eux, et le
    // descripteur scellé range ce manifeste pour que le démarrage hors connexion n'ait rien à relire.
    manifesteV86: manifeste,
    empreintes: descripteur.boot.empreintes ?? null,
    ...(horsConnexion === null ? {} : { horsConnexion: true }),
    lib: exigerAdresse(adresses, "libv86.mjs"),
    wasm: exigerAdresse(adresses, "v86.wasm"),
    bios: `${prefixe}${descripteur.boot.bios}`,
    vgaBios: `${prefixe}${descripteur.boot.vgaBios}`,
    kernel: `${prefixe}${descripteur.boot.kernel}`,
    initrd: `${prefixe}${descripteur.boot.initrd}`,
    // Les DEUX morceaux du disque système, avec leur empreinte : le boot les range aux décalages
    // du plan (`src/vm/disque-compose.mjs`) et refuse celui dont les octets ne correspondent pas.
    disqueSysteme: { rootfs: morceau("rootfs"), paquet: morceau("paquet") },
  };
}
