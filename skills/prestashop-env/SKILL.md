---
name: prestashop-env
description: Builds clean PrestaShop core shops from nothing, in Docker, at the commit of a pull request (its merge base or its head), a branch, a tag or a sha, several side by side, and tears them down. Every build starts from an empty database and an empty working tree, in a worktree the skill owns, so it never touches the developer's repository or their own shop. Use when the user says "spin up a shop for PR #123", "give me a clean 9.0.x", "build the environment for this pull request", "reset the test shop", or when another skill, such as the pull-request QA workflow, needs a shop at a given commit.
compatibility: Needs an agent with shell access, node, git and Docker with compose v2. Only for the PrestaShop core, or a fork of it, private ones included, at a commit that ships the core's docker-compose.yml. Modules, themes and libraries are not built by this skill.
---

# Build a PrestaShop shop at one commit

One command builds a shop at one commit and prints its URL. Each shop has its own directory, its own database and its own port, so several run side by side: a pull request's code next to the code it branched from, for a non-regression check by hand, or the two phases of a QA. They are **built one at a time** and then run together: an idle shop costs little memory, an install costs a lot. Rebuilding a shop tears it down first, database included. Nothing survives from one build to the next: no row a migration wrote, no compiled cache, no built asset. That is the whole point, and it is why a build takes five to fifteen minutes.

```
~/.ia/prestashop-env/                   $PS_ENV_HOME
└── PrestaShop/
    ├── PrestaShop.git                  a bare mirror, shared by every shop of the repository
    └── PrestaShop/
        ├── pr-43207/merge-base/        a git worktree of the mirror: the code the PR branched from
        ├── pr-43207/merge-base.state/  its compose file, its port, its default output
        ├── pr-43207/head/              the PR's code
        ├── branch/9.0.x/
        ├── tag/9.0.1/
        └── commit/58f1041a69a9/
```

Names are stable, never a sha: a shop rebuilt after a push to the pull request keeps its directory, its port and its URL, and the sha it was built at is in what it hands over.

## Rules that do not bend

1. **Only `scripts/env.js` writes, and only into its own workspace.** Never run `git checkout`, `git clean` or `docker compose down -v` yourself, in any directory: the developer's own shop and repository are one typo away. `env.js` refuses to touch any directory it did not create, and that refusal is never worked around by deleting the directory.
2. **The admin account is chosen before the build**, through the `PS_ENV_ADMIN_EMAIL` and `PS_ENV_ADMIN_PASSWORD` environment variables, never as command-line arguments: arguments end up in logs and shell histories.
3. **Say the duration before starting**, once: five to fifteen minutes per build, composer, the asset build and the installer included, and that a second build waits for the first. Two installs at once run two webpack builds, two composer installs and two installers, which exhausts the memory of an ordinary laptop. `env.js` enforces it with a lock; `--parallel` lifts it, and is only for a machine the user says has the memory. Then report the stages `env.js` prints as they come, and never claim the shop is ready before it prints its URL.
4. **Never tear down a shop nobody asked you to tear down.** Someone may still be looking at it.

## What to ask the user

- the repository, `PrestaShop/PrestaShop` unless they say otherwise
- what to build: a pull request with which side of it (**merge base**, the code the PR branched from, or **head**, the PR's code), or a branch, a tag or a sha
- for a pull request, its base branch if you cannot read it: `gh pr view [number] --repo [owner/repo] --json baseRefName`
- **the first time only**, whether they have a local clone of the repository, such as `~/IdeaProjects/PrestaShop`. The mirror borrows its objects instead of downloading them all, then cuts itself loose: their clone is read once and never written to. Without one, the mirror is a partial clone and downloads file contents as shops need them

Nothing else. The URL, the admin folder and the versions are measured, and the ports are free ones.

## Private repositories

A private fork of the core, such as `PrestaShop/security-vault`, builds exactly like the core: same `docker-compose.yml`, same commands. Two things differ.

**Access.** The mirror is cloned with the URL the developer already authenticates with: `--url` if given, else the remote of `--source` that points to the repository, else HTTPS. For a private repository, pass `--source` with their local clone, whose remote is usually SSH (`git@github.com:...`). Without it, HTTPS fails on a private repository. `env.js` never waits on a prompt, a password, a key passphrase or an editor's credential dialog: an authentication failure comes back as an error within seconds. The key then has to be loaded in an `ssh-agent`, and `git ls-remote [url]` has to work from a plain shell.

**Confidentiality.** A private repository holding unpublished security fixes is copied, mirror and worktrees, under `~/.ia/prestashop-env/`, readable by its owner only. Say so before the first build, and offer `down --purge` when the work is done. Each shop answers on `127.0.0.1` only, never on the network, which matters for a shop running a vulnerability nobody has patched yet. Whatever the caller writes with `--out`, logs and measurements included, is the caller's to keep private.

## Build

`SKILL_DIR` is the directory this file was read from.

```bash
export PS_ENV_ADMIN_EMAIL=demo@prestashop.com PS_ENV_ADMIN_PASSWORD='Pr3st4Sh0P'

# a side of a pull request; --source only matters the first time, when the mirror is created
node "$SKILL_DIR/scripts/env.js" up --repo=PrestaShop/PrestaShop --pr=[number] --base=[baseRefName] \
  --at=merge-base|head [--source=~/IdeaProjects/PrestaShop]

# a branch, a tag, or a commit sha
node "$SKILL_DIR/scripts/env.js" up --repo=PrestaShop/PrestaShop --ref=9.0.x
```

Run it in the background: it takes minutes and prints its stages on stderr. Its stdout is one line, the front-office URL. To get both sides of a pull request, run the two commands one after the other. Started together, the second prints `waiting for another build to finish` and starts its install when the first shop is ready, so the result is the same. Each gets its own port.

What happens, in order:

| Step | Why |
| --- | --- |
| create the bare mirror, once per repository, from `--source` with `--reference --dissociate`, or as a partial clone | the mirror belongs to the skill. Seeded from a local clone it downloads almost nothing, and once dissociated it never depends on that clone again |
| fetch `pull/[number]/head` and the base branch, or the branch, tag or commit | a fork's branch is reachable from the base repository, so no second remote |
| `docker compose down -v` on the previous shop in that directory | the database goes with its volume: the new shop installs on an empty one |
| `git worktree add` from the mirror, the first time | a few seconds and almost no disk. A worktree of the skill's mirror, never of the developer's clone, so it locks nothing there and never appears in their `git worktree list` |
| `git checkout --force --detach [sha]`, then `git clean -dffx` | `vendor/`, `node_modules/`, built assets and caches are all untracked, so all of them go |
| render the commit's own `docker-compose.yml`, rewriting ports, network and volume names | maintained branches hard-code `8001:80`, `3306:3306` and `prestashop-network`, which the developer's own shop publishes, and so would a second shop of this skill. The HTTP port is picked between 8100 and 8999, never one another shop of this skill holds, and kept per shop; the others are left to Docker; all bind to `127.0.0.1` only |
| `docker compose build`, then `up -d --force-recreate` | the image holds PHP and Apache, the code is mounted into it |
| wait for the installer, then for the front page to answer | `up -d` returns long before the shop exists |

`--no-cache` rebuilds the image without Docker's layer cache. It is rarely worth it: Docker keys its cache on content, so a commit that changes `.docker/` gets fresh layers anyway. Offer it only when a build fails on a stale upstream package.

## What a build hands over

`<out>/<label>.json`, where `--out` defaults to the shop's `.state/` directory and `--label` to `env`. Another skill passes both, so the measurements land in its own directory: the two sides of a pull request with the labels `before` and `after`, for instance, sit side by side.

| Field | What it is |
| --- | --- |
| `fo`, `bo`, `adminFolder`, `adminEmail` | where the shop answers, and the account that was created. The password is never written |
| `shop`, `sha`, `state` | the shop's directory, such as `pr-43207/head`, the commit built, and what it is in words: `merge base <sha>`, `PR head <sha>`, `branch 9.0.x <sha>` |
| `pr`, `base`, `at`, `head`, `mergeBase` | for a pull request only |
| `drift` | for a pull request only: non-empty when another label in the same `--out` was built against a different head or merge base, because someone pushed or rebased in between. Those two shops are not comparable |
| `versions` | PrestaShop, read from the code, and PHP, read in the container. Measured, never assumed from a branch name |
| `exec` | what to put in front of a command so it runs inside the shop, where PHP and the database are: `$EXEC php bin/console cache:clear` |
| `workspace`, `project`, `composeSha256` | where the worktree is, the compose project, and a hash of the rendered compose file |

Next to it, `<label>-build.log` and `<label>-container.log`, with the admin password redacted. `--out` is refused inside the worktree, because the worktree is served over HTTP.

## Tear down

```bash
node "$SKILL_DIR/scripts/env.js" list                                          # every shop, running or stopped, with its URL
node "$SKILL_DIR/scripts/env.js" down --repo=PrestaShop/PrestaShop --pr=[number] [--at=head]  # stop, delete the database
node "$SKILL_DIR/scripts/env.js" down --repo=PrestaShop/PrestaShop --ref=9.0.x --purge        # also the image and the worktree
node "$SKILL_DIR/scripts/env.js" down --repo=PrestaShop/PrestaShop --all --purge              # every shop, and the mirror
```

Without `--at`, `--pr` covers both sides of the pull request. A shop with its dependencies weighs two to three gigabytes, so mention `--purge` when the work is done, and let the user run it or ask for it.

## Troubleshooting

| What you see | Cause | What to do |
| --- | --- | --- |
| `refusing: ... is not a worktree of ...` | a directory already sits where the shop goes, and git says it is not the skill's | never delete it: it may be someone's clone. Set `PS_ENV_HOME` to another directory |
| `waiting for another build to release the mirror` | another build is fetching or picking its port | nothing: that lock is held for seconds |
| `waiting for another build to finish` | another shop is installing | nothing: this one starts when it is ready. A lock left by a process that died is taken over on its own |
| `no usable docker-compose.yml` | not the core, or a commit older than its Docker setup | say so: this skill cannot build it |
| `the installer failed`, or `not ready after N minutes` | composer, the asset build or the installer stopped | read the container log it names. A network failure is worth one retry. Otherwise report it: the commit itself may be what breaks the install, which is worth knowing |
| `the image did not build` | the Dockerfile failed, often on a package download | read the build log; retry with `--no-cache` if a package is stale |
| `warning: the PR head moved` or `the merge base moved` | a push or a rebase between two builds of the same pull request | rebuild the other side too, so both sides are measured against the same pair of commits |
| a tool in the shop complains that it is `not a git repository` | the worktree's `.git` is a file pointing to the mirror, which is not mounted in the container | harmless for the shop itself; a command that needs git history has to run on the host, in the worktree |
| `no free port between 8100 and 8999` | every port in the range is taken | tear down shops listed by `env.js list` that are no longer needed, with the user's consent |
| `Authentication failed`, `Repository not found` or `Permission denied (publickey)` | the repository is private and the URL or the key does not reach it | pass `--source` with a clone whose remote works, or `--url` with an SSH URL, and check the key is in `ssh-agent`. An existing mirror keeps its URL: `down --all --purge` to recreate it |
| `gave no answer in 20 minutes` | the network or GitHub stopped answering | retry once; say so if it happens again |
| `node is not on PATH` | node is installed through nvm or asdf, which a non-interactive shell does not load | ask the user to run from a shell where `node -v` works |

## Bundled files

| File | What is in it |
| --- | --- |
| `scripts/env.js` | builds, lists and tears down the shops. No dependency beyond node, git and Docker. Executed, never edited for a build |
