// Les ÉTAPES ENREGISTRÉES de la migration, et la CHAÎNE qu'on en tire (#13, ADR 0011).
//
// Ce module dit CE QUE chaque pas de version fait ; `volume-migration.mjs` dit DANS QUEL ORDRE les
// gestes qui l'entourent sont posés. Les deux ont été séparés quand la table des étapes a cessé
// d'être une suite de réécritures de manifeste : depuis #101 un pas RÉÉCRIT LE VOLUME, et il porte
// son propre raisonnement — d'où vient l'identité du volume converti, ce qui doit survivre à une
// coupure, ce que le manifeste cible a le droit de déclarer.
//
// Il n'existe aucun chemin direct d'un format vers un format lointain : migrer, c'est traverser
// chaque format intermédiaire, dans l'ordre, avec un manifeste valide à chaque palier. C'est ce qui
// rend la chaîne vérifiable au lieu d'être crue.

import { exigerCleDeVolume } from "./cle-de-volume.mjs";
import { MIGRATION_ERROR_CODES, MigrationError } from "./migration-errors.mjs";
import { ETAPES_CONVERSION, convertirEnV3 } from "./migration-v3.mjs";
import { Scellement } from "./scellement.mjs";
import { nouvelIdentifiantDeVolume } from "./volume-chiffre-format.mjs";
import {
  MIN_VOLUME_FORMAT_VERSION,
  MIN_WRITER_FORMAT_VERSION,
  VOLUME_ALGORITHM,
  createManifest,
} from "./volume-manifest.mjs";

/**
 * ÉTAPES ENREGISTRÉES, une par PAS de version. Il n'existe aucun chemin direct d'un format vers un
 * format lointain : migrer, c'est traverser chaque format intermédiaire, dans l'ordre, avec un
 * manifeste valide à chaque palier. C'est ce qui rend la chaîne vérifiable au lieu d'être crue.
 *
 * `apply` reçoit le manifeste du palier courant et rend celui du palier suivant. Il reçoit aussi le
 * backend ouvert : aucune étape enregistrée n'écrit aujourd'hui dans le volume, mais l'ordre des
 * gestes ci-dessus est celui de #12 précisément pour qu'une étape future qui en écrirait n'ait pas
 * à réinventer sa sûreté.
 */
const STEPS = Object.freeze([
  Object.freeze({
    from: 1,
    to: MIN_WRITER_FORMAT_VERSION,
    summary:
      "v2 : le volume DÉCLARE `runtime.minWriter`, le plus ancien runtime autorisé à l'écrire, au lieu que chaque ouverture le devine à partir du seul majeur SemVer.",
    apply({ manifest }) {
      return createManifest({
        formatVersion: MIN_WRITER_FORMAT_VERSION,
        runtime: {
          version: manifest.runtime.version,
          artifact: manifest.runtime.artifact,
          // Traduction EXACTE de la règle v1 — « un runtime de majeur inférieur est refusé » —, et
          // non une valeur inventée : le plus ancien écrivain qu'elle admettait était le plancher
          // du majeur du runtime qui a écrit le volume.
          minWriter: plancherDuMajeur(manifest.runtime.version),
        },
        app: manifest.app,
        volumeSize: manifest.geometry.volumeSize,
        // `identity` est reconduite telle quelle : la migration ne touche aucun octet du volume,
        // donc ce que le digest attestait (l'état au moment de son inscription, ADR 0009) reste
        // exactement aussi vrai — ni plus, ni moins.
        identity: manifest.identity,
      });
    },
  }),
  Object.freeze({
    from: MIN_WRITER_FORMAT_VERSION,
    to: MIN_VOLUME_FORMAT_VERSION,
    /**
     * DESTRUCTIVE : ce pas réécrit le volume au lieu de réécrire un manifeste.
     *
     * La distinction commande la PREUVE exigée avant d'engager la migration. Un pas qui ne touche
     * aucun octet peut être assumé par un exploitant nommé : si quelque chose tourne mal, le volume
     * est encore là. Celui-ci déplace la charge entière et la rechiffre ; une écriture déchirée
     * pendant la conversion n'est réparable que par la sauvegarde, et « j'assume » ne répare rien.
     */
    destructive: true,
    summary:
      "v3 : le volume est CHIFFRÉ. Chaque secteur est scellé par AES-256-GCM sous une clé de volume, avec son identité logique en données associées (ADR 0015), et le fichier gagne un en-tête et une région d'authentification de 34 octets par secteur (ADR 0016).",
    /**
     * **La première étape du dépôt qui touche les OCTETS.** Les deux précédentes réécrivaient un
     * manifeste ; celle-ci agrandit le fichier de sa région d'authentification, décale la charge et
     * scelle chaque secteur — sur place, pour ne pas exiger le double du quota au moment où
     * l'utilisateur migre un volume de 512 Mio.
     *
     * Le geste lui-même vit dans `migration-v3.mjs`, avec sa reprise et son contre-exemple. Ici ne
     * reste que ce qui appartient à la CHAÎNE : d'où vient l'identité du volume converti, et ce que
     * le manifeste cible déclare.
     *
     * L'IDENTIFIANT est TIRÉ ici, et il ne peut pas l'être ailleurs : un volume v2 n'en a pas, et
     * c'est précisément le champ que le format v3 ajoute. Il est immuable ensuite.
     *
     * **Il est aussi JOURNALISÉ, et il le faut.** Il entre dans les données associées de chaque
     * secteur scellé : une reprise qui en tirerait un nouveau ne reconnaîtrait plus un seul des
     * secteurs déjà convertis, les classerait « en clair » et les RECHIFFRERAIT. Le journal est le
     * seul endroit où il puisse survivre à la coupure, puisque l'en-tête v3 — l'autre endroit où il
     * vit — n'est écrit qu'en dernier, une fois la conversion finie.
     */
    async apply({ manifest, backend, cle, avancement, marquerAvancement }) {
      const identifiantVolume =
        avancement?.identifiantVolume ?? manifest.volume?.id ?? nouvelIdentifiantDeVolume();
      await convertirEnV3({
        brut: backend,
        scellement: await Scellement.ouvrir({
          volume: identifiantVolume,
          cleOctets: exigerCleDeVolume(backend.name ?? "volume", cle),
          formatVersion: MIN_VOLUME_FORMAT_VERSION,
        }),
        tailleLogique: manifest.geometry.volumeSize,
        identifiantVolume,
        depuis: avancement?.etape ?? ETAPES_CONVERSION.deplacement,
        position: avancement?.position ?? null,
        marquerEtape: (progress) => marquerAvancement({ ...progress, identifiantVolume }),
      });
      return createManifest({
        formatVersion: MIN_VOLUME_FORMAT_VERSION,
        runtime: manifest.runtime,
        app: manifest.app,
        volumeSize: manifest.geometry.volumeSize,
        // `identity` est reconduite telle quelle. Ce qu'elle atteste — l'état au moment de son
        // inscription (ADR 0009) — porte désormais sur des octets CHIFFRÉS, et l'ADR 0016 en tire
        // la conséquence : deux exports d'un même contenu logique ne sont plus comparables par
        // empreinte. La reconduire n'est donc pas la rendre fausse, c'est la laisser dire ce
        // qu'elle disait — ni plus, ni moins.
        identity: manifest.identity,
        volume: { id: identifiantVolume, algorithm: VOLUME_ALGORITHM },
      });
    },
  }),
]);

for (const etape of STEPS) {
  if (etape.to !== etape.from + 1) {
    throw new Error(`Étape de migration non contiguë : ${etape.from} → ${etape.to}.`);
  }
}

/** Plancher SemVer du majeur d'une version déjà validée : « 2.7.3 » → « 2.0.0 ». */
function plancherDuMajeur(version) {
  const majeur = /^(\d+)\./.exec(version);
  if (majeur === null) throw new TypeError(`Version de runtime inattendue : ${version}.`);
  return `${majeur[1]}.0.0`;
}

/** Les étapes enregistrées, pour la documentation et les vecteurs de test par version. */
export function migrationSteps() {
  return STEPS;
}

/**
 * Chaîne d'étapes menant de `from` à `to`, un PAS à la fois. Rend une liste vide si le volume est
 * déjà au format visé.
 *
 * @throws {MigrationError} `VAULT_MIGRATION_DOWNGRADE_REFUSED` si `to` précède `from`,
 *   `VAULT_MIGRATION_NO_PATH` si une étape manque à la chaîne.
 */
export function planMigration(from, to) {
  if (!Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < 1) {
    throw new TypeError(`Versions de format invalides : ${JSON.stringify({ from, to })}.`);
  }
  if (to < from) {
    throw new MigrationError(
      MIGRATION_ERROR_CODES.downgradeRefused,
      `Migration refusée : le volume est au format ${from} et ${to} lui est antérieur. Une migration ne descend jamais ; revenir en arrière suppose de restaurer une sauvegarde.`,
      { from, to },
    );
  }
  const chaine = [];
  let courant = from;
  while (courant < to) {
    const etape = STEPS.find((candidate) => candidate.from === courant);
    if (etape === undefined) {
      throw new MigrationError(
        MIGRATION_ERROR_CODES.noPath,
        `Migration refusée : aucune étape enregistrée ne part du format ${courant} vers ${courant + 1}. La chaîne ${from} → ${to} est interrompue et ne sera pas devinée.`,
        { from, to, missingFrom: courant },
      );
    }
    chaine.push(etape);
    courant = etape.to;
  }
  return chaine;
}
