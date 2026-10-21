---
name: work-on-pr
description: Travailler sur une Pull Request GitHub — bascule la branche locale sur celle de la PR, charge le contexte (description, commentaires et threads de review non résolus, état de la CI et logs d'échec, ticket Jira associé), puis aide à appliquer correctifs et améliorations, pousser, répondre aux reviewers et valider le ticket Jira. À utiliser quand l'utilisateur dit "travaille sur la PR #123", "reprends ma PR", "corrige les retours de review", "la CI est rouge sur la PR", "fix la PR" ou colle une URL de PR GitHub.
---

# Skill PR : Travailler sur une Pull Request

## Objectif

Reprendre une PR là où elle en est : **basculer sur sa branche**, rassembler **tout le contexte utile** (retours de review, CI, ticket Jira), puis **corriger / améliorer**, pousser et clôturer la boucle avec les reviewers et Jira — chaque écriture externe étant **validée explicitement**.

## Configuration

Variables chargées depuis `~/.ia/.env` (même fichier que `agents/jira/manager.md`, `agents/github/reviewer_presta.md` et le skill `tempo-log`) :

| Variable | Rôle |
|---|---|
| `GITHUB_TOKEN` | PAT GitHub (lecture PR / CI, push, réponses aux commentaires) |
| `JIRA_EMAIL` | E-mail Atlassian |
| `JIRA_TOKEN` | Jeton API Atlassian (Basic Auth Jira) |
| `JIRA_PROJECT_KEY` | Projet par défaut (ex. `SCE`) |

Si `GITHUB_TOKEN` est absent, s'arrêter et l'expliquer. Si les variables Jira manquent, continuer sans la partie Jira en le signalant.

```bash
set -a; source ~/.ia/.env; set +a
GH=https://api.github.com
JIRA=https://prestashop-jira.atlassian.net/rest/api/3
H=(-H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
```

`gh` n'est pas forcément installé : utiliser `curl` + `jq` sur l'API REST (spécification : `agents/github/github-api.json`).

## Identification de la PR

Accepter en argument :
- une URL `https://github.com/{owner}/{repo}/pull/{n}` ;
- `{owner}/{repo}#{n}` ;
- `#{n}` ou `{n}` seul → `{owner}/{repo}` déduit du remote `upstream`, sinon `origin` du dépôt courant ;
- rien → chercher une PR ouverte dont la branche est la branche courante :
  `GET $GH/repos/{owner}/{repo}/pulls?head={owner_fork}:{branche}&state=open`.

Si plusieurs PR correspondent ou si le dépôt courant n'est pas celui de la PR, demander à l'utilisateur.

## API utilisées

**GitHub REST v3** :
- `GET $GH/repos/{o}/{r}/pulls/{n}` → titre, corps, `head.ref`, `head.sha`, `head.repo.clone_url`, `base.ref`, `mergeable`, `mergeable_state`, `draft`.
- `GET $GH/repos/{o}/{r}/pulls/{n}/files?per_page=100` → fichiers modifiés.
- `GET $GH/repos/{o}/{r}/pulls/{n}/reviews` → reviews (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`).
- `GET $GH/repos/{o}/{r}/pulls/{n}/comments?per_page=100` → commentaires inline (`path`, `line`, `body`, `in_reply_to_id`).
- `GET $GH/repos/{o}/{r}/issues/{n}/comments?per_page=100` → commentaires de conversation.
- `GET $GH/repos/{o}/{r}/commits/{sha}/check-runs?per_page=100` → checks (`name`, `status`, `conclusion`, `details_url`).
- `GET $GH/repos/{o}/{r}/commits/{sha}/status` → statuts « legacy » (CI externes).
- `GET $GH/repos/{o}/{r}/actions/runs/{run_id}/jobs` puis `GET $GH/repos/{o}/{r}/actions/jobs/{job_id}/logs` → logs d'un job en échec (suivre la redirection avec `curl -L`).
- `POST $GH/repos/{o}/{r}/pulls/{n}/comments/{comment_id}/replies` avec `{"body": "..."}` → répondre à un commentaire inline.
- `POST $GH/repos/{o}/{r}/issues/{n}/comments` → commentaire de conversation.
- `POST $GH/repos/{o}/{r}/actions/runs/{run_id}/rerun-failed-jobs` → relancer les jobs en échec (flaky).

**GitHub GraphQL** (`POST $GH/graphql`), seul moyen de connaître l'état **résolu / non résolu** des threads :
```graphql
query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
  reviewThreads(first:100){nodes{id isResolved isOutdated path line
    comments(first:50){nodes{databaseId author{login} body createdAt}}}}}}}
```
Résoudre un thread : mutation `resolveReviewThread(input:{threadId:"..."})`.

**Jira** (Basic Auth `$JIRA_EMAIL:$JIRA_TOKEN`, cf. `agents/jira/manager.md`) :
- `GET $JIRA/issue/{KEY}?fields=summary,status,description,issuetype,assignee,fixVersions,customfield_*` → contenu du ticket (description en ADF : en extraire le texte, les listes et les critères d'acceptation).
- `GET $JIRA/issue/{KEY}/comment` → commentaires du ticket.
- `GET $JIRA/issue/{KEY}/transitions` puis `POST $JIRA/issue/{KEY}/transitions` avec `{"transition":{"id":"..."}}` → changement de statut.
- `POST $JIRA/issue/{KEY}/comment` avec un `body` **ADF** → commentaire.

En cas de `403` sur l'organisation `PrestaShop`, le PAT n'est probablement pas autorisé SSO : le signaler.

## Déroulé

Le skill se déroule en **4 étapes successives**. Chaque étape se termine par un point d'arrêt : ne jamais passer à la suivante sans réponse de l'utilisateur.
Annoncer l'étape en cours en tête de message (ex. `### Étape 1/4 — Bascule sur la branche`).

### Étape 1/4 — Bascule sur la branche

1. **Récupérer la PR** (`GET pulls/{n}`). Si elle est fermée / mergée, prévenir et demander s'il faut continuer.
2. **Vérifier l'état local** : `git status --porcelain`. S'il y a des modifications non commitées, **ne rien écraser** : proposer `git stash push -u -m "work-on-pr #{n}"`, un commit, ou l'abandon — et attendre la réponse.
3. **Checkout** :
   - PR du même dépôt : `git fetch origin {head.ref}` puis `git switch {head.ref}` (ou `git switch -c {head.ref} --track origin/{head.ref}`) ;
   - PR depuis un fork : ajouter (si absent) un remote nommé d'après le login du fork vers `head.repo.clone_url`, `git fetch {fork} {head.ref}`, puis `git switch -c {head.ref} --track {fork}/{head.ref}` ;
   - branche locale existante : `git switch` puis `git pull --ff-only` ; si l'historique a divergé (rebase / force-push distant), le signaler et demander avant tout `reset`.
4. Vérifier que `HEAD` correspond à `head.sha`. Si `maintainer_can_modify` est faux sur un fork dont l'utilisateur n'est pas l'auteur, prévenir que le push sera impossible.
5. Signaler les conflits avec la base (`mergeable == false` / `mergeable_state == "dirty"`).

**⏸ Point d'arrêt** si une décision a été nécessaire (stash, divergence, PR fermée). Sinon enchaîner directement sur l'étape 2.

### Étape 2/4 — Chargement du contexte

Collecter (lecture seule), puis présenter une **synthèse** :

1. **PR** : titre, auteur, base ← head, draft, nombre de fichiers / lignes, description résumée.
2. **Ticket Jira** : chercher une clé `[A-Z][A-Z0-9]+-\d+` dans `head.ref`, le titre, le corps puis les messages de commit. Charger le ticket : titre, statut, description, **critères d'acceptation** (section dédiée de la description ou liste à cocher), derniers commentaires. Sans clé, l'indiquer (et demander si un ticket est attendu).
   Si le corps référence une issue GitHub (`Fixes #123`, `Closes …`), la charger aussi.
3. **Retours de review** : uniquement les threads **non résolus** (GraphQL), regroupés par fichier, plus les reviews `CHANGES_REQUESTED` et les commentaires de conversation sans réponse de l'auteur. Ignorer les threads `isOutdated` déjà traités, les bots de label / CLA.
4. **CI** : liste des checks sur `head.sha` avec leur état. Pour chaque check **en échec**, récupérer le log du job et en extraire **l'erreur utile** (test qui échoue, message PHPStan / PHP-CS-Fixer / ESLint, assertion, stack trace) — pas le log brut. Distinguer les échecs probablement **flaky / infra** (timeout, réseau, service indisponible) des échecs liés au code.

Restitution sous forme de **liste d'actions numérotée** :

| # | Source | Fichier / Check | Constat | Action proposée |
|---|---|---|---|---|
| 1 | Review @alice | `src/Core/Foo.php:42` | Variable mal nommée | Renommer `$data` en `$orderLines` |
| 2 | CI `PHPStan` | `src/Adapter/Bar.php:88` | Méthode inexistante | Corriger l'appel |
| 3 | CI `UI tests` | — | Timeout Selenium | Relancer le job (flaky) |
| 4 | Jira OS-12 | — | Critère « log de l'erreur » non couvert | Ajouter le log |

Suivre les règles du dépôt : `CLAUDE.md`, dossier `.ai/`, et pour PrestaShop les ADR (cf. `agents/github/reviewer_presta.md`).

**⏸ Point d'arrêt** : demander quelles actions traiter (toutes, une sélection, ou d'autres améliorations).

### Étape 3/4 — Correctifs et améliorations

1. Traiter les actions retenues, une par une, en lisant le code concerné avant de le modifier. Pour un retour de review discutable, proposer une réponse argumentée plutôt que de l'appliquer aveuglément.
2. **Vérifier localement** ce qui est faisable (tests unitaires ciblés, PHPStan, linter, `composer`/`npm` scripts du projet) en reproduisant la commande du check CI en échec quand c'est possible. Indiquer clairement ce qui n'a pas pu être vérifié.
3. Présenter le **diff** et un résumé par action (`#1 ✅`, `#2 ✅`, `#3 ⏭ relance CI`).
4. Proposer un ou plusieurs messages de commit suivant la convention du dépôt (lire `git log` de la branche), en conservant la clé Jira si elle y figure.

**⏸ Point d'arrêt** : demander « Commiter et pousser ces modifications sur `{head.ref}` ? (OUI/NON) ». Ne jamais faire de `push --force` sans demande explicite (`--force-with-lease` uniquement, après accord).

### Étape 4/4 — Push, reviewers et Jira

Chaque écriture ci-dessous nécessite un **OUI** explicite ; les proposer groupées :

1. **Push** : `git commit` puis `git push` vers le remote de la branche. Afficher le SHA poussé.
2. **CI** : relancer les jobs flaky si demandé (`rerun-failed-jobs`), puis indiquer le lien vers les checks du nouveau commit.
3. **Reviewers** : proposer pour chaque thread traité une réponse courte **en anglais** (ex. `Done in abc1234.`, ou l'argumentaire si le retour n'a pas été appliqué), et éventuellement la résolution du thread. Ne pas résoudre un thread ouvert par quelqu'un d'autre sans accord.
4. **Validation Jira** (si ticket associé) :
   - confronter les modifications de la PR aux **critères d'acceptation** du ticket : tableau critère → ✅ couvert (fichier / test) / ⚠️ partiel / ❌ non couvert ;
   - proposer un commentaire Jira (en français, format ADF) résumant ce qui a été fait, avec le lien de la PR ;
   - proposer une transition adaptée (ex. `To be reviewed`, `To be tested`) : lister les transitions disponibles et laisser l'utilisateur choisir. Ne jamais faire passer le ticket en `Done` / `Closed` sans demande explicite.
5. **Compte rendu** : ce qui a été poussé, réponses envoyées, état Jira, éléments restants. Proposer de logger le temps passé avec le skill `tempo-log`.

## Règles

- Ne jamais perdre de travail local : pas de `reset --hard`, `checkout -- .`, `clean -f` ni de suppression de branche sans accord explicite.
- Toute action `POST` / `PATCH` / `PUT` / `DELETE` (GitHub ou Jira), tout `push`, nécessite un **OUI** explicite.
- Langue : échanges avec l'utilisateur et commentaires Jira en **français** ; commentaires GitHub et messages de commit en **anglais** (standard open source PrestaShop).
- Ne pas répéter un point déjà soulevé ou déjà répondu dans les threads.
- Les logs de CI peuvent être volumineux : les télécharger dans le scratchpad et n'en extraire que les lignes pertinentes.
- Erreurs HTTP : afficher le message renvoyé. `401` → jeton invalide ; `403` → SSO non autorisé ou droits insuffisants ; `404` sur une PR de dépôt privé → jeton sans accès au dépôt ; `422` sur une réponse → commentaire parent introuvable ou outdated.
