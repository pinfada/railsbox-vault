# ADR 0049 — Le modèle d'état de la révocation d'urgence

- Statut : accepté — la **conception** a été approuvée sous obligations par la revue de sécurité de
  l'issue #310 (Révision 7, 19/11/2026) ; le code (C1) est revu séparément, et la fusion exige
  l'APPROUVÉ du relecteur sur le SHA exact.
- Date : 2026-11-19
- Issue : [#310](https://github.com/pinfada/railsbox-vault/issues/310) · réfère #265 et la PR #308
  (gelée) · Lot C, tranche **C1** (C2 = l'interface de #265, C3 = #218, C4 = #245, C5 = #311)
- Ne change : ni le Worker de confiance, ni `src/vm/`, ni un format persistant, ni un code de refus.

## Contexte

La PR #308 (la confirmation de la révocation, #265) a été refusée six fois par la relecture de
sécurité. Chaque tour trouvait un cas limite du MÊME défaut : l'état de la révocation était
**implicite**, réparti entre la page, le composant de confirmation et le parcours. Quatorze
constats, dont quatre HIGH qui revenaient sous une autre forme : une annulation qui dit « rien n'a
été révoqué » alors qu'une demande est partie ; une sortie qui reste ouverte pendant l'envoi ; un
avertissement d'incertitude qui disparaît à la navigation ; une relecture échouée qui annonce une
révocation qui n'a pas eu lieu. La décision du mainteneur (18/11/2026) : **le modèle d'état en
tête**, sa table validée par la conception avant tout code. Cette tranche le livre, **sans
interface**.

## Décision : une machine d'état explicite, pure

`src/coquille/` reçoit sept modules **purs** (aucun DOM, aucune horloge, aucun hasard, aucun import
de `public/`, aucun état de module : épreuve statique) :

| Module                            | Contient                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `phases-de-la-revocation.mjs`     | les 16 phases, la forme d'un état, `creerEtat`, `etatInitial`                 |
| `cles-de-la-revocation.mjs`       | le catalogue FERMÉ des clés de texte, chacune étiquetée de ce qu'elle affirme |
| `vue-de-la-revocation.mjs`        | `vueDe`, l'empreinte canonique, les portes `lirePublic` / `lireLeConstat`     |
| `modele-de-la-revocation.mjs`     | la table (384 cellules), `transiter`, `accepte`, `LANCEURS_D_ENVELOPPE`       |
| `projection-de-la-revocation.mjs` | `projeter` : affirmations, écran imposé, région, gestes                       |
| `reponse-de-la-revocation.mjs`    | `evenementDeLaReponse` (contrat du succès), `normaliserLInventaire`           |
| `magasin-de-la-revocation.mjs`    | `creerLaRevocation` : l'état avant les effets, le pré-vol, les issues         |

**Les états.** Un état est une valeur immuable
`{ phase, lecture, sequence, donnees, session, indice, occurrence }`. L'état **initial** est F0 «
rien lu » : aucune valeur par défaut ne rend une donnée fiable. Seize phases : le coffre non ouvert
(F0 initial, FL lecture en cours, FC inventaire public connu, FE échec terminal, FM restauration en
cours) ; le coffre ouvert à relire, sans révocation (SL, SE, SM) ou **après une révocation acquittée
par le Worker** (RL, RE, RM) ; puis P (repos), C (confirmation ouverte, rien envoyé), V (demande
partie), K (acquittée et relue), I (incertaine).

**La table** (ci-dessous) est la source unique : l'épreuve exhaustive la lit mot à mot et rejoue
chacune des 384 cellules (D6). Des règles de lecture, calculées et éprouvées sur toutes les
cellules, complètent la table : **I20** (toute arête qui arrive en FE, SE, RE ou I rend
`consigner({ evenement, code })`), **R-AFF″** (toute arête qui incrémente `occurrence` rend
`vue-a-rendre` en dernier ; `masquer` en tête si l'empreinte change), **I25** (`occurrence` +1
exactement si phase, instantané, moyen ou indice changent), **T9** (les 18 arêtes qui quittent {FC,
P, C, K} effacent `donnees`).

**Les lectures.** Une seule lecture en vol ; chacune porte un identifiant jamais réutilisé ; un
résultat n'est accepté qu'avec l'identifiant courant, une seule fois. Une modification ou une
ouverture abandonne la lecture en vol. **Les données sont dans l'état** : l'ouverture des portes est
la même affectation que la publication ; les portes ne prennent aucune source.

**La vue et l'identité.** `vueDe(etat)` est une fonction pure de
`(phase, donnees, session, indice)`. L'**empreinte** est la sérialisation canonique de la vue
ENTIÈRE (identité du contenu) ; la **fraîcheur** d'un rendu se prouve par `occurrence` (identité
d'occurrence), jamais par l'égalité de contenu.

**Le magasin** (`creerLaRevocation({ executeurs, indice })`) pose l'état AVANT d'exécuter les effets
(I2), **possède les issues asynchrones** (envoi, lectures, modification : les événements de réponse
ne sont pas appelables de l'extérieur, D2), valide ses exécuteurs à la création, refuse la
réentrance, tient un journal interne borné (64) pour les défaillances d'effets sans récursion
(I20′), et applique le **pré-vol fermé** : pour tout lanceur d'enveloppe (`envoyer`, `lancer`, donc
tout ce qui passe par `modifier`), `masquer()` est exécuté et VÉRIFIÉ avant d'affecter l'état cible
; non établi, l'état cible n'est jamais affecté, le lanceur n'est pas appelé, et
`masquage-impossible` ferme depuis l'état source en gardant la famille et la cause (I23″).

**Fermeture et réentrance (revue de #315).** Tout appel PUBLIC (`terminer`, `appliquer`, `modifier`,
`definirLIndice`, `demarrer`) fait depuis un exécuteur, pendant une transition, est **REFUSÉ**
(`TypeError`) **et INTERROMPT la transition en cours**, même si l'exécuteur avale l'erreur : avant
l'affectation, c'est un masquage non établi (bascule e22) ; après, le lanceur d'enveloppe suivant
(`envoyer`, `lancer`) ne part pas — la modification renonce et relit, un envoi deviendrait un doute
— et l'interruption est consignée. Avant CHAQUE lanceur, le magasin relit dans le même tour «
instance vivante, aucune violation, état cible toujours courant ». `terminer()` hors transition est
effectif et idempotent. Le choix est « **refusé** » plutôt que « différé » : un arrêt différé
laisserait partir l'envoi, c'est le défaut reproduit par la revue (`masquer()` appelait `terminer()`
puis rendait `true`).

**Exécuteurs copiés à la création (revue de #315, 2ᵉ tour).** Le magasin ne garde jamais l'objet de
l'appelant : à la création, chaque exécuteur est copié dans un objet privé gelé par UNE lecture du
descripteur de sa propriété PROPRE ; un accesseur (qui pourrait exécuter du code entre la garde et
l'appel), une propriété héritée ou une valeur qui n'est pas une fonction est une `TypeError`. Rien
de ce que l'appelant fait ensuite à son objet (remplacer, supprimer, ajouter, redéfinir en
accesseur) n'atteint le magasin ; un `Proxy` n'est lu que par son descripteur, jamais par `get`. Les
lanceurs reçoivent la fonction déjà résolue ; l'ordre est : fonction résolue, garde « transition
intacte » relue, appel — sans aucune lecture de propriété entre les deux (épreuve statique de
l'ordre). Les exécuteurs sont appelés avec l'objet privé pour `this` : un exécuteur qui dépend de
son `this` d'origine doit être lié par l'appelant.

**Aucun ensemble exporté.** Les ensembles de phases ne sont jamais exportés :
`Object.freeze(new Set(...))` n'empêche ni `add`, ni `delete`, ni `clear`, et un appelant faisait
dire « révoqué » à la phase I pour toutes les instances. Seuls des **prédicats** (`phaseConnue`,
`phaseEnLecture`, `phaseApresSucces`, `phaseFermee`) sont exportés, sur des tableaux gelés non
exportés ; l'épreuve de pureté échoue devant tout `Set` ou `Map` exporté ou créé au niveau du
module, et devant toute valeur exportée non gelée.

**Les réponses du Worker.** Le canal ne garantit que la corrélation. `evenementDeLaReponse` classe
l'issue de l'envoi (succès seulement si type, entiers sûrs et bornés, `nombreRestants === 1`,
comptes cohérents : sinon « réponse malformée », donc incertaine) ; `normaliserLInventaire` produit
un instantané gelé, borné, sans alias (N1′-N12), sans promettre de détecter un `Proxy`.

## Les décisions D1-D7 (décidées sous la délégation du propriétaire du 18/11/2026)

D1 une seule révocation par instance (K n'accepte plus de demande) · D2 un succès tardif n'est pas
honoré, lié à la suppression de la corrélation par le canal et à l'identité de la demande (seul le
magasin produit les issues) · D3 une relecture échouée est terminale pour l'instance · **D4 l'indice
persisté (`progression.revocationFaite`) ne fait jamais dire « révoqué » ni « tous vos moyens
ouvrent toujours » après rechargement** : seul « aucun geste de révocation dans cette séance » est
dicible (`aucunGesteDansCetteSeance`) · D5 « incertaine » ne se lève que par rechargement · D6 la
table vit dans cet ADR, lue mot à mot, avec une preuve des invariants indépendante · D7 une erreur
de programmation est une `TypeError`, les entrées du Worker ne lèvent jamais.

## La table de transitions (normative)

Seize phases (colonnes), vingt-deux événements (vingt-quatre lignes : les deux événements de lecture
ont chacun une ligne « courante » et une ligne « non courante »), **384 cellules**. `→X` :
transition vers X ; `=` : accepté, état inchangé (sauf e21 : `indice`) ; `✗` : interdit (état
inchangé, aucun effet) ; `—` : sans objet (la lecture « courante » n'existe pas : aucune lecture en
vol), éprouvé comme `✗`. Entre crochets : les effets MÉTIER, dans l'ordre. Les effets calculés par
règle (`masquer`, `consigner`, `vue-a-rendre`) ne sont pas répétés ici : ils sont éprouvés sur les
384 cellules (I20, R-AFF″).

<!-- table-de-transitions:debut -->

| Événement \ État                     | F0           | FL            | FC           | FE  | FM           | SL           | SE  | SM           | RL           | RE  | RM           | P            | C                      | V                   | K            | I           |
| ------------------------------------ | ------------ | ------------- | ------------ | --- | ------------ | ------------ | --- | ------------ | ------------ | --- | ------------ | ------------ | ---------------------- | ------------------- | ------------ | ----------- |
| e0 `montage`                         | →FL [relire] | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗                      | ✗                   | ✗            | ✗           |
| e1 `coffre-ouvert`                   | →SL [relire] | →SL [relire]  | →SL [relire] | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗                      | ✗                   | ✗            | ✗           |
| e2 `demander-la-revocation`          | ✗            | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | →C           | =                      | ✗                   | ✗            | ✗           |
| e3 `oui`                             | ✗            | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | →V [envoyer]           | ✗                   | ✗            | ✗           |
| e4 `annuler`                         | ✗            | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | →P [oublier]           | ✗                   | ✗            | ✗           |
| e5 `reponse-de-succes`               | ✗            | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗                      | →RL [noter, relire] | ✗            | ✗           |
| e6 `refus-type`                      | ✗            | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗                      | →I                  | ✗            | ✗           |
| e7 `worker-mort`                     | →FE          | →FE           | →FE          | =   | →FE          | →SE          | =   | →SE          | →RE          | =   | →RE          | →SE          | →SE [oublier]          | →I                  | →RE          | =           |
| e8 `worker-rompu`                    | ✗            | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗                      | →I                  | ✗            | ✗           |
| e9 `reponse-malformee`               | ✗            | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗                      | →I                  | ✗            | ✗           |
| e10 `erreur-sans-code`               | ✗            | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗                      | →I                  | ✗            | ✗           |
| e11 `delai-depasse`                  | →FE          | →FE           | →FE          | =   | →FE          | →SE          | =   | →SE          | →RE          | =   | →RE          | →SE          | →SE [oublier]          | →I                  | →RE          | =           |
| e12 `relecture-reussie` courante     | —            | →FC [publier] | —            | —   | —            | →P [publier] | —   | —            | →K [publier] | —   | —            | —            | —                      | —                   | —            | —           |
| e12 `relecture-reussie` non courante | ✗            | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗                      | ✗                   | ✗            | ✗           |
| e13 `relecture-echouee` courante     | —            | →FE           | —            | —   | —            | →SE          | —   | —            | →RE          | —   | —            | —            | —                      | —                   | —            | —           |
| e13 `relecture-echouee` non courante | ✗            | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗                      | ✗                   | ✗            | ✗           |
| e14 `verrouiller`                    | =            | =             | =            | =   | ✗            | =            | =   | ✗            | =            | =   | ✗            | =            | =                      | ✗                   | =            | =           |
| e16 `changer-d-etape`                | =            | =             | =            | =   | =            | =            | =   | =            | =            | =   | =            | =            | →P [oublier]           | =                   | =            | =           |
| e17 `terminer-sans-revoquer`         | ✗            | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | = [terminer] | →P [oublier, terminer] | ✗                   | ✗            | ✗           |
| e18 `revenir-a-l-application`        | ✗            | ✗             | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | ✗            | ✗   | ✗            | = [revenir]  | →P [oublier, revenir]  | ✗                   | = [revenir]  | = [revenir] |
| e19 `modification-lancee`            | ✗            | →FM [lancer]  | →FM [lancer] | ✗   | ✗            | →SM [lancer] | ✗   | ✗            | →RM [lancer] | ✗   | ✗            | →SM [lancer] | →SM [oublier, lancer]  | ✗                   | →RM [lancer] | ✗           |
| e20 `modification-terminee`          | ✗            | ✗             | ✗            | ✗   | →FL [relire] | ✗            | ✗   | →SL [relire] | ✗            | ✗   | →RL [relire] | ✗            | ✗                      | ✗                   | ✗            | ✗           |
| e21 `indice-change`                  | =            | =             | =            | =   | =            | =            | =   | =            | =            | =   | =            | =            | =                      | =                   | =            | =           |
| e22 `masquage-impossible`            | ✗            | →FE           | →FE          | ✗   | ✗            | →SE          | ✗   | ✗            | →RE          | ✗   | ✗            | →SE          | →SE [oublier]          | ✗                   | →RE          | ✗           |

<!-- table-de-transitions:fin -->

## Preuves

- `tests/unit/coquille-revocation-table.test.mjs` : la table de cet ADR (complétude, 384 cellules,
  26 « — »), chaque cellule rejouée sur `transiter`.
- `tests/unit/coquille-revocation-invariants.test.mjs` : les invariants sur le graphe quotienté (16
  phases), prédicats écrits dans l'épreuve — I1, I3, I4, I5′, I6, I8, I9′, I13, I14, I15, I17′ (les
  32 cellules phase × indice), I20, I21′ (bijection sur le produit des entrées, perturbation champ
  par champ), I22′, I23″, I24, I25, T9 (18 arêtes), annonces, forme d'un état.
- `tests/unit/coquille-revocation-magasin.test.mjs` : l'ordre état → effets, le pré-vol (8 sources ×
  4 façons d'échouer), les échecs par classe d'effet (E3a-g), les issues abandonnées dans les deux
  ordres de réponse, `noter` et la remise à zéro (M-a à M-f).
- `tests/unit/coquille-revocation-reponse.test.mjs` : le contrat du succès (R8.6), l'inventaire
  (N1′-N12), la totalité.
- `tests/unit/coquille-revocation-executeurs.test.mjs` : accesseur, propriété héritée, valeur non
  fonction (10 exécuteurs chacun), propriété remplacée, supprimée ou ajoutée après la création,
  `Proxy` dont `get` viole, ordre fonction résolue → garde → appel.
- `tests/unit/coquille-revocation-purete.test.mjs` : aucun DOM, aucune horloge, aucun état de
  module.
- `tools/mutants-de-la-revocation.mjs`, dans la campagne `coquille` : un mutant par cellule gardée
  et par invariant, tous tués. **Ne sont pas comptés, car équivalents au comportement actuel** : les
  comparaisons de `donnees` et de `session.moyen` dans `occurrenceSuivante` (toute arête qui change
  l'instantané ou le moyen change aussi la phase) ; la garde `etat.lecture !== null` de la classe de
  lecture ; les cellules « lecture courante » des phases sans lecture ; la récupération défensive
  d'une exception interne en V (inatteignable par l'API publique) ; dans la fermeture, les
  relectures « instance vivante » et « état cible courant » (la réentrance étant refusée,
  `terminer()` ne peut pas s'exécuter pendant une transition et l'état ne peut pas changer : seule
  la violation est observable) la garde `descripteur === undefined` de la copie des exécuteurs (lire
  `.value` d'`undefined` lève la même `TypeError`) et la renonciation de `envoyer` (aucun exécuteur
  ne s'exécute entre l'affectation de V et `envoyer`).

## Critères de C2 (ce que C1 NE fait PAS, et que C2 doit prouver — BLOQUANTS)

C1 ne câble aucune page. **C2 ne modifie pas C1.** Les critères ci-dessous sont ceux de la
conception approuvée ; ils ne sont **pas simulés** ici.

1. **Porte unique effective (C2-1′).** Le canal (`canal-de-confiance.mjs:160-176`) n'écrit plus
   `rapport.feuilleEprouvee` ni `tailleDeSauvegarde` ; l'interface (`rafraichirLInventaire`) n'écrit
   plus que des MIROIRS par l'effet `publier` ; tout lecteur de décision (`ouvrirPar` et ses
   paramètres de dérivation, `ecranAMontrer`, observateurs) lit `lirePublic(etat)` /
   `lireLeConstat(etat)` ; balayage statique ; épreuves « ancienne source présente » (T1-T9) sur le
   câblage réel. Les constats 1, 3, 5, 9, 10, 12, 13 et 14 de #308 sont **fermés par C1 + C2, pas
   par C1 seul**.
2. **Tous les gestionnaires passent par `appliquer`**, en première instruction synchrone ;
   `disabled` / `aria-disabled` dérivés de `projeter().gestes`, jamais lus pour décider.
3. **Toute écriture d'enveloppe passe par `modifier`** (`creerLaFeuille`, `restaurerLeCoffre`, la
   migration à l'ouverture, les gestes de C3 et C4) ; balayage statique.
4. **Textes (D4).** Chaque clé du catalogue a son texte final et son étiquette vérifiée ; aucune des
   phrases « révoqué », « la révocation a été faite », « tous vos moyens ouvrent toujours », « rien
   n'a été révoqué » hors des clés étiquetées `revoque` ; l'écran atteint par l'indice seul
   (`termine-sans-attestation`) ne dit que « aucun geste de révocation dans cette séance ».
5. **Affichage autoritaire (C2-11).** Toute affirmation visible est une fonction de `vueDe` ;
   conteneur unique masqué par défaut (règle CSS sans script), estampillé en dernier ; masquage
   synchrone à chaque changement d'empreinte ; l'échec de rendu laisse le conteneur masqué et montre
   une région d'erreur sûre qui n'affirme jamais que l'affichage est à jour.
6. **Rendeur unique (C2-12, C2-15, C2-16).** Au plus UN rendu autorisé en vol ; construction dans un
   fragment privé hors du DOM visible ; publication atomique (un seul `replaceChildren` +
   estampille, bloc synchrone, sans `await` entre la condition et l'acte) ; l'autorisation est
   l'**identité d'objet** de la tentative (`enVol === t`), tenue pendant TOUT le bloc des effets
   visibles et libérée UNE fois dans un `finally`, suivie de `converger()` ; une tâche abandonnée
   par un délai n'a plus l'autorisation et n'écrit que dans son fragment privé. Obligation de la
   revue : l'épreuve de libération couvre les exceptions COMBINÉES (une erreur avant le `try` de
   `regler` suivie d'un `consigner` qui lève, et l'échec synchrone de l'armement du délai après
   `enVol ← t`), sans boucle.
7. **Masquage vérifié (C2-13).** `masquer()` relit son effet (`isConnected`, pas d'estampille,
   `hidden`) ; ses échecs (retrait, `hidden`, détachement, les trois ensemble, référence absente)
   empêchent tout appel au Worker pour `revoquer-en-urgence`, `creer-recuperation` et `restaurer`.
8. **Progression (C2-14, C2-17).** `noter` et la remise à zéro de la progression sont des écritures
   de métadonnées, sérialisées dans l'ordre des demandes, non gardées par le masquage ; épreuve à
   deux documents, fermetures inversées, valeurs différentes pour TOUS les champs ; un fichier
   tardif ne substitue jamais son indice de feuille au constat du Worker et ne fait sauter aucune
   étape de récupération.
9. **Mutants réellement tués** pour chaque retrait de la table de correspondance de la conception
   (la table ne compte pas comme une campagne exécutée), dont M311 rejoué sur « délai puis retour
   tardif, occurrence inchangée ».
10. **Navigateur.** Tenue de la règle CSS sur les trois moteurs, focus, ordre de tabulation,
    lecteurs d'écran, observabilité de `data-vue` / `data-occurrence` comme un seul lot, valeur de
    `DELAI_DU_RENDEUR_MS`.

## Limites écrites

- **L1.** Le doute (V, I) n'est **pas persisté** : il est perdu au rechargement, au verrouillage, à
  la mort de l'onglet. Après un doute, la personne retrouve l'étape 9 sans savoir qu'une révocation
  a peut-être eu lieu ; l'écran ne ment pas (D4) et l'inventaire relu montre les moyens réels.
  Aucune persistance du doute dans C1.
- **L4.** Un refus « Worker mort » rendu AVANT l'envoi est traité comme un doute (sur-prudent).
- **L5.** Tant que C2 n'est pas câblé selon le critère 1, le canal et l'interface écrasent le
  constat et le relevé hors du modèle ; le modèle seul ne l'empêche pas. Non prouvé, bloquant pour
  C2.
- **L6.** Le rendu, l'annonce par lecteur d'écran réel et le comportement du navigateur ne sont pas
  mesurés par C1 (la campagne ne rejoue que Node).
- **L7′ (course entre onglets).** La garantie réelle de « clé révoquée = clé inconnue » vaut pour un
  appel d'`ouvrirEnveloppe` dont la lecture de l'enveloppe COMMENCE après la barrière qui publie la
  révocation. Un appel qui a lu les anciennes pages avant peut finir après et, si son Worker prend
  ensuite le handle libéré par l'autre onglet, ouvrir le volume avec une clé que l'enveloppe refuse
  (démontré par un spike, pause contrôlée ; 0 sur 164 au naturel). Cela n'ajoute aucune capacité à
  qui détenait déjà la clé de volume (`SECURITY.md`, limite 12 : révoquer ne rechiffre pas). **P, C,
  K ne disent pas que la KEK de la session ouvre encore l'enveloppe.** La correction est la tranche
  **C5 = #311**, hors de C1.
- **L8.** `delai-depasse` n'est pas produit par le code actuel : le canal rend `workerMort` pour le
  silence. La table le nomme pour que la couverture le nomme.
- **L9.** La cause se réduit à « sans / après révocation » : l'origine précise est dans le rapport
  (diagnostic), pas dans l'état.
- **L10′.** Ce que la personne lit est une projection autoritaire estampillée, masquée par défaut ;
  la tenue du CSS, le focus et l'annonce par lecteur d'écran restent à prouver (C2).
- **L11″.** Un navigateur gravement défaillant peut laisser un nœud visible ; ce n'est **jamais une
  autorisation d'envoyer ni de modifier l'enveloppe**. Les écritures de métadonnées ne sont pas
  couvertes (L13′).
- **L12.** `definirLIndice` suppose que la page l'appelle quand la progression est remise à zéro ;
  un oubli laisse une vue de P fondée sur un indice périmé (critère de C2).
- **L13′.** `parcours.json` est réécrit en entier ; l'ordre d'écriture entre DEUX documents n'est
  pas maîtrisé : une écriture tardive peut réinstaller TOUS les champs. Le fichier n'est jamais une
  preuve (VULN-04, ADR 0040) : l'effet est borné au premier formulaire, à la présentation de l'étape
  4, à l'étape demandée par l'URL dans la garde du Worker, à l'écran de fin, aux libellés d'origine.

La confirmation reste une **aide à la personne**, pas une garde de sécurité (ADR 0039 § 5, 0043).

## Ce qui n'est pas prouvé

Tout ce qui touche au DOM, au CSS, au focus, aux lecteurs d'écran et aux trois moteurs (C2) ; que
tout geste d'écriture passe par `modifier` (balayage de C2) ; la course d'ouverture sur le Worker de
produit (#311) ; que les 384 cellules soient les bonnes — objet de la revue.
