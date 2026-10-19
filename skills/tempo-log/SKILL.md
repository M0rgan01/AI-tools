---
name: tempo-log
description: Logger du temps dans Tempo (Jira Cloud) — saisie de worklogs sur des tickets Jira, consultation du temps déjà loggé, complétion d'une journée ou d'une semaine. À utiliser quand l'utilisateur parle de "logger son temps", "Tempo", "worklog", "imputer des heures", "remplir ma feuille de temps" ou donne une durée associée à un ticket (ex. "2h sur SCE-123").
---

# Skill Tempo : Saisie du temps

## Objectif

Aider l'utilisateur à saisir ses worklogs dans **Tempo Timesheets** (Jira Cloud) de façon rapide et fiable :
consulter ce qui est déjà loggé, proposer des entrées à partir du contexte, **faire valider**, puis créer les worklogs.

## Configuration

Variables chargées depuis `~/.ia/.env` :

| Variable | Rôle |
|---|---|
| `JIRA_EMAIL` | E-mail Atlassian |
| `JIRA_TOKEN` | Jeton API Atlassian (Basic Auth Jira) |
| `JIRA_PROJECT_KEY` | Projet par défaut (ex. `SCE`) |
| `TEMPO_TOKEN` | Jeton API Tempo — *Tempo > Settings > API integration > New token* |
| `TEMPO_DAILY_HOURS` | Optionnel, objectif journalier (défaut : `7`) |
| `GITHUB_TOKEN` | PAT GitHub, pour l'activité GitHub |

Si `TEMPO_TOKEN` est absent, expliquer comment le générer et s'arrêter.

```bash
set -a; source ~/.ia/.env; set +a
JIRA=https://prestashop-jira.atlassian.net/rest/api/3
TEMPO=https://api.tempo.io/4
GH=https://api.github.com
```

## API utilisées

**Jira** (Basic Auth `$JIRA_EMAIL:$JIRA_TOKEN`) :
- `GET $JIRA/myself` → `accountId` de l'utilisateur (à récupérer une fois par session).
- `GET $JIRA/issue/{KEY}?fields=summary,status` → `id` numérique + titre du ticket.
- `POST $JIRA/search/jql` avec `{"jql": "...", "fields": ["summary","status"]}` → recherche de tickets.

**Tempo v4** (header `Authorization: Bearer $TEMPO_TOKEN`) :
- `GET $TEMPO/worklogs/user/{accountId}?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=1000` → worklogs existants.
- `POST $TEMPO/worklogs` → création :
  ```json
  {
    "authorAccountId": "<accountId>",
    "issueId": 123456,
    "timeSpentSeconds": 7200,
    "startDate": "2026-10-19",
    "startTime": "09:00:00",
    "description": "Revue de PR module B2B"
  }
  ```
- `PUT $TEMPO/worklogs/{tempoWorklogId}` / `DELETE $TEMPO/worklogs/{tempoWorklogId}` → correction.
- `GET $TEMPO/work-attributes` → attributs obligatoires éventuels (ex. `_Account_`), à ajouter via `"attributes": [{"key": "...", "value": "..."}]`.

**GitHub REST v3** (spécification : `agents/github/github-api.json`) — headers :
`Authorization: Bearer $GITHUB_TOKEN`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
- `GET $GH/user` → `login` de l'utilisateur (une fois par session).
- `GET $GH/users/{login}/events?per_page=100&page=N` → flux d'activité horodaté (pages 1 à 3, s'arrêter dès que `created_at` < début de période). Types utiles :
  `PushEvent` (commits poussés), `PullRequestEvent` (PR ouverte / fermée / mergée), `PullRequestReviewEvent`, `PullRequestReviewCommentEvent`, `IssueCommentEvent`, `CreateEvent` (branche créée).
- `GET $GH/search/issues?q=` (complément, car le flux d'événements est limité à 300 entrées et peut omettre certains dépôts) :
  - `type:pr author:{login} updated:{from}..{to}` → PR créées / mises à jour ;
  - `type:pr reviewed-by:{login} updated:{from}..{to}` → PR revues ;
  - `commenter:{login} updated:{from}..{to}` → PR / issues commentées.
- `GET $GH/search/commits?q=author:{login}+author-date:{from}..{to}` → commits authored sur la période (y compris non poussés via un `PushEvent` visible).
- `GET $GH/repos/{owner}/{repo}/pulls/{number}` → `head.ref` (nom de branche), titre et corps d'une PR pour retrouver la clé Jira.

En cas de `403` sur l'organisation `PrestaShop`, le PAT n'est probablement pas autorisé SSO : le signaler et continuer sans les dépôts concernés.

⚠️ Tempo v4 attend l'**`issueId` numérique**, pas la clé `SCE-123` : toujours résoudre la clé via Jira avant le POST.

## Déroulé

Le skill se déroule en **3 étapes successives**. Chaque étape se termine par un point d'arrêt : ne jamais passer à la suivante sans réponse de l'utilisateur.
Annoncer l'étape en cours en tête de message (ex. `### Étape 1/3 — Récupération des activités`).

Si l'utilisateur fournit d'emblée des entrées complètes ("2h sur SCE-123 revue PR, 1h30 réunion SCE-45"), la récupération GitHub de l'étape 1 est facultative : la proposer sans l'imposer. Les étapes 2 et 3 restent obligatoires.

### Étape 1/3 — Récupération des activités

1. **Période** : par défaut aujourd'hui. Comprendre "hier", "lundi", "cette semaine", etc. Ignorer les week-ends sur une semaine, sauf demande explicite.
2. **Temps déjà saisi** : récupérer les worklogs Tempo existants et afficher par jour : total loggé / objectif (`TEMPO_DAILY_HOURS`) et reste à saisir.
3. **Collecte** (lecture seule, aucune écriture) :
   - **activité GitHub** de la période (voir section API) : PR ouvertes / mergées, reviews, commentaires, commits ;
   - clés de tickets dans la branche git courante et dans `git log --since=<date> --author="$(git config user.name)"` du dépôt courant ;
   - tickets Jira assignés et mis à jour sur la période :
     `assignee = currentUser() AND updated >= "<from>" AND updated <= "<to> 23:59" ORDER BY updated DESC`.
4. **Rattachement GitHub → Jira** : chercher une clé `[A-Z][A-Z0-9]+-\d+` dans, par ordre de priorité, le nom de branche (`head.ref`), le titre de la PR, son corps, puis les messages de commit. Vérifier que la clé existe via Jira. Sans clé, marquer l'entrée `❓ ticket à préciser`.
5. **Restitution** : présenter l'activité groupée par jour puis par ticket, sous forme de chronologie :

   | # | Date | Ticket | Titre | Activité | Plage horaire | Durée proposée |
   |---|---|---|---|---|---|---|
   | 1 | 19/10 | SCE-123 | Export B2B | 4 commits, PR #812 ouverte | 09:12 → 12:40 | ❓ |
   | 2 | 19/10 | ❓ | PR PrestaShop#3901 (review) | 1 review, 3 commentaires | 14:05 → 14:50 | ❓ |

   - Séparer les **reviews de PR d'autres personnes** de son propre développement.
   - La plage horaire est un indice, pas une durée : ne jamais inventer de durée. La colonne « Durée proposée » reste `❓` sauf si l'utilisateur l'a déjà donnée.

**⏸ Point d'arrêt** : demander si la liste est complète et passer à l'étape 2.

### Étape 2/3 — Ajouts et modifications

Boucle d'édition sur le tableau numéroté, jusqu'à ce que l'utilisateur dise que c'est bon :

- **Compléter** : demander les durées manquantes et les tickets `❓` (ex. ticket de support / revue générique). Poser les questions groupées, pas une par une.
- **Ajouter** : activités hors GitHub (réunions, support, spécifications…), avec ticket, durée et description.
- **Modifier** : ticket, durée, date, heure de début, description d'une ligne (`#2 → SCE-45, 45m`).
- **Fusionner / scinder / supprimer** des lignes (`fusionne 1 et 3`, `supprime 4`).
- **Description** : en proposer une courte en français pour chaque ligne (à partir du titre de PR / des commits), modifiable.

Après chaque modification, réafficher le tableau mis à jour avec le total par jour vs objectif. Signaler :
- les lignes encore incomplètes (ticket ou durée manquants) ;
- les dépassements d'objectif journalier ;
- les doublons possibles avec des worklogs Tempo existants (même ticket, même jour).

**⏸ Point d'arrêt** : passer à l'étape 3 uniquement quand toutes les lignes sont complètes et que l'utilisateur confirme.

### Étape 3/3 — Validation et saisie

1. **Récapitulatif final** des worklogs qui vont être créés :

   | Date | Ticket | Durée | Début | Description |
   |---|---|---|---|---|

   avec le total par jour (existant + nouveau) vs objectif. Calculer les `startTime` en enchaînant les entrées dans la journée (à partir de `09:00:00` ou après le dernier worklog existant) pour éviter les chevauchements, sauf heure imposée par l'utilisateur.
2. **⏸ Validation explicite** : demander « Valider la saisie de ces N worklogs dans Tempo ? (OUI/NON) ». Toute autre réponse qu'un accord clair → retour à l'étape 2.
3. **Création** : POST de chaque worklog (résoudre d'abord l'`issueId` numérique).
4. **Compte rendu** : worklogs créés (avec `tempoWorklogId`), échecs éventuels avec la cause, puis nouveau total par jour. En cas d'échec partiel, proposer de corriger les lignes en erreur (retour à l'étape 2 limité à ces lignes) sans recréer celles déjà saisies.

## Règles

- Durées : accepter `2h`, `1h30`, `45m`, `0.5j` (1 j = `TEMPO_DAILY_HOURS` heures), convertir en secondes.
- Description : courte, en français, issue de ce que dit l'utilisateur ; ne pas laisser vide (certaines configurations Tempo la rendent obligatoire).
- Ne jamais modifier ni supprimer un worklog existant sans demande explicite.
- Erreurs HTTP : afficher le message renvoyé par Tempo/Jira. Cas fréquents :
  - `401` → jeton invalide ou expiré ;
  - `400` mentionnant un attribut → interroger `/work-attributes` et demander la valeur à l'utilisateur ;
  - `403` / période verrouillée → la feuille de temps est déjà soumise ou approuvée, prévenir l'utilisateur.
