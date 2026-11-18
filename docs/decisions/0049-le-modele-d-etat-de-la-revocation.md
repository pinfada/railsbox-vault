# ADR 0049 — Le modèle d'état de la révocation d'urgence

- Statut : en rédaction (le texte complet suit le code ; la TABLE ci-dessous est normative et lue
  mot à mot par l'épreuve exhaustive)
- Date : 2026-11-19
- Issue : [#310](https://github.com/pinfada/railsbox-vault/issues/310) · réfère #265, PR #308
  (gelée)
- Lot C, tranche C1

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
