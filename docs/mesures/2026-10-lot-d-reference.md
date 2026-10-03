# Lot D, étape 0 de D1 : référence de mesure et critère d'arrêt (#67, #238, #247)

Mesuré le 4 octobre 2026 sur la tête de `main` (`cbb5d9e`), image de référence reconstruite dans le
worktree par `npm run image:build`.

> **CRITÈRE D'ARRÊT : ARRÊT sous l'hypothèse prudente (disque entier lu au boot), sur Chromium.**
> Lire 522 Mio par blocs de 4 096 octets et les hacher coûte environ 25,8 s sous Chromium, soit
> **+30 %** sur un boot à froid de référence d'environ 87 s. Le coût vient du nombre d'appels à
> `read()`, pas du débit : les mêmes 522 Mio lus par blocs de 64 Kio prennent 1,8 s (+2 %). D1 ne
> doit pas partir sur la DoR telle quelle ; la décision de la modifier (lecture groupée) revient au
> client.

## Poste

| Élément                | Valeur                                                      |
| ---------------------- | ----------------------------------------------------------- |
| Processeur             | Intel Core i7-14700HX, 28 fils logiques                     |
| Mémoire                | 31,7 Gio                                                    |
| Système                | Windows 11 (win32 x64), Node 24.14.0                        |
| Navigateurs Playwright | Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5          |
| Mode                   | sans interface (headless), aucune campagne Docker parallèle |

## 1. Mémoire et temps (`node tools/mesurer-memoire.mjs --essais=3`, Chromium)

Mémoire résidente de tous les processus du navigateur, échantillonnée chaque seconde (Mio).

| Phase        | Relevés (≈ s) | Pic     | Moyenne | Privé au pic |
| ------------ | ------------- | ------- | ------- | ------------ |
| base         | 3             | 268,9   | 239,2   | 145,6        |
| préparation  | 38            | 688,5   | 539,3   | 552,9        |
| boot à chaud | 58            | 1 526,1 | 1 303,8 | 1 712,8      |
| reprise 1    | 57            | 1 531,2 | 1 301,9 | 1 727,4      |
| reprise 2    | 54            | 1 601,6 | 1 296,4 | 1 814,1      |
| reprise 3    | 53            | 1 600,6 | 1 313,4 | 1 807,4      |

Durée jusqu'à `/vault/health` : boot 90,1 s ; reprises 92,1 s, 84,3 s et 82,1 s (médiane des quatre
: **87,2 s**). Le relevé publie `usedSnapshot: false` pour les trois reprises : dans ce banc, chaque
« reprise » est un **boot complet**, disque servi depuis la RAM. C'est la référence du boot à froid
retenue ci-dessous.

**Comparaison à #238.** Le pic d'aujourd'hui (1 526 à 1 602 Mio) est du même ordre que les 1 552 Mio
du 17/09 (écart de -2 % à +3 %), et toujours au-dessus de la cible de 1 200 Mio. L'écart reste dans
la dispersion entre reprises (75 Mio ici) ; le plus gros processus au pic est le renderer qui porte
le Worker v86 (≈ 1,33 Gio). Rien n'indique une dérive.

## 2. Débit de lecture par tranches dans un Worker (`node tools/mesurer-debit-opfs.mjs --essais=3`)

Banc : `public/vm/debit-opfs.html` et son Worker `public/vm/debit-opfs-worker.mjs`, servis par
`tools/serve.mjs`. Fichier de 522 Mio écrit dans l'OPFS par tranches de 8 Mio, relu par
`FileSystemSyncAccessHandle.read(cible, { at })`, puis haché en SHA-256 par tranches de 8 Mio
(`crypto.subtle.digest`, un seul tampon de 8 Mio). Valeurs : médiane de 3 essais.

| Mesure (522 Mio)             | Chromium 151        | Firefox 153          | WebKit 26.5 |
| ---------------------------- | ------------------- | -------------------- | ----------- |
| écriture par 8 Mio           | 1,56 s (334 Mio/s)  | 0,49 s (1 070 Mio/s) | non mesuré  |
| lecture séquentielle 4 Kio   | 24,8 s (21,0 Mio/s) | 1,49 s (350 Mio/s)   | non mesuré  |
| lecture aléatoire 4 Kio      | 24,7 s (21,1 Mio/s) | 2,62 s (199 Mio/s)   | non mesuré  |
| lecture séquentielle 64 Kio  | 1,77 s (294 Mio/s)  | 0,43 s (1 203 Mio/s) | non mesuré  |
| empreintes SHA-256 par 8 Mio | 1,12 s (468 Mio/s)  | 0,78 s (672 Mio/s)   | non mesuré  |

- **Chromium** : environ 0,19 ms par appel `read()`, quel que soit l'ordre (séquentiel ou
  aléatoire). Le débit à 4 Kio est donc borné par le coût d'appel, pas par le disque.
- **Firefox** : l'ordre aléatoire coûte 1,8 fois le séquentiel, mais reste sous 3 s.
- **WebKit** (Playwright, Windows) : `navigator.storage.getDirectory` est **absent** ; ni OPFS ni
  accès synchrone. Ce n'est pas le Safari de macOS, que ce poste ne peut pas mesurer.
- **Empreintes** : la DoR annonce 0,55 s pour 522 Mio avec 8 Mio de RAM. Mesuré : 1,12 s sous
  Chromium, 0,78 s sous Firefox, avec 8 Mio de tampon. La RAM est conforme ; la durée est le
  **double** sous Chromium, sans effet sur la conclusion.

## 3. Projection du boot à froid et critère d'arrêt

Volume que le boot lit réellement : **inconnu**. Aucun instrument actuel ne compte les blocs lus par
le guest pendant le boot. Deux hypothèses :

| Hypothèse                                                            | Surcoût Chromium (lecture 4 Kio + empreintes) | Sur 87,2 s  | Firefox      |
| -------------------------------------------------------------------- | --------------------------------------------- | ----------- | ------------ |
| prudente : disque entier, 522 Mio                                    | 24,7 + 1,1 = 25,8 s                           | **+29,6 %** | +3,4 s, +4 % |
| basse : 177 Mio (volume transféré à la réouverture, cité par la DoR) | 8,4 + 0,4 = 8,8 s                             | +10,1 %     | +1,2 s, +1 % |
| disque entier lu par blocs de 64 Kio                                 | 1,8 + 1,1 = 2,9 s                             | +3,3 %      | +1,2 s, +1 % |

Le surcoût est compté en série avec le boot, ce qui est pessimiste : une partie des lectures se
recouvrirait avec le calcul du guest si v86 lisait de façon asynchrone. Il est aussi optimiste sur
un point : le fichier sort d'une écriture récente, donc vraisemblablement du cache du système.

**Conclusion.** Sous l'hypothèse prudente exigée par la DoR, Chromium dépasse +25 % : **ARRÊT**.
Même l'hypothèse basse tombe dans la bande +10 à +25 %. Firefox resterait sous +10 %.

Ce que les mesures disent de la suite, pour la décision du client :

- le problème est le **nombre d'appels**, pas le débit ni la mémoire. Un cache de blocs plus large
  n'y change rien au premier boot ; la forme qui répond est la **lecture groupée** (lire 64 Kio ou
  plus par appel et servir les blocs de 4 Kio de v86 depuis ce tampon, ou précharger les zones
  chaudes) : +3 % mesuré sur le disque entier ;
- avant de rouvrir D1, compter les blocs réellement lus au boot lèverait l'hypothèse prudente.

## Ce qui n'est pas mesuré

- **Réouverture d'un coffre installé (DoR : 18 à 36 s, 177 Mio)** : non mesurée. Le banc mémoire n'a
  pas exercé l'instantané (`usedSnapshot: false`), et aucun outil existant ne rejoue la réouverture
  de la coquille sans un coffre installé à la main.
- **Premier démarrage** : estimé à environ 38 s de préparation + 90 s de boot, soit ≈ 128 s, par
  addition des phases du banc mémoire ; pas mesuré de bout en bout dans la coquille.
- **Volume lu par le boot** : inconnu (voir section 3).
- **WebKit / Safari** : pas d'OPFS dans le WebKit de Playwright sous Windows.

## Reproduire

```
npm run image:build
node tools/mesurer-memoire.mjs --essais=3
node tools/mesurer-debit-opfs.mjs --essais=3
```
