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
import { ETAPES_V4, convertirEnV4 } from "./migration-v4.mjs";
import { Scellement } from "./scellement.mjs";
import { nouvelIdentifiantDeVolume } from "./volume-chiffre-format.mjs";
import {
  MIN_CLE_DERIVEE_FORMAT_VERSION,
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
  Object.freeze({
    from: MIN_VOLUME_FORMAT_VERSION,
    to: MIN_CLE_DERIVEE_FORMAT_VERSION,
    /**
     * DESTRUCTIVE : ce pas RESCELLE chaque secteur du volume.
     *
     * C'est le geste le plus lourd que ce dépôt ait tenté — 2^20 ouvertures et 2^20 scellements
     * pour 512 Mio — et il touche chaque octet de la charge. La sauvegarde n'est donc pas une
     * formalité : une écriture déchirée pendant la conversion n'est réparable que par elle.
     */
    destructive: true,
    summary:
      "v4 : chaque secteur est RESCELLÉ sous une clé du domaine « volume » dérivée de la DEK par HKDF-SHA-256, la DEK cessant d'être une clé de chiffrement pour devenir une clé maîtresse (ADR 0033). La racine publie deux compteurs — un par clé à compteur — et l'en-tête du fichier porte VLTVOL04.",
    /**
     * **Le SEUL geste du produit qui tienne les deux clés à la fois.** Il ouvre chaque secteur sous
     * la clé v3 — la DEK elle-même — et le rescelle sous la clé du domaine `volume` de la v4. C'est
     * l'unique exception que le cliquet anti-DEK de T2b inscrira dans sa liste, et c'est pourquoi
     * elle est nommée ici plutôt que découverte là-bas.
     *
     * L'IDENTIFIANT n'est pas tiré : un volume v3 en a déjà un, il est dans son en-tête et dans son
     * manifeste, et il entre dans l'INFO HKDF de la clé du domaine. En tirer un nouveau rendrait
     * illisible chacun des secteurs déjà convertis. `convertirEnV4` recoupe les deux récits avant
     * d'écrire quoi que ce soit.
     */
    async apply({ manifest, backend, cle, avancement, marquerAvancement }) {
      const identifiantVolume = exigerIdentifiantDeVolume(manifest);
      const nom = backend.name ?? "volume";
      const cleOctets = exigerCleDeVolume(nom, cle);
      await convertirEnV4({
        brut: backend,
        scellementV3: await Scellement.ouvrir({
          volume: identifiantVolume,
          cleOctets,
          formatVersion: MIN_VOLUME_FORMAT_VERSION,
        }),
        scellementV4: await Scellement.ouvrir({
          volume: identifiantVolume,
          cleOctets,
          formatVersion: MIN_CLE_DERIVEE_FORMAT_VERSION,
        }),
        tailleLogique: manifest.geometry.volumeSize,
        identifiantVolume,
        depuis: avancement?.etape ?? ETAPES_V4.rescellement,
        position: avancement?.position ?? null,
        tampon: avancement?.tampon ?? null,
        marquerEtape: (progress) => marquerAvancement({ ...progress, identifiantVolume }),
      });
      return createManifest({
        formatVersion: MIN_CLE_DERIVEE_FORMAT_VERSION,
        runtime: manifest.runtime,
        app: manifest.app,
        volumeSize: manifest.geometry.volumeSize,
        // `identity` est reconduite telle quelle. Ce qu'elle atteste — l'état au moment de son
        // inscription (ADR 0009) — porte sur des octets qui viennent de changer : le rescellement
        // réécrit chaque secteur sous un nonce neuf. L'ADR 0016 avait déjà tiré la conséquence pour
        // v2 → v3 — deux exports d'un même contenu logique ne sont plus comparables par empreinte —
        // et elle vaut ici à l'identique. La reconduire n'est donc pas la rendre fausse : elle
        // n'affirmait déjà plus que ce qu'elle affirmait le jour de son inscription.
        identity: manifest.identity,
        volume: { id: identifiantVolume, algorithm: VOLUME_ALGORITHM },
      });
    },
  }),
]);

/**
 * EXIGE l'identifiant qu'un manifeste v3 déclare. Il n'est ni tiré, ni deviné, ni relu du support.
 *
 * Il entre dans l'INFO HKDF de la clé du domaine `volume` : un identifiant inventé tirerait une clé
 * qui n'ouvre rien de ce que la conversion a déjà écrit, et la reprise classerait chaque secteur
 * « déchiré ». Un manifeste v3 sans bloc `volume` est une contradiction que `parseManifest` refuse
 * déjà ; la garde est ici pour que la prochaine tranche n'y mène pas sans le voir.
 */
function exigerIdentifiantDeVolume(manifest) {
  const identifiant = manifest.volume?.id;
  if (typeof identifiant === "string" && /^[0-9a-f]{32}$/.test(identifiant)) return identifiant;
  throw new MigrationError(
    MIGRATION_ERROR_CODES.conversionIncoherente,
    `Conversion vers v${MIN_CLE_DERIVEE_FORMAT_VERSION} refusée : le manifeste du volume ne déclare pas d'identifiant. Il entre dans la dérivation de la clé sous laquelle chaque secteur sera rescellé ; en inventer un rendrait le volume illisible par lui-même. Aucun octet n'est écrit.`,
    { identifiant: identifiant ?? null },
  );
}

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
