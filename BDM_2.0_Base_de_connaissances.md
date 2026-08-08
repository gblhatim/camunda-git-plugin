
# BDM 2.0 — Base de connaissances pour reconstruire la présentation

> Document de référence complet : contexte, chiffres, architecture, fonctionnalités du plugin (vérifiées dans le code), rôles, gouvernance, adoption, roadmap. Tout ce qui est dans `bdm-2.0-comite.html` est ici, plus des détails du code source qui n'ont pas encore été mis en slide.

---

## 1. Contexte

**BDM = Bureau de Méthode**, l'équipe de Hatim chez **Bouygues Telecom**.

**BDM 2.0** = initiative interne qui change **comment l'équipe produit une "méthode"**.

Une **méthode** = deux livrables couplés :
- Le **BPMN / workflow**, qui tourne sur **rFlow** (interface agent) / **Camunda** (moteur d'exécution)
- Le **ModOp**, document opératoire qui guide le workflow

**Hors scope explicite de BDM 2.0 :** le lien ModOp ↔ Confluence ↔ Airflow.

### Le changement en une phrase

| | Avant | Après (BDM 2.0) |
|---|---|---|
| Support | Drive partagé | Git (versioning complet) |
| Historique | Aucun | Historique Git complet |
| Déploiement | Manuel (Responsable mise en prod) | Pipeline CI/CD automatisé |
| Collaboration | Conflits, écrasements, gestion à la main | Branches isolées, dev local |
| Environnement de dev | Aucun | Environnement local complet (front/back rFlow + moteur Camunda) |

---

## 2. Les quatre piliers

BDM 2.0 ne se résume pas au plugin : il repose sur quatre piliers. Le plugin est ce qui les rend utilisables au quotidien, pas le sujet en lui-même.

1. **Gitflow** — le modèle de branches : `develop` pour le quotidien, `main` pour la production, `release/hotfix` pour l'intégration contrôlée.
2. **CI/CD** — le pipeline qui automatise build, tests et déploiement à chaque étape, sans intervention manuelle une fois le code poussé.
3. **Environnements locaux** — exécuter une méthode avant même de la pousser sur Git, via Airflow+Camunda ou Spring Boot+mocks.
4. **SonarQube** — la porte de qualité qui valide une méthode avant sa mise en production.

---

## 3. Les chiffres de gain

⚠️ **Ce sont des objectifs ciblés/estimés — pas des résultats mesurés.** Toujours le préciser à l'oral et à l'écrit.

**Gain par méthode produite :**

| Poste | Avant | Après |
|---|---|---|
| Mise en prod (déploiement, recette, tests camunda-bpm-assert, validation, comm) | 2j × 6p = **12 jh** | 0,5j × 1p = **0,5 jh** |
| Collaboration + Traçabilité | 0,2j × 6p = **1,2 jh** | **0 jh** |
| **TOTAL** | **13,2 jh** | **0,5 jh** |

**Résultat : −96% de charge · −90% de délai · facteur 26×**

Autre chiffre, séparé et à qualifier différemment : **+30% de productivité estimée** sur le périmètre Camunda.

**Si challengé sur le "5 jours" :** 5 jours calendaires dont **2,2 jours de travail effectif** — le reste est coordination et attente, pas du travail productif perdu par la nouvelle méthode.

---

## 4. Architecture — Avant BDM 2.0

Flux : **Drive partagé → Déploiement test → Environnement de test partagé → Recette manuelle → Déploiement prod → Production**

| Étape | Détail | Propriétaire |
|---|---|---|
| Drive partagé — dossier « Univers » | Deux sous-dossiers : « En ligne » (publié) et « En rédaction » (copie de travail renommée avec le numéro de ticket). Concurrence gérée à la main : on ajoute son nom et on met à jour la date à chaque changement. | Auteur Méthode |
| Déploiement vers l'environnement de test | Upload manuel sur rFlow. Ça marche ou ça renvoie une erreur — aucun contrôle qualité avant. | Auteur Méthode |
| Environnement de test partagé ⚠️ | Aucune isolation entre auteurs : première exécution du processus, quel qu'il soit. Deux méthodes en test peuvent se marcher dessus. | Sans propriétaire dédié |
| Recette manuelle | Test de non-régression fait à la main, dans l'environnement de test partagé. | Auteur Méthode, Validateur, Technique |
| Déploiement vers Production | Second upload manuel sur rFlow — même absence de contrôle automatisé. | Responsable mise en prod |
| Production | Version live unique et partagée. Une non-régression est **refaite ici** — le filet de sécurité arrive après la mise en ligne, pas avant. | Auteur Méthode & Validateur |

**Le point important :** c'est une limite de *processus* (pas d'environnement isolé pour tester avant mise à disposition), pas une limite des personnes qui l'exécutent aujourd'hui avec les moyens du bord.

---

## 5. Architecture — Après BDM 2.0 (vue d'ensemble)

Flux : **Poste de travail → Environnement local → Dépôt Git local → Remote GitLab → Préproduction → Production**

| Étape | Détail | Propriétaire |
|---|---|---|
| Poste de travail | Camunda Modeler avec le plugin Git installé : conception BPMN et gestion Git dans les mêmes panneaux, style VS Code. | Auteur Méthode |
| Environnement local (A/B) | Option A, Airflow + Camunda locaux : parité complète. Option B, Spring Boot + workers mockés : léger. | Auteur Méthode |
| Dépôt Git local | Commits, branches, historique complet — l'inverse du drive partagé sans mémoire. | Auteur Méthode |
| Remote GitLab | Push, Merge Request pour revue, suivi des issues, sans quitter le modeler. | Auteur Méthode + Relecteur |
| Préproduction | `develop` déclenche un déploiement automatique. Revue fonctionnelle ici ; si validée, la méthode est « livrée ». | Auteur Méthode + équipe |
| Production | `main` déclenche le déploiement — bloqué si la qualité SonarQube n'a pas été corrigée. rFlow exécute les méthodes déployées. | Intégrateur |

Note affichée sur le schéma : **ModOp ↔ Confluence ↔ Airflow reste hors scope de BDM 2.0.**

---

## 6. Architecture — Après BDM 2.0 (détaillée)

Flux en 9 étapes : **Poste de travail → Environnement local → Dépôt Git local → Remote GitLab → Pipeline CI/CD (develop) → Préproduction → Promotion vers main → Pipeline CI/CD (main) → Production**

| Étape | Détail | Propriétaire |
|---|---|---|
| Poste de travail | Camunda Modeler (Electron). Renderer = panneaux du plugin (statut, diff, commit, MR). Main process = `bridge.js`, accès Node complet pour parler à git. | Auteur Méthode |
| Environnement local | Switchable A/B (voir pilier 3). | Auteur Méthode |
| Dépôt Git local | Branches : `develop`, `main`, `feature/*`, `bugfix/*`, `hotfix/*`, `release/*`. Config partagée `.camunda-git.json` (branchModel, mergePolicy, préfixe de ticket) — écrite une fois pour toute l'équipe. | Auteur Méthode |
| Remote GitLab | MR : revue avant fusion. Issues : suivi des problèmes, même endroit que le reste du travail. | Auteur Méthode + Relecteur |
| Pipeline CI/CD (develop) | Déclenché à chaque push : build, tests (`camunda-bpm-assert`), scan qualité SonarQube. Le scan est **informatif** ici. | Automatique — Admin Git/CI |
| Préproduction | Déploiement automatique depuis `develop`. Revue fonctionnelle ; si validée, méthode « livrée ». | Auteur Méthode + équipe |
| Promotion vers main | Portée par l'Intégrateur. **Bloquée** tant que la qualité SonarQube détectée sur `develop` n'a pas été corrigée — la porte de qualité du projet. | Intégrateur |
| Pipeline CI/CD (main) | Déclenché à chaque push sur `main` : build, tests, déploiement. Atteint uniquement si la promotion a franchi la porte de qualité. | Automatique — Admin Git/CI |
| Production | Moteur Camunda / rFlow. N'atteint cette étape que si la revue préprod + la porte SonarQube sont passées. | Intégrateur / Admin |

---

## 7. Pilier 1 — Gitflow, le modèle

Deux branches longues, trois types de branches courtes :

| Type | Ticket | Part de | Fusionne dans |
|---|---|---|---|
| `feature/*` | requis | branche courante | branche courante (via MR revue) |
| `bugfix/*` | requis | branche courante | branche courante (via MR revue) |
| `release/*` | — | `develop` | `main` (tag de version) **et** `develop` (back-merge) |
| `hotfix/*` | optionnel | `main` (ce qui est **live**, pas `develop`) | `main` **et** `develop` |

- Nommage imposé : `feature/BDM-123456-slug` — le ticket reste toujours visible dans le nom de la branche (utile pour Jira, build log, standup).
- **release/\*** : l'intégrateur regroupe une livraison. Dual merge en une seule action « Intégrer » — l'oubli du back-merge (échec classique de Gitflow) est détecté automatiquement.
- **hotfix/\*** : correction urgente sur ce qui est déjà live, sans attendre le prochain cycle de livraison. Ticket optionnel car exiger un ticket avant de corriger un incident live est une règle qu'on finit par contourner.
- Config partagée `.camunda-git.json` (committée, pas locale) : choix **« tronc commun »** (`trunk` — une version partagée) ou **« Gitflow »** (`gitflow` — version publiée séparée), plus `baseBranch`, `releaseBranch`, `branchPrefixes`, `mergePolicy`, `jiraHost`, `jiraProjectKey`. Écrite une fois, valable pour toute l'équipe — jamais générée automatiquement (ça salirait une copie propre à l'ouverture du panneau).
- Config locale séparée (`~/.camunda-git-plugin/config.json`, par personne/machine) : dossier ouvert, tokens, auto-pull, mode développeur. La séparation existe parce qu'analystes et développeurs travaillent dans le même repo — "d'où partent les features" ne peut pas être une supposition par machine.

---

## 8. Pilier 2 — CI/CD, le pipeline

Étapes : **Build (compilation) → Tests (camunda-bpm-assert) → SonarQube (sur develop uniquement) → Déployer (préprod ou prod)**

Deux instances du même pipeline :
- Sur **develop** : déploie en préproduction, scan SonarQube **informatif**.
- Sur **main** : déploie en production — atteint uniquement si la porte de qualité a été franchie.

Ce qui prenait 2 jours et 6 personnes en manuel se déclenche automatiquement à chaque push.

---

## 9. Pilier 3 — Environnements locaux (détail complet)

**Option A — Airflow + Camunda locaux**
- Réplique complète de l'environnement réel, y compris les appels aux API externes utilisées par Airflow et l'équipe.
- + Parité totale avec la production, aucun comportement mocké.
- + Fonctionne désormais pour tous les workers — la contrainte de certificats SSL qui bloquait la communication avec les API externes est levée *(chiffre/statut à reconfirmer auprès du repo backend Airflow/rFlow — non vérifiable depuis le repo du plugin)*.
- − Setup plus lourd : deux systèmes à faire tourner localement.

**Option B — Spring Boot + workers mockés**
- Camunda (Spring Boot embarqué) avec les workers en external task pattern mockés, base de données simulée — pas d'Airflow réel.
- + Léger et rapide à lancer, rien à installer côté Airflow.
- + Suffisant pour tester le comportement du workflow lui-même.
- − Ne couvre que les workers déjà mockés : **3 sur 29** aujourd'hui *(chiffre à reconfirmer auprès du repo backend — non vérifiable depuis le repo du plugin)*. Couverture priorisée par méthode plutôt qu'exhaustive.

---

## 10. Pilier 4 — SonarQube, la porte de qualité

Un scan de la **qualité du BPMN**, pas de la logique métier.

| Moment | Comportement |
|---|---|
| Sur develop (préproduction) | Le scan tourne à chaque push mais **n'empêche jamais** le déploiement en préprod — il informe, il ne bloque pas. |
| À la promotion vers main | Le même résultat devient **bloquant**. Une méthode dont la qualité n'a pas été corrigée ne peut pas atteindre la production. |
| Ce qui est évalué | La structure du diagramme, pas le contenu métier : nommage des éléments, flux inutilisés ou orphelins, complexité des gateways, documentation minimale sur les tâches. |

Le détail exact des règles reste à valider avec l'équipe SonarQube — le principe acté est : **informatif tôt, bloquant tard**. *(Non vérifiable depuis le repo du plugin — la config Sonar vit dans le repo CI/CD séparé.)*

---

## 11. Le plugin — ce qu'il fait concrètement (vérifié dans le code)

Le plugin ne remplace pas Gitflow, CI/CD ou SonarQube — il les rend utilisables au quotidien sans terminal.

### Fonctionnalités Git de base
- **Prise en main guidée ("My work")** : checklist ordonnée et non un wizard — pensée pour quelqu'un qui arrive à mi-chemin (dossier déjà un repo, mais sans commit). Étapes : choisir le dossier (ou cloner via un lien), démarrer le suivi (`git init -b main`, jamais `master`), se déclarer (identité écrite **par projet**, jamais `--global`), créer le premier point de sauvegarde, connecter le serveur d'équipe (vérifié par `ls-remote` avant d'être accepté, pour éviter qu'un typo n'échoue que bien plus tard au push), configurer le fonctionnement d'équipe.
- **Usage quotidien** : statut, diff, commit, push, pull en un clic. Vocabulaire non technique — `M`→MODIFIÉ, `A`→AJOUTÉ, `D`→SUPPRIMÉ, `?`→NOUVEAU ; extensions `.bpmn/.dmn/.form` masquées à l'affichage ; chemin brut et lettre git d'origine gardés en tooltip pour les développeurs.
- **Diff visuel BPMN** : éléments ajoutés/modifiés surlignés directement sur le diagramme (via `bpmn-js-differ`), éléments supprimés listés à côté — pas de XML à lire.
- **Historique & traçabilité** : graphe de branches (DAG), calculé côté main process pour être testable contre `git log --graph` réel. Commits de fusion en cercles creux, couleur par colonne.
- **Activité (journal des commandes)** : chaque commande git passée par un Proxy autour de `simple-git`, chronométrée, avec son origine (`user` ou `auto`, via `AsyncLocalStorage` pour ne jamais mal étiqueter une action qui chevauche un pull automatique). Résultat de chaque commande affiché, replié par défaut, déplié automatiquement en cas d'échec.
- **Traduction des erreurs git** (`git-errors.js`) : chaque erreur brute de git traduite en langage clair + une action proposée quand elle ne peut pas faire perdre de travail. Ex. *"refusing to merge unrelated histories"* → *"Ces deux projets ont été démarrés séparément"* + bouton "Combiner quand même". Une erreur non reconnue garde son texte technique original sous un menu dépliable, plutôt que d'être cachée.

### Merge Request & revue
- **Revue en Merge Request** : ouvrir une MR GitLab et suivre son état depuis le modeler, sans changer d'outil. Plus avancé que la simple ouverture de lien : le plugin reproduit localement les MR en conflit pour permettre une résolution visuelle.
- **Signaler un problème** : consulter la liste des issues GitLab ouvertes sur le dépôt, directement depuis le plugin. La **création** d'une issue se fait pour l'instant encore sur GitLab (le plugin ouvre l'issue dans le navigateur au clic, il ne crée pas encore).

### Release & branches
- **Release & hotfix** : version suggérée automatiquement, une seule action « Intégrer » fait le double merge vers `main` et `develop` ; le retour oublié vers `develop` est détecté automatiquement.
- **Workstreams (branches présentées côté utilisateur)** : une branche = "la chose sur laquelle je travaille", pas un concept de DAG. Nom affiché dérivé du nom réel (`feature/BDM-123456-invoice-approval-redesign` → *"BDM-123456 · Invoice approval redesign"*), jamais stocké séparément pour ne pas désynchroniser. Nouvelle branche créée sans upstream automatique (`--no-track`) pour éviter le piège où un `push` atterrit silencieusement sur la branche partagée. Chaque changement de branche **sauvegarde d'abord** ce qui est en cours (`saveWorkInProgress`) — "impossible de changer de branche, vous avez des changements locaux" n'arrive jamais.

### Résolution de conflit guidée
- Panneau dédié qui bascule entièrement en mode résolution — jamais d'auto-résolution silencieuse, jamais un fichier truffé de marqueurs bruts.
- Résolution **au niveau fichier uniquement** (un merge ligne-à-ligne d'un XML BPMN ne produirait ni l'un ni l'autre diagramme).
- **"Combiner les deux"** : fusionne les deux versions en une seule quand les changements ne se chevauchent pas (l'un renomme une tâche, l'autre en ajoute une) — vérifié élément par élément après coup ; si la fusion automatique ne peut pas être garantie correcte, l'option n'est simplement pas proposée (correct-ou-abstention, jamais une fusion potentiellement fausse).
- Autres choix : "Montrer les deux" (rendu côte à côte), "Garder ma version", "Garder celle de l'équipe", "Terminer", "Recommencer" (`merge --abort`, n'affecte jamais le travail déjà commité).
- Gère aussi rebase/cherry-pick/revert laissés en cours (pas seulement les merges), avec inversion correcte de "ours/theirs" pendant un rebase.

### Garde-fous
- **Mode développeur** (off par défaut, par personne) : sépare l'usage occasionnel des opérations sensibles. Une fois activé, ouvre une console git dans l'onglet Activité — un **exécuteur git, pas un shell** (argv direct, jamais via `sh`/`cmd`, donc pas de pipes/`&&`/backticks). Permet reset/stash/rebase/amend, volontairement absents comme boutons ailleurs.
- **Jamais de push direct vers main en modèle Gitflow.** En modèle tronc commun (solo), un mode « fusion directe » (`mergePolicy: 'direct'`) existe, avec avertissement explicite à l'écran.
- **Auto-pull** (off par défaut) : ne se déclenche que si tout est réuni — activé, remote existant, arbre de travail complètement propre, aucun merge à moitié fait, aucune autre opération en cours. Ne se déclenche jamais au démarrage de Modeler.

### Fonctionnalités IA (déjà livrées, pas en "Perspectives")
- **Édition assistée par IA** (`ai-service.js`, via OpenRouter, modèle par défaut `claude-sonnet-4.5`) : décrire un changement en langage naturel ; le modèle renvoie le XML BPMN complet modifié. Conception **preview-then-apply** : rien de ce que le modèle renvoie n'est fait confiance — c'est parsé avant d'être proposé (rejeté si invalide), diffé contre l'original pour que le changement soit visible, et écrit sur disque seulement si l'utilisateur accepte (jamais commité automatiquement). Seules deux choses quittent la machine, et seulement sur preview explicite : le XML du diagramme et l'instruction.
- **Catalogue de patterns prêts à l'emploi** (`catalog-service.js`, `catalog/index.json` + fichiers `.bpmn`) : diagrammes types (approbation, boucle de relance/retry, revue parallèle...) livrés avec le plugin, à copier pour démarrer une méthode sans repartir de zéro. Lus depuis le dossier du plugin, jamais depuis le repo utilisateur — disponibles avant même qu'un projet soit configuré.
- **Recherche sémantique** (`search-service.js`) : recherche à travers tout le corpus de diagrammes du projet, pas un grep de texte — "trouve toutes les tâches assignées à jdoe" ou "tout ce qui appelle InvoiceProcess" en une requête plutôt qu'en ouvrant quarante diagrammes. Chaque fichier indexé une fois, mis en cache par date de modification.

---

## 12. Le plugin face à la définition standard de Gitflow

| Gitflow (règle standard) | Le plugin |
|---|---|
| Deux branches longues : develop/main, branches feature/, hotfix/ | Choix « tronc commun » ou « Gitflow » dans les réglages, écrit dans `.camunda-git.json` partagé |
| Départ de branche = convention humaine | Automatique : feature/bugfix partent de develop, hotfix de main |
| Nommage = convention | Imposé : `feature/BDM-123456-slug`, lisible en clair dans l'UI |
| Release/hotfix → merge dans main ET develop (2 commandes) | Une action « Intégrer » fait les deux merges `--no-ff` |
| Oubli du back-merge = échec classique et silencieux | Détecté et signalé automatiquement |
| Versioning = discipline humaine | Suggestion auto de version + validation du tag |
| Conflits = git brut | Panneau de résolution dédié, jamais d'auto-résolution |
| Pas de contrôle sur qui touche main | Mode développeur : l'auteur n'a pas accès aux commandes qui atteignent main |

---

## 13. Rôles — RACI avant / après

**Légende** : R Responsable (exécute) · A Approbateur (rend des comptes) · C Consulté · I Informé.

### Avant

| Étape | Auteur Méthode | Resp. mise en prod | Validateur |
|---|---|---|---|
| Copier / renommer sur le drive | R/A | – | – |
| Déployer vers l'env. de test | R/A | – | – |
| Recette / non-régression | R | I | R |
| Déployer vers Production | I | R/A | I |
| Non-régression en production | R | I | R |

Une même case R/A = aucune séparation entre exécution et responsabilité finale — le symptôme principal du fonctionnement actuel.

### Après

| Use case | Auteur Méthode | Intégrateur | Relecteur | Admin Git/CI | Comité |
|---|---|---|---|---|---|
| Créer une branche | R/A | – | I | C | – |
| Modifier & committer | R/A | – | I | – | – |
| Ouvrir une MR | R/A | I | C | I | – |
| Revue (diff visuel) | I | I | R/A | C | – |
| Conflit (intégration release/hotfix) | I | R/A | C | C | – |
| Tag / version | I | R/A | I | A | – |
| Déploiement CI/CD → prod | I | R/A | – | A | I |

Comparé à "avant" : chaque étape a désormais un A distinct de son R sur les points sensibles (conflit d'intégration, tag, déploiement prod).

---

## 14. Gouvernance — le risque de bus factor

**Le problème :** la connaissance du pipeline CI/CD est concentrée sur deux points de défaillance : **Hatim** (architecture, logique, debug, évolution) et les **interns** (implémentation) — **temporaires**.

**Conséquence si Hatim part :** personne ne peut débugger, maintenir ou faire évoluer BDM 2.0.

**Les 4 zones critiques à documenter (avant départ des interns), par ordre de criticité :**
1. **Pipeline CI/CD** (build, checks, déploiement) — le plus critique
2. **Git Flow** (branches, merge, conventions)
3. **Configuration du moteur Camunda** (environnements, déploiement)
4. **Règles de validation** (SonarQube, checks BPMN)

Un cadre de gouvernance "à remplir" pour Confluence a été construit séparément (`BDM_2.0_Gouvernance.md`).

---

## 15. Adoption

### Plan de formation — atelier en deux temps

| Public | Contenu |
|---|---|
| Tout le monde | Concepts + prise en main guidée du plugin (checklist « My work », premier commit, flux quotidien branche → commit → push → MR) sur un cas réel |
| Futurs intégrateurs | Release/hotfix, résolution de conflits, mode développeur |
| Support | Fiche mémo + créneau de questions après la formation |

### Déploiement du plugin

- **Pas de build nécessaire** : le plugin tourne dans le process principal d'Electron, sans étape webpack pour l'utilisateur final (webpack sert seulement à builder `client/dist/client.js` en amont).
- **Installation** : copie du dossier dans le répertoire plugins de Camunda Modeler + `npm install`.
- **Rollout en trois vagues** : Pilote (1-2 volontaires) → ajustements → généralisation avec formation.

---

## 16. Perspectives / roadmap réel

- **Déjà livré**, pas à venir : édition assistée par IA, catalogue de patterns, recherche sémantique (voir section 11).
- **Construit avec Claude Code.**
- **Ce qui reste réellement hors périmètre** : les autres évolutions rFlow non liées à l'authoring Git/BPMN de ce plugin.
- Pistes issues du code mais non encore mises en avant en comité : création d'issue directement depuis le plugin (aujourd'hui liste seule), routine "Save my work" comme point d'entrée unique (déjà codée, à mettre en avant dans la démo), mode "combine both" pour les conflits comme argument différenciant fort (résolution de conflit qu'un client Git générique ne propose pas).

---

## 17. Détails techniques additionnels (utiles en Q&A comité, pas forcément pour les slides)

- **Architecture technique du plugin** : deux moitiés qui ne peuvent pas se parler directement (contrainte de sécurité de Camunda Modeler — allowlist IPC figée). Le plugin sert une API HTTP loopback (`127.0.0.1:45678`) que le renderer interroge, avec un token régénéré à chaque lancement.
- **Sécurité** : tokens stockés en clair dans `~/.camunda-git-plugin/config.json` (limitation connue, documentée) ; validation anti-traversal sur les chemins de fichiers avant toute commande git ; routes mutantes en POST uniquement.
- **Ce que le plugin ne fait délibérément pas** : discard de changements non sauvegardés (pas de bouton pour supprimer un travail non commité — trop dangereux, pas d'annulation possible), force-push, reset automatique.
- **Statut du code** : `package.json` → nom `camunda-git-plugin`, version `0.1.0`. Suite de tests couvrant IA, catalogue, recherche, fusion/merge, MR, revue de MR, overview, support (`test/*.test.js`).
- **Ce qui doit être reconfirmé avant le comité** (non vérifiable depuis ce seul repo, vit dans le repo backend Airflow/rFlow ou le repo CI/CD séparé) : le nombre exact de workers mockés (« 3 sur 29 »), le statut de la contrainte SSL, la configuration exacte des règles SonarQube.

---

*Sources : `bdm-2.0-comite.html` (présentation existante), `README.md` du plugin, lecture directe de `menu/*.js` et `ui/*.js` (ai-service, catalog-service, search-service, config-store, project-setup, release-service, conflict-service, settings-service, merge-request-service, routines, naming, git-errors, history-service, command-log, git-console), `BDM_memoire.md`, mémoire de session.*
