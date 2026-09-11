// Le SCELLEMENT du produit : la HIÉRARCHIE de clés d'un volume et ses DEUX compteurs (#182,
// ADR 0033 ; #18, ADR 0016).
//
// Ce module ne réimplémente RIEN. Il appelle `src/vm/format-chiffre/modele-reference.mjs`, qui est la
// spécification exécutable de l'ADR 0015, et il n'ajoute que les trois choses qu'un module pur ne
// pouvait pas porter :
//
//  1. **les CLÉS de ce volume et son identité**, tenues une fois pour que chaque appelant n'ait pas
//     à les répéter — et donc pas à se tromper en les répétant. Depuis la v4 il y en a deux, et
//     elles DESCENDENT de la clé maîtresse au lieu d'être elle : la clé du domaine `volume` scelle
//     les secteurs, l'empreinte de région, le témoin et les RACINES ; celle du domaine `journal`
//     scelle les enregistrements de `<volume>.gen` (ADR 0033, décision 2) ;
//  2. **les deux COMPTEURS de scellements**, qui vivent dans la racine. Depuis la v4, la règle qui
//     les rend exacts est écrite et tenue : _toute session qui scelle sous une clé à compteur clôt
//     par une RACINE qui publie les deux compteurs ; une ouverture qui ne peut pas écrire de racine
//     n'a pas le droit de sceller._ C'est ce qui ferme la sous-estimation que le § 4.5 avouait —
//     un budget avoué faux restait un budget faux ;
//  3. **la traduction des refus** `VAULT_CRYPTO_*` en `VAULT_STORAGE_*`, parce qu'un appelant du
//     stockage n'a pas à connaître deux familles d'erreurs. La cause d'origine est CONSERVÉE dans le
//     contexte : un refus de sécurité qui perdrait sa cause en changeant de couche ne serait plus
//     qu'une panne.
//
// ## Les deux régimes, et pourquoi le second survit
//
// `Scellement.ouvrir` sert DEUX formats, et c'est délibéré :
//
//  - **v4 et au-delà** — les clés descendent de la DEK par HKDF, la DEK elle-même est importée en
//    MATÉRIAU HKDF et WebCrypto refuse alors de chiffrer avec (ADR 0033, décision 6) ;
//  - **v3** — la clé de volume EST la DEK, importée en AES-GCM. Ce régime n'a plus qu'un appelant
//    dans le produit : la MIGRATION, qui est le seul lecteur admis d'un volume v3 et le seul geste
//    qui tienne les deux clés à la fois. Il est nommé ici pour que le cliquet de T2b n'ait qu'un
//    nom à inscrire dans sa liste d'exceptions — une garde à exception non nommée est une garde
//    qu'on désarme par inadvertance.
//
// **La source de nonces est injectable, et c'est le seul point de cette tranche qui le soit.** Elle
// existe pour une raison écrite par l'ADR 0015 : « permettre à une implémentation (#18) de REPRODUIRE
// ces vecteurs ». Le défaut est `tirerNonce`, c'est-à-dire douze octets de `crypto.getRandomValues`
// à chaque scellement.
//
// Elle est GARDÉE PAR UN JETON depuis la revue de #102, qui a relevé que cette porte ouvrait sans
// rien demander là où la clé, à deux lignes de distance, en exigeait un. La mutation qui a motivé la
// garde est exécutée par `tests/unit/vm-source-de-nonce.test.mjs` : un nonce constant accepté, deux
// blocs scellés sous la même clé et la même identité, et c1 ⊕ c2 = p1 ⊕ p2 — le clair de l'un
// révèle celui de l'autre, sans qu'aucune étiquette n'ait été forgée.
//
// **Ce que ce jeton est, et ce qu'il n'est pas.** Contrairement à celui de la clé, il n'a pas de
// variante d'environnement : une source de nonces est une FONCTION, elle ne traverse aucune
// frontière de message, et seul un module qui importe déjà celui-ci peut la passer. Le jeton rend
// donc l'intention EXPLICITE ; ce qui interdit l'usage, c'est l'épreuve d'architecture de
// `tests/unit/harnais-portes.test.mjs`, qui refuse tout appelant hors des épreuves.

import { cleDInstantane, hierarchieDeVolume } from "./derivation/hierarchie-de-volume.mjs";
import { CRYPTO_ERROR_CODES, isCryptoError } from "./format-chiffre/crypto-errors.mjs";
import { racinePorteDeuxCompteurs, tirerNonce } from "./format-chiffre/identite-logique.mjs";
import {
  RANG_SECTEUR_DE_VOLUME,
  importerCleDeVolume,
  ouvrirBloc,
  ouvrirEnregistrement,
  ouvrirRacine,
  rescellerEnSecteurs,
  scellerBlocSousNonce,
  scellerEnregistrementSousNonce,
  scellerRacineSousNonce,
} from "./format-chiffre/modele-reference.mjs";
import {
  ouvrirInstantane as ouvrirInstantaneDuModele,
  scellerInstantane as scellerInstantaneDuModele,
} from "./instantane/modele-reference.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "./storage-errors.mjs";

export { RANG_SECTEUR_DE_VOLUME };

/**
 * Traduction des refus du modèle vers la famille du stockage.
 *
 * Rejeu, troncature et mélange retombent tous sur `GENERATION_CORRUPT` : ce sont trois façons pour
 * une génération VALIDÉE de ne plus concorder, et l'ADR 0014 leur donne déjà un remède unique —
 * restaurer une sauvegarde, jamais deviner. Les distinguer dans le CODE n'apprendrait rien à
 * l'exploitant ; les distinguer dans le CONTEXTE, si, et c'est ce que `cause` fait.
 */
const TRADUCTION = Object.freeze({
  [CRYPTO_ERROR_CODES.sealRejected]: STORAGE_ERROR_CODES.sceauRefuse,
  [CRYPTO_ERROR_CODES.identityMismatch]: STORAGE_ERROR_CODES.identiteVolume,
  [CRYPTO_ERROR_CODES.replay]: STORAGE_ERROR_CODES.generationCorrupt,
  [CRYPTO_ERROR_CODES.truncation]: STORAGE_ERROR_CODES.generationCorrupt,
  [CRYPTO_ERROR_CODES.mixing]: STORAGE_ERROR_CODES.generationCorrupt,
  [CRYPTO_ERROR_CODES.orderInvalid]: STORAGE_ERROR_CODES.generationCorrupt,
  [CRYPTO_ERROR_CODES.keyBudget]: STORAGE_ERROR_CODES.budgetDeCle,
});

/**
 * Traduit un refus du format chiffré, ou laisse passer ce qui n'en est pas un.
 *
 * `VAULT_CRYPTO_MALFORME` et `VAULT_CRYPTO_ALGORITHME_INCONNU` ne sont PAS traduits : ils répondent
 * d'une violation de contrat par l'appelant — une largeur, un type, un nom d'algorithme —, c'est-à-dire
 * d'une faute de programmation en amont de toute menace. Les habiller en erreur de stockage ferait
 * croire à un support abîmé là où c'est un bogue.
 */
export function traduireRefus(cause, contexte = {}) {
  if (!isCryptoError(cause)) return cause;
  const code = TRADUCTION[cause.code];
  if (code === undefined) return cause;
  return new StorageError(code, cause.message, {
    ...contexte,
    cause: cause.code,
    menaces: cause.menaces,
    ...cause.context,
  });
}

async function traduisant(contexte, geste) {
  try {
    return await geste();
  } catch (cause) {
    throw traduireRefus(cause, contexte);
  }
}

/**
 * Jeton exigé pour REMPLACER la source de nonces. Valeur exacte : une valeur approchante n'ouvre
 * rien. Seules les épreuves qui confrontent le produit aux vecteurs de l'ADR 0015 ont une raison de
 * l'importer, et `tests/unit/harnais-portes.test.mjs` tient cette liste.
 */
export const HARNAIS_NONCE_JETON = "vault/harnais-source-de-nonce/vecteurs-adr-0015";

const REFUS_NONCE =
  `La source de nonces d'un scellement ne se remplace que dans le harnais, et l'appel doit ` +
  `présenter le jeton ${HARNAIS_NONCE_JETON}. Un nonce répété sous une même clé et une même ` +
  `identité logique rend le clair récupérable par un simple ou-exclusif, sans qu'aucune étiquette ` +
  `n'ait à être forgée. Aucun chemin du produit ne fournit de source : le défaut tire douze octets ` +
  `de crypto.getRandomValues.`;

/**
 * Un BUDGET : le compteur d'une clé, et rien d'autre.
 *
 * Il existe comme objet parce que les deux régimes n'en ont pas le même nombre. En v4, le volume et
 * le journal en ont un CHACUN ; en v3, la clé est unique et les deux domaines partagent donc le
 * MÊME objet — ce qui rend impossible, par construction, qu'une racine v3 publie deux nombres pour
 * une seule clé.
 */
class Budget {
  consomme = 0;

  reprendre(valeur) {
    this.consomme = valeur;
  }
}

/**
 * Le scellement d'UN volume : ses clés, son identité, ses compteurs.
 *
 * Une instance est partagée par le magasin de générations et par la couche chiffrée du volume, pour
 * que les compteurs soient ceux de la session entière. Deux instances se seraient contredites, et
 * c'est le budget des clés qui aurait été faux.
 */
export class Scellement {
  #volume;
  #formatVersion;
  #cleVolume;
  #cleJournal;
  #materiauMaitre;
  #tirerNonce;
  #budgetVolume;
  #budgetJournal;
  #peutSceller;

  /** Utiliser `Scellement.ouvrir` : la dérivation des clés est asynchrone. */
  constructor({
    volume,
    formatVersion,
    cleVolume,
    cleJournal,
    materiauMaitre,
    budgetVolume,
    budgetJournal,
    tirerNonce: nonces,
    peutSceller,
  }) {
    this.#volume = volume;
    this.#formatVersion = formatVersion;
    this.#cleVolume = cleVolume;
    this.#cleJournal = cleJournal;
    this.#materiauMaitre = materiauMaitre;
    this.#budgetVolume = budgetVolume;
    this.#budgetJournal = budgetJournal;
    this.#tirerNonce = nonces;
    this.#peutSceller = peutSceller;
  }

  /**
   * Dérive les clés de ce volume — NON EXTRACTIBLES — et rend un scellement prêt.
   *
   * @param {{ volume: string, cleOctets: Uint8Array, formatVersion?: number,
   *           scellementsCumulesVolume?: number, scellementsCumulesJournal?: number,
   *           tirerNonce?: () => Uint8Array, jetonNonce?: string }} options
   *   `volume` est l'identifiant TEXTUEL du volume (trente-deux hexadécimaux), tel qu'il entre dans
   *   les données associées ET dans l'info HKDF de chaque domaine. La conversion depuis les seize
   *   octets du disque est fixée par l'ADR 0015 et faite par l'ouvreur, pas ici.
   *   `cleOctets` est la clé MAÎTRESSE (la DEK). À partir de la v4 elle n'est jamais importée en clé
   *   AES : elle devient un matériau HKDF, et c'est WebCrypto qui interdit de chiffrer avec.
   *   `tirerNonce` ne s'installe que sous `jetonNonce`, dont la valeur exacte est
   *   `HARNAIS_NONCE_JETON`. Voir l'en-tête de ce fichier : c'est le paramètre par lequel le format
   *   se perd le plus silencieusement.
   */
  static async ouvrir({
    volume,
    cleOctets,
    formatVersion,
    scellementsCumules = 0,
    scellementsCumulesVolume = scellementsCumules,
    scellementsCumulesJournal = 0,
    tirerNonce: nonces = tirerNonce,
    jetonNonce,
    peutSceller = true,
  }) {
    if (nonces !== tirerNonce && jetonNonce !== HARNAIS_NONCE_JETON) throw new Error(REFUS_NONCE);

    const budgetVolume = new Budget();
    budgetVolume.reprendre(scellementsCumulesVolume);

    if (!racinePorteDeuxCompteurs(formatVersion)) {
      // RÉGIME v3 : une seule clé — la DEK elle-même — et donc un seul budget, partagé par les deux
      // domaines. Le partager est ce qui empêche une racine v3 de publier deux nombres là où il n'y
      // a qu'une clé. Ce chemin n'a plus qu'un appelant dans le produit : la migration.
      return new Scellement({
        volume,
        formatVersion,
        cleVolume: await importerCleDeVolume(cleOctets),
        cleJournal: null,
        materiauMaitre: null,
        budgetVolume,
        budgetJournal: budgetVolume,
        tirerNonce: nonces,
        peutSceller,
      });
    }

    const budgetJournal = new Budget();
    budgetJournal.reprendre(scellementsCumulesJournal);
    const { materiau, cleVolume, cleJournal } = await hierarchieDeVolume({
      cleMaitresse: cleOctets,
      identifiantVolume: volume,
      formatVersion,
    });
    return new Scellement({
      volume,
      formatVersion,
      cleVolume,
      cleJournal,
      materiauMaitre: materiau,
      budgetVolume,
      budgetJournal,
      tirerNonce: nonces,
      peutSceller,
    });
  }

  /** Identifiant TEXTUEL du volume, tel qu'il entre dans les données associées. */
  get volume() {
    return this.#volume;
  }

  get formatVersion() {
    return this.#formatVersion;
  }

  /**
   * Scellements consommés sous la clé du domaine `volume`. Authentifié dans la racine, donc durable.
   *
   * Il compte les secteurs, l'empreinte de région, le témoin ET les racines — le § 8.3 de NIST
   * SP 800-38D compte « all instances of the authenticated encryption function », et une racine en
   * est une. Depuis la v4, **plus rien d'autre ne scelle sous cette clé** : ni l'autre volume, ni
   * l'enveloppe, ni l'export, ni l'instantané. La phrase du § 4.5 est enfin vraie.
   */
  get scellementsCumulesVolume() {
    return this.#budgetVolume.consomme;
  }

  /** Scellements consommés sous la clé du domaine `journal` : les enregistrements de `<volume>.gen`. */
  get scellementsCumulesJournal() {
    return this.#budgetJournal.consomme;
  }

  /**
   * Le compteur de la clé de VOLUME, sous son nom d'avant la v4.
   *
   * Il reste parce qu'un volume v3 n'en a qu'un, et que le nom sans qualificatif y est exact. Sur un
   * volume v4, préférer `scellementsCumulesVolume` : le nom nu y désignerait le compteur d'une clé
   * parmi deux, c'est-à-dire exactement l'ambiguïté que #182 vient de retirer.
   */
  get scellementsCumules() {
    return this.#budgetVolume.consomme;
  }

  /** Vrai si cette session a le droit de sceller. Voir `exigerLeDroitDeSceller`. */
  get peutSceller() {
    return this.#peutSceller;
  }

  /**
   * DÉCLARE que cette session ne clôra par AUCUNE racine, et lui retire donc le droit de sceller.
   *
   * C'est la moitié exécutable de la règle de l'ADR 0033, décision 4 : « une ouverture qui ne peut
   * pas écrire de racine est en LECTURE seule ». Le sens unique est voulu — une session peut
   * découvrir qu'elle n'écrira pas de racine, jamais l'inverse.
   */
  interdireDeSceller() {
    this.#peutSceller = false;
  }

  /**
   * REPREND les compteurs depuis une racine authentifiée. C'est le seul moyen admis de les reculer,
   * et il n'est pas un remède : l'écart entre ces compteurs et le nombre réel d'invocations sous
   * leurs clés est la question n° 4 de l'ADR 0015, dont l'ADR 0033 ne referme que la PORTÉE.
   *
   * @param {number | { volume: number, journal: number }} repere
   *   Un nombre reprend le seul compteur de volume — la forme d'un volume v3.
   */
  reprendreDepuis(repere) {
    if (typeof repere === "number") {
      this.#budgetVolume.reprendre(repere);
      return;
    }
    this.#budgetVolume.reprendre(repere.volume);
    this.#budgetJournal.reprendre(repere.journal);
  }

  /**
   * REFUSE de sceller à une session qui ne clôra par aucune racine (ADR 0033, décision 4).
   *
   * Le refus tombe AVANT que le modèle ne produise un octet, et il nomme la règle : une session dont
   * les scellements ne seraient jamais publiés dans une racine rendrait le compteur faux — et c'est
   * exactement le constat #182, qui est qu'un budget avoué faux reste un budget faux.
   */
  #exigerLeDroitDeSceller(geste) {
    if (this.#peutSceller) return;
    throw new StorageError(
      STORAGE_ERROR_CODES.lectureSeule,
      `Le volume « ${this.#volume} » est ouvert en LECTURE SEULE : cette session ne peut écrire aucune racine, donc aucun scellement ne serait publié dans un compteur. Depuis le format v4, toute session qui scelle sous une clé à compteur clôt par une racine qui publie les deux compteurs ; celle-ci ne le peut pas, et « ${geste} » lui est refusé (ADR 0033, décision 4).`,
      { volume: this.#volume, geste },
    );
  }

  #identite({ generation, rang, adresse, longueur }) {
    return {
      volume: this.#volume,
      formatVersion: this.#formatVersion,
      generation,
      rang,
      adresse,
      longueur,
    };
  }

  /**
   * Scelle un BLOC DU VOLUME — un secteur de la charge, l'empreinte de région, le témoin — sous la
   * clé du domaine `volume`, et consomme un scellement de SON budget.
   *
   * Un enregistrement du journal passe par `scellerEnregistrement`, et pas par ici : depuis le
   * constat #143 les deux magasins ne partagent plus leur étiquette de domaine, et depuis #182 ils
   * ne partagent plus leur clé.
   */
  async scellerBloc(identite, contenu) {
    this.#exigerLeDroitDeSceller("sceller un bloc du volume");
    const scelle = await traduisant({ volume: this.#volume, adresse: identite.adresse }, () =>
      scellerBlocSousNonce({
        cle: this.#cleVolume,
        identite: this.#identite(identite),
        contenu,
        nonce: this.#tirerNonce(),
        attentes: { scellementsCumules: this.#budgetVolume.consomme },
      }),
    );
    this.#budgetVolume.consomme += 1;
    return scelle;
  }

  /**
   * Ouvre un bloc du volume sous l'identité présentée. Un écart quelconque est un REFUS : aucun
   * clair partiel, aucun zéro, aucun diagnostic inventé sur la cause.
   */
  async ouvrirBloc(identite, scelle, { generationMinimale = null } = {}) {
    return traduisant({ volume: this.#volume, adresse: identite.adresse }, () =>
      ouvrirBloc({
        cle: this.#cleVolume,
        identite: this.#identite(identite),
        scelle,
        attentes: { generationMinimale },
      }),
    );
  }

  /** Scelle un ENREGISTREMENT du journal sous la clé du domaine `journal` (#143, #182). */
  async scellerEnregistrement(identite, contenu) {
    this.#exigerLeDroitDeSceller("sceller un enregistrement du journal");
    const scelle = await traduisant({ volume: this.#volume, adresse: identite.adresse }, () =>
      scellerEnregistrementSousNonce({
        cle: this.#cleDuJournal(),
        identite: this.#identite(identite),
        contenu,
        nonce: this.#tirerNonce(),
        attentes: { scellementsCumules: this.#budgetJournal.consomme },
      }),
    );
    this.#budgetJournal.consomme += 1;
    return scelle;
  }

  /**
   * Ouvre un ENREGISTREMENT du journal de génération (#143).
   *
   * Un enregistrement d'un journal ANTÉRIEUR au format 4 ne s'ouvre PAS ici : il a été scellé sous
   * l'étiquette d'un bloc du volume, et c'est `ouvrirBloc` qui le rend. Le choix appartient au
   * lecteur de charge, qui seul connaît le format de la racine ; le cacher derrière un paramètre de
   * ce module aurait mis une décision de format dans la couche qui n'en connaît aucun.
   */
  async ouvrirEnregistrement(identite, scelle, { generationMinimale = null } = {}) {
    return traduisant({ volume: this.#volume, adresse: identite.adresse }, () =>
      ouvrirEnregistrement({
        cle: this.#cleDuJournal(),
        identite: this.#identite(identite),
        scelle,
        attentes: { generationMinimale },
      }),
    );
  }

  /** La clé du journal : la sienne en v4, celle du volume en v3 — où il n'y en a qu'une. */
  #cleDuJournal() {
    return this.#cleJournal ?? this.#cleVolume;
  }

  /**
   * RESCELLE un contenu en secteurs du volume, sous un nonce neuf par secteur — le geste du POINT DE
   * CONTRÔLE. Le modèle épingle le rang à zéro et refuse un contenu non aligné ; l'appelant a déjà
   * fait la lecture-modification-réécriture, comme `deposer` le fait côté journal.
   */
  async rescellerEnSecteurs({ adresse, contenu, generation }) {
    this.#exigerLeDroitDeSceller("resceller des secteurs du volume");
    const rescelle = await traduisant({ volume: this.#volume, adresse }, () =>
      rescellerEnSecteurs({
        cle: this.#cleVolume,
        adresse,
        contenu,
        identite: { volume: this.#volume, formatVersion: this.#formatVersion, generation },
        attentes: { scellementsCumules: this.#budgetVolume.consomme },
        nonces: this.#tirerNonce,
      }),
    );
    this.#budgetVolume.consomme = rescelle.scellementsCumules;
    return rescelle;
  }

  /**
   * Scelle la racine d'une génération, sous la clé du domaine `volume`.
   *
   * **C'est elle qui publie les DEUX compteurs**, et c'est pourquoi elle relève du volume et non du
   * journal : faire dépendre la racine de la clé du journal ferait dépendre le compteur du volume
   * d'une clé que le journal peut vider (ADR 0033, décision 2).
   *
   * Le compte des entrées et la longueur de charge sont DÉRIVÉS par le modèle, jamais reçus d'ici :
   * une racine qui annoncerait autre chose que ce qu'elle scelle serait une troncature signée par
   * son propre producteur.
   */
  async scellerRacine({ sequence, generation, tailleVolume }, entrees, { sequencePrecedente }) {
    this.#exigerLeDroitDeSceller("sceller une racine");
    const scelle = await traduisant({ volume: this.#volume, sequence, generation }, () =>
      scellerRacineSousNonce({
        cle: this.#cleVolume,
        racine: {
          volume: this.#volume,
          formatVersion: this.#formatVersion,
          sequence,
          generation,
          tailleVolume,
          scellementsCumulesVolume: this.#budgetVolume.consomme,
          ...(racinePorteDeuxCompteurs(this.#formatVersion)
            ? { scellementsCumulesJournal: this.#budgetJournal.consomme }
            : {}),
        },
        entrees,
        nonce: this.#tirerNonce(),
        attentes: { sequencePrecedente },
      }),
    );
    this.#budgetVolume.consomme += 1;
    return scelle;
  }

  /**
   * Scelle un INSTANTANÉ DE REPRISE sous une clé à USAGE UNIQUE (#65, ADR 0024 ; ADR 0033).
   *
   * **Aucun compteur n'est consommé, et c'est une décision.** Une capture est réécrite ENTIÈRE à
   * chaque geste et ne porte qu'un scellement ; sa clé est donc neuve, tirée d'un sel de trente-deux
   * octets écrit en clair dans le fichier. Le budget d'une clé à usage unique est de 1, et aucune
   * mesure ne peut le rendre faux — là où un compteur, lui, recule avec le support (ADR 0033,
   * décision 4).
   *
   * Le SEL est rendu avec le sceau : sans lui, la capture ne se rouvre pas.
   *
   * La liaison porte déjà le volume et la version de format : contrairement aux blocs et aux
   * racines, elle n'est PAS complétée ici. C'est voulu — un instantané peut nommer une version de
   * format de volume distincte de celle de la session, et c'est précisément l'écart que l'ADR 0024
   * demande de refuser plutôt que de gommer.
   */
  async scellerInstantane(liaison, etat) {
    this.#exigerLeDroitDeSceller("sceller un instantané de reprise");
    const { sel, cle } = await this.#cleDUneCapture();
    const scelle = await scellerInstantaneDuModele({ cle, liaison, etat });
    return Object.freeze({ sel, ...scelle });
  }

  /**
   * Ouvre un instantané. AUCUN scellement consommé : une ouverture ne chiffre rien.
   *
   * `sel` est celui que le fichier porte EN CLAIR ; il redonne la clé à usage unique de cette
   * capture-là. `corps` est le tampon UNIQUE — chiffré puis étiquette — que l'appelant a lu d'un
   * trait. Le recevoir ainsi évite une copie de 253 Mo au moment où la mémoire est déjà la plus
   * tendue : voir `vuesDuCorps` dans le modèle.
   */
  async ouvrirInstantane(liaison, nonce, corps, { sel } = {}) {
    const { cle } = await this.#cleDUneCapture(sel);
    return ouvrirInstantaneDuModele({ cle, liaison, nonce, corps });
  }

  /**
   * La clé d'UNE capture. En v3 il n'y en a pas : la capture est scellée sous la clé de volume,
   * c'est-à-dire sous la DEK, et le sel rendu est vide.
   */
  async #cleDUneCapture(sel) {
    if (this.#materiauMaitre === null) {
      return { sel: null, cle: this.#cleVolume };
    }
    return cleDInstantane({
      materiau: this.#materiauMaitre,
      identifiantVolume: this.#volume,
      ...(sel === undefined || sel === null ? {} : { sel }),
    });
  }

  /**
   * Ouvre une racine et confronte la génération trouvée à ce qu'elle authentifie. Les trois
   * classements — rejeu, troncature, mélange — sont posés APRÈS la vérification de l'étiquette, donc
   * sur un en-tête authentique. C'est l'ordre de l'ADR 0015, et il n'est pas négociable.
   */
  async ouvrirRacine(entete, scelle, entrees, attentes = {}) {
    // Le volume et la version de format sont posés ICI, jamais par l'appelant : ils sont l'identité
    // que ce scellement porte, et les laisser se répéter à chaque appel serait leur donner une
    // occasion de diverger. Une racine d'un autre volume ne sera donc pas « comparée » : ses données
    // associées ne seront simplement pas celles qu'on présente, et l'étiquette refusera.
    const identite = { volume: this.#volume, formatVersion: this.#formatVersion };
    return traduisant({ volume: this.#volume, sequence: entete.sequence }, () =>
      ouvrirRacine({
        cle: this.#cleVolume,
        entete: { ...identite, ...entete },
        scelle,
        entrees,
        attentes: { ...identite, ...attentes },
      }),
    );
  }
}
