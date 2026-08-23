# Fixture de rapport de compatibilité

`reference-report.json` est une **capture réelle et versionnée** d'une exécution de
`npm run test:compat`, conservée pour une seule raison : donner à la suite unitaire un rapport
complet, produit par un vrai navigateur, sur lequel valider le schéma de
`src/compat/capability-contract.mjs`.

| Champ              | Valeur                             |
| ------------------ | ---------------------------------- |
| Version du contrat | 2                                  |
| Moteur             | Chromium Playwright 151.0.7922.34  |
| Playwright         | 1.62.1                             |
| Système            | win32 10.0.26200 (Windows 11 Home) |
| Node               | v24.14.0                           |
| Enregistré le      | 2026-08-23                         |

## Ce que la fixture prouve et ne prouve pas

- **Prouve** : le schéma du rapport est stable et un rapport réellement produit le respecte
  (`tests/unit/compat-contract.test.mjs`).
- **Ne prouve pas** : les verdicts qu'elle contient. Ils datent de la capture, dépendent de la
  machine (quota de stockage, nombre de cœurs, limite de tas) et n'engagent aucun support produit.
  Les verdicts qui font foi sont ceux de `reports/compat/<moteur>.json`, régénérés à chaque
  exécution et archivés en CI.

## Renouvellement

La fixture est remplacée lorsque `CAPABILITY_PROBE_CONTRACT.version` change ou lorsqu'une capacité
entre dans la matrice :

```sh
npm run test:compat
cp reports/compat/chromium.json tests/fixtures/compat/reference-report.json
```

Le tableau ci-dessus est mis à jour dans la même modification.
