---
name: prestashop-pr-qa-auto
description: QAs a PrestaShop core pull request from its number alone. Builds two fresh shops, one on the code before the PR and one on the PR's code, one after the other, measures each, and hands over the same report and verdict as the pull-request QA. Use when the user says "QA PrestaShop/PrestaShop#123 from scratch", "QA this core PR, build the environment yourself", "full QA of this PR", or gives a core pull request without an environment to test it on.
compatibility: Needs the prestashop-env and prestashop-pr-qa skills installed alongside this one, plus everything they need: shell access, node, git, Docker with compose v2, and a GitHub token in `~/.ia/.env` (`GITHUB_TOKEN`, plus `JIRA_EMAIL` and `JIRA_TOKEN` to read a linked Jira ticket). Core pull requests only; anything else goes to prestashop-pr-qa with an existing environment.
---

# QA a core pull request, environment included

This skill does no measuring and no building of its own. It runs two other skills in the right order, and answers on the developer's behalf the one question the QA cannot answer alone: "put the environment on this code".

| Skill | What it does here |
| --- | --- |
| `prestashop-pr-qa` | everything about the QA: the scenario, the two measurements, the verdict, the report. Its rules all apply unchanged |
| `prestashop-env` | builds shops from nothing at one commit each, database included, side by side, in worktrees of its own |

**Read both `SKILL.md` before starting**, and follow them. `QA_DIR` and `ENV_DIR` below are the directories they were read from. Where this file and theirs seem to disagree, theirs win, except on the one point this file exists for: the code is switched by `prestashop-env`, not by the developer.

The QA measures two states of the code, so there are two shops, one per state. They are built one after the other, because two installs at once exhaust the memory of an ordinary laptop, then they run side by side:

```
read the PR → scenario → GATE → build merge base → build PR head → measure before on the first → measure after on the second → verdict
```

Each shop has its own database, so neither build can leak a migration into the other, and the `before` measurement still comes first, as `prestashop-pr-qa` requires.

All of it in one conversation: the scenario the developer approved is the one measured twice, and that is only guaranteed when the same agent holds it from start to end.

## Workflow

Copy this checklist into your reply and tick items off as you go:

```
QA progress:
- [ ] 1. Check the PR is a core PR
- [ ] 2. QA steps 1 to 3: read the PR, set up the run directory, write the scenario
- [ ] 3. GATE: the scenario, the surfaces, the fixtures, and the time it will take
- [ ] 4. Build both shops, one after the other
- [ ] 5. QA step 5: measure the before phase, on the merge-base shop
- [ ] 6. Check the two shops are on the same pair of commits
- [ ] 7. QA step 7: measure the after phase, on the PR-head shop
- [ ] 8. QA step 8: verdict and reports, then say what is still running
```

### 1. Check the PR is a core PR

`prestashop-env` only builds the core, or a fork of it. For a module, a theme or a library, say so in one sentence and continue with `prestashop-pr-qa` alone, on the developer's environment.

### 2. QA steps 1 to 3

As `prestashop-pr-qa` describes them, with three differences:

- **Ask nothing about the environment.** No URL, no admin folder, no versions: they do not exist yet, and `prestashop-env` will measure them.
- **The run directory takes `-` as its URL**, since there is no shop yet: `RUN=$(sh "$QA_DIR/scripts/pick-run-dir.sh" - "$HOME/prestashop-pr-qa/[owner]/[repo]/pr-[number]")`. `prestashop-env` refuses on its own to write inside its workspace.
- **Each phase starts on a fresh install with the demo catalogue**, the same in both. Whatever the ticket needs beyond it, a configuration value, a product in a given state, a customer with an order, the scenario creates itself, in a step of its own, in both phases. Name it out loud, as for any fixture.

### 3. GATE: the scenario, and the time it will take

Show the scenario, the surfaces and the fixtures, as `prestashop-pr-qa` step 4 asks. Add how long the run will take: two builds of five to fifteen minutes each, one after the other, then the two measurements. Ask, the first time only, whether they have a local clone of the repository to seed the mirror from, as `prestashop-env` describes. Wait for a yes. **This is the only gate of the run**: after it, nothing waits for the developer.

### 4. Build both shops, one after the other

For a new feature, which has nothing to reproduce, build only the `head` shop.

```bash
export PS_ENV_ADMIN_EMAIL=demo@prestashop.com PS_ENV_ADMIN_PASSWORD='Pr3st4Sh0P'
export QA_BO_EMAIL="$PS_ENV_ADMIN_EMAIL" QA_BO_PASSWORD="$PS_ENV_ADMIN_PASSWORD"   # the same account, for the QA runner

# the merge base first, then the head
node "$ENV_DIR/scripts/env.js" up --repo=[owner/repo] --pr=[number] --base=[baseRefName] \
  --at=merge-base --out="$RUN/env" --label=before [--source=<local clone>]
node "$ENV_DIR/scripts/env.js" up --repo=[owner/repo] --pr=[number] --base=[baseRefName] \
  --at=head --out="$RUN/env" --label=after [--source=<local clone>]
```

Run each in the background and start the second when the first has printed its URL; `env.js` would make it wait anyway. Report the stages as they come. The two shops answer on two different ports. Pass `--parallel` to both only when the user says the machine has the memory for two installs at once. A non-zero exit is a harness error: say what it printed, and stop there, or retry once on a network failure. Never measure a half-built shop.

From here on, `prestashop-pr-qa` takes the environment of each phase from `$RUN/env/before.json` and `$RUN/env/after.json`, as its section "When another skill provides the environment" describes. For a command-line run, the `exec` field differs between the two shops, so export `PSQA_EXEC` from the file of the phase about to be measured: `export PSQA_EXEC="$(node -p 'require(process.argv[1]).exec' "$RUN/env/[phase].json")"`. The scenario only ever names `$PSQA_EXEC`, so it stays identical.

### 5. Measure the before phase

`prestashop-pr-qa` step 5, with `--url` and `--bo-url` set to `fo` and `bo` from `before.json`. The canary reading is taken on that shop.

### 6. Check the two shops are on the same pair of commits

Both files carry `head` and `mergeBase`. They must be identical in the two, and `drift` must be empty in both. Otherwise someone pushed or rebased while the shops were building: they measure different pull requests, so rebuild the side that is behind, with the same command, before going on.

### 7. Measure the after phase

`prestashop-pr-qa` step 7, against `after.json`, with the second canary reading taken on that shop. Two shops built from nothing cannot serve a stale cache, but the canary is still what proves each serves its own code: identical readings mean the two shops were built at the same commit, which is a harness error.

### 8. Verdict, reports, and what is left running

`prestashop-pr-qa` step 8. In `verdict.json`, add to `environment` that the shop was built from nothing in each phase by `prestashop-env`, so a reader knows no cache or migration could carry over.

Both shops are left running, so the developer can compare them by hand. Give the two URLs, and the commands that end them, without running any:

```bash
node "$ENV_DIR/scripts/env.js" down --repo=[owner/repo] --pr=[number]          # stop both, delete their databases
node "$ENV_DIR/scripts/env.js" down --repo=[owner/repo] --pr=[number] --purge  # also the worktrees and the images, a few gigabytes each
```

## Troubleshooting

| What you see | Cause | What to do |
| --- | --- | --- |
| `prestashop-env` or `prestashop-pr-qa` cannot be found | one of the two skills is not installed | ask the user to install it: `npx skills install PrestaShop/skills/core/dev` or `PrestaShop/skills/qa/dev` |
| the build of the PR head fails while the merge base built | the pull request breaks the install, the composer dependencies or the asset build | that is a finding, not a harness error: report it as 🔴 not approved, with the container log as evidence |
| the build of the merge base fails | the base branch itself does not build here, or the network failed | harness error, no verdict. Say which, with the log |

Everything else is in the troubleshooting tables of the two skills.

## Private repositories

A pull request on a private fork of the core, such as `PrestaShop/security-vault`, runs the same way; `prestashop-env` explains how to reach it. When the repository holds unpublished security fixes, the run directory, the recording, the report and the comment describe a vulnerability that is not public yet. Say so when handing them over: the comment goes on that private pull request and nowhere else, and the evidence stays on this machine.
