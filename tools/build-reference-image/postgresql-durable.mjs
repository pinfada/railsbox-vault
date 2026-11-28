// La configuration DURABLE de PostgreSQL dans un coffre (#343, ADR 0056) : la garde qui la refuse
// affaiblie, avant toute construction.
//
// Ce module ne lit aucun fichier : il analyse des textes, comme `pinning-contract.mjs`. C'est ce qui
// permet à `tests/unit/postgresql-durable.test.mjs` de lui présenter des configurations fautives —
// celle de RailsBox la première — et de vérifier qu'il les refuse.
//
// ## La décision qu'il garde
//
// PostgreSQL ne tourne dans un coffre qu'avec `fsync = on`, `synchronous_commit = on`,
// `full_page_writes = on`, et un cluster initialisé avec des sommes de contrôle
// (`initdb --data-checksums`), quel qu'en soit le coût (décision du mainteneur, 27/11/2026). Un
// réglage affaibli ne fait échouer aucune requête : il ne se voit qu'au boot à froid qui suit un
// verrouillage, quand une écriture acquittée manque. C'est pourquoi le refus a lieu ICI, et pas chez
// la personne.
//
// ## Deux barrières, et ce que chacune voit
//
//  1. ce module, appelé par `verify-pinning.mjs` : il lit les FICHIERS que l'outil embarque — la
//     configuration du guest et son lanceur ;
//  2. le guest, à chaque boot (`guest/postgresql.sh verifier`) : il relit par `SHOW`, sur la
//     connexion de l'application, ce que le serveur APPLIQUE. Lui seul voit un
//     `postgresql.auto.conf` écrit dans le volume, un `ALTER ROLE … SET` ou un cluster né sans
//     sommes de contrôle.
//
// Un `SET synchronous_commit = off` émis par l'application dans SA session échappe aux deux : c'est
// un choix de l'application, que l'outil ne peut pas interdire (ADR 0056, § « Ce qui reste hors de
// portée »).

/**
 * Les réglages que la décision EXIGE, et la valeur que `SHOW` doit rendre. `wal_sync_method` n'a pas
 * de valeur unique : toute méthode qui va jusqu'au disque sous Linux convient.
 */
export const REGLAGES_EXIGES = Object.freeze({
  fsync: "on",
  synchronous_commit: "on",
  full_page_writes: "on",
  wal_sync_method: Object.freeze(["fdatasync", "fsync", "open_datasync", "open_sync"]),
  data_checksums: "on",
});

/** Les trois réglages de durabilité qui doivent être ÉCRITS dans la configuration, et vrais. */
const DURABILITE = Object.freeze({
  fsync: "pg-fsync-affaibli",
  synchronous_commit: "pg-synchronous-commit-affaibli",
  full_page_writes: "pg-full-page-writes-affaibli",
});

/** Les contrôles d'intégrité qu'un réglage peut DÉSARMER : ils doivent rester faux. */
const CONTROLES = Object.freeze([
  "ignore_checksum_failure",
  "zero_damaged_pages",
  "data_sync_retry",
]);

/** Les graphies de « vrai » d'un booléen PostgreSQL (`parse_bool`, insensible à la casse). */
const VRAI = /^(on|true|yes|1)$/i;

/** @typedef {{ code: string, message: string, ligne: number }} Anomalie */

/**
 * Lit les affectations d'une configuration PostgreSQL : `nom = valeur` ou `nom valeur`, valeur
 * éventuellement entre apostrophes, commentaire `#` en fin de ligne. La DERNIÈRE affectation d'un
 * nom fait foi, comme pour le serveur. Les directives d'inclusion sont rendues à part.
 *
 * @param {string} texte
 * @returns {{ valeurs: Map<string, { valeur: string, ligne: number }>,
 *             inclusions: { directive: string, ligne: number }[] }}
 */
export function lireLesReglages(texte) {
  const valeurs = new Map();
  const inclusions = [];
  for (const [index, brute] of texte.split(/\r?\n/).entries()) {
    const ligne = brute.trim();
    if (ligne === "" || ligne.startsWith("#")) continue;
    const affectation = ligne.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=\s*|\s+)(.*)$/);
    if (affectation === null) continue;
    const nom = affectation[1].toLowerCase();
    if (/^include(_if_exists|_dir)?$/.test(nom)) {
      inclusions.push({ directive: nom, ligne: index + 1 });
      continue;
    }
    valeurs.set(nom, { valeur: valeurSansCommentaire(affectation[2]), ligne: index + 1 });
  }
  return { valeurs, inclusions };
}

/** La valeur d'une affectation, sans ses guillemets ni le commentaire qui la suit. */
function valeurSansCommentaire(brute) {
  const citee = brute.match(/^'((?:[^']|'')*)'|^"([^"]*)"/);
  if (citee !== null) return (citee[1] ?? citee[2]).replace(/''/g, "'");
  return brute.replace(/\s*#.*$/, "").trim();
}

/**
 * Analyse la configuration que le guest donne au serveur (`config_file`).
 *
 * @param {string} texte
 * @returns {Anomalie[]}
 */
export function analyserConfigurationPostgresql(texte) {
  const { valeurs, inclusions } = lireLesReglages(texte);
  const anomalies = inclusions.map(({ directive, ligne }) => ({
    code: "pg-inclusion-refusee",
    ligne,
    message: `${directive} : un fichier inclus échappe à cette vérification`,
  }));

  for (const [nom, code] of Object.entries(DURABILITE)) {
    const reglage = valeurs.get(nom);
    if (reglage === undefined) {
      anomalies.push({
        code: "pg-reglage-absent",
        ligne: 0,
        message: `${nom} n'est pas écrit : la valeur par défaut ne décide pas de la durabilité`,
      });
    } else if (!VRAI.test(reglage.valeur)) {
      anomalies.push({
        code,
        ligne: reglage.ligne,
        message: `${nom} = ${reglage.valeur} : une écriture acquittée pourrait être perdue (ADR 0056)`,
      });
    }
  }

  const methode = valeurs.get("wal_sync_method");
  if (methode !== undefined && !REGLAGES_EXIGES.wal_sync_method.includes(methode.valeur)) {
    anomalies.push({
      code: "pg-wal-sync-method-inconnue",
      ligne: methode.ligne,
      message: `wal_sync_method = ${methode.valeur} : méthode inconnue, ou qui ne va pas jusqu'au disque`,
    });
  }

  for (const nom of CONTROLES) {
    const reglage = valeurs.get(nom);
    if (reglage !== undefined && VRAI.test(reglage.valeur)) {
      anomalies.push({
        code: "pg-controle-desarme",
        ligne: reglage.ligne,
        message: `${nom} = ${reglage.valeur} : un contrôle d'intégrité est désarmé`,
      });
    }
  }
  return anomalies;
}

/** Une surcharge en ligne de commande qui affaiblit : `-c nom=faux`, `--nom=faux`, ou `-F`. */
const SURCHARGE = /(?:-c\s*|--)(fsync|synchronous_commit|full_page_writes)=['"]?([A-Za-z0-9_]+)/g;

/**
 * Analyse le LANCEUR du cluster (`guest/postgresql.sh`), joué à la construction ET au boot : il doit
 * initialiser avec des sommes de contrôle, et ne rien affaiblir par la ligne de commande.
 *
 * @param {string} texte
 * @returns {Anomalie[]}
 */
export function analyserLanceurPostgresql(texte) {
  const anomalies = [];
  const lignes = texte.split(/\r?\n/);
  const actives = lignes
    .map((contenu, index) => ({ contenu, numero: index + 1 }))
    .filter(({ contenu }) => !/^\s*#/.test(contenu));

  const initdb = actives.filter(({ contenu }) => /\binitdb\b/.test(contenu));
  const avecSommes = initdb.some(({ contenu }) => /(--data-checksums|\s-k\b)/.test(contenu));
  if (!avecSommes) {
    anomalies.push({
      code: "pg-sommes-de-controle-absentes",
      ligne: initdb[0]?.numero ?? 0,
      message: "initdb sans --data-checksums : une page corrompue ne serait pas détectée",
    });
  }

  for (const { contenu, numero } of actives) {
    for (const [, nom, valeur] of contenu.matchAll(SURCHARGE)) {
      if (!(nom === "synchronous_commit" ? /^on$/i : VRAI).test(valeur)) {
        anomalies.push({
          code: "pg-surcharge-affaiblie",
          ligne: numero,
          message: `${nom}=${valeur} en ligne de commande : il l'emporterait sur la configuration`,
        });
      }
    }
    if (/\bpostgres\b[^\n]*\s-F\b/.test(contenu)) {
      anomalies.push({
        code: "pg-surcharge-affaiblie",
        ligne: numero,
        message: "postgres -F désactive fsync",
      });
    }
    if (/ALTER\s+SYSTEM/i.test(contenu)) {
      anomalies.push({
        code: "pg-surcharge-affaiblie",
        ligne: numero,
        message:
          "ALTER SYSTEM écrirait un réglage dans le volume, hors de la configuration de l'outil",
      });
    }
  }
  return anomalies;
}

/**
 * La version MAJEURE de PostgreSQL est épinglée dans `sources.json` (`postgresql.version`) : chaque
 * paquet Debian `postgresql-<N>` installé par le Dockerfile, et le `PG_VERSION` du lanceur, doivent
 * la nommer. Un cluster né sous une majeure ne s'ouvre pas sous une autre : une montée de version
 * silencieuse rendrait tous les coffres existants inouvrables. Le paquet suit le miroir Debian dans
 * sa majeure (ADR 0004, épinglage par instantané apt non fait) ; la majeure, elle, ne bouge pas.
 *
 * @param {{ sources: Record<string, any>, dockerfile: string, lanceur: string }} entree
 * @returns {Anomalie[]}
 */
export function analyserVersionPostgresql({ sources, dockerfile, lanceur }) {
  const anomalies = [];
  const version = sources?.postgresql?.version;
  if (!/^\d+$/.test(String(version ?? ""))) {
    return [
      {
        code: "pg-version-non-epinglee",
        ligne: 0,
        message: "sources.json : postgresql.version absente ou mal formée",
      },
    ];
  }
  const installes = [...dockerfile.matchAll(/\bpostgresql(?:-client)?-(\d+)\b/g)].map(
    (trouve) => trouve[1],
  );
  if (installes.length === 0) {
    anomalies.push({
      code: "pg-version-non-epinglee",
      ligne: 0,
      message: "guest.Dockerfile n'installe aucun paquet postgresql-<version>",
    });
  }
  for (const majeure of new Set(installes)) {
    if (majeure !== String(version)) {
      anomalies.push({
        code: "pg-version-non-epinglee",
        ligne: 0,
        message: `guest.Dockerfile installe PostgreSQL ${majeure}, sources.json épingle ${version}`,
      });
    }
  }
  const duLanceur = lanceur.match(/^PG_VERSION=(\d+)$/m)?.[1];
  if (duLanceur !== String(version)) {
    anomalies.push({
      code: "pg-version-non-epinglee",
      ligne: 0,
      message: `guest/postgresql.sh porte PG_VERSION=${duLanceur ?? "absent"}, sources.json épingle ${version}`,
    });
  }
  return anomalies;
}
