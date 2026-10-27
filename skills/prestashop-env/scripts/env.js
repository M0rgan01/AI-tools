// env.js: builds PrestaShop core shops from nothing, one per commit, in Docker, side by side.
//
//   node env.js up   --repo=owner/repo (--pr=N --base=<branch> --at=merge-base|head | --ref=<branch|tag|sha>)
//                    [--source=<local clone>] [--url=<clone url>] [--name=<shop name>] [--out=<dir>] [--label=<name>]
//                    [--timeout=<minutes>] [--no-cache] [--parallel]
//   node env.js down --repo=owner/repo (--pr=N [--at=merge-base|head] | --ref=<branch|tag|sha> | --name=<shop> | --all) [--purge]
//   node env.js list [--repo=owner/repo]
//
// Layout, under $PS_ENV_HOME (default ~/.ia/prestashop-env):
//   <owner>/<repo>.git                     a bare mirror, shared by every shop of that repository
//   <owner>/<repo>/pr-<N>/head             one git worktree of the mirror per shop
//   <owner>/<repo>/pr-<N>/head.state/      its rendered compose file, its port, its default output
//   <owner>/<repo>/branch/<name>, tag/<name>, commit/<sha12>, custom/<name>
//
// The mirror is seeded from the developer's own clone when one is given, so nothing large is
// downloaded, then cut loose from it: it never writes to that clone and survives its `git gc`.
// Each shop is a worktree of the mirror, not of the developer's clone, so none of them locks a
// branch there or shows up in their `git worktree list`.
//
// A directory is this skill's to clean, reset or delete only when git itself says it is a worktree
// of the skill's mirror. That check is what makes every destructive command below safe to run
// without asking. Anything else at that path belongs to somebody, and is never touched.
//
// Prints the front-office URL on stdout, nothing else. Progress goes to stderr. What was built and
// measured goes to <out>/<label>.json, next to <label>-build.log and <label>-container.log.
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const USAGE = [
  'usage: env.js up   --repo=owner/repo (--pr=N --base=<branch> --at=merge-base|head | --ref=<branch|tag|sha>)',
  '                   [--source=<local clone>] [--url=<clone url>] [--name=<shop name>] [--out=<dir>] [--label=<name>] [--timeout=<minutes>] [--no-cache] [--parallel]',
  '       env.js down --repo=owner/repo (--pr=N [--at=merge-base|head] | --ref=<branch|tag|sha> | --name=<shop> | --all) [--purge]',
  '       env.js list [--repo=owner/repo]',
].join('\n');
const [CMD, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const opt = (k) => (typeof args[k] === 'string' && args[k] !== '' ? args[k] : null);
const say = (s) => process.stderr.write(`${s}\n`);
const die = (s, code = 2) => { say(`refusing: ${s}`); process.exit(code); };
const usage = (s) => { say(`${s}\n${USAGE}`); process.exit(64); };
if (!['up', 'down', 'list'].includes(CMD)) usage(`unknown command "${CMD || ''}"`);

const HOME = path.resolve(process.env.PS_ENV_HOME || path.join(os.homedir(), '.ia', 'prestashop-env'));
// Nothing here may ever wait on a prompt: a password, a passphrase or an unknown host key would hang
// a background build forever. A failed authentication has to come back as an error instead.
// GIT_ASKPASS too: an editor's terminal sets its own, VS Code's for one, and git then waits on a
// dialog in that editor instead of failing. A credential helper still answers, since it runs first.
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_ASKPASS = 'true';
if (!process.env.GIT_SSH_COMMAND) process.env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
const run = (cmd, argv, o = {}) => spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...o });
const must = (cmd, argv, o = {}) => {
  const r = run(cmd, argv, o);
  if (r.error && r.error.code === 'ETIMEDOUT') die(`${cmd} ${argv.join(' ')} gave no answer in ${Math.round(o.timeout / 60000)} minutes`);
  if (r.status !== 0) die(`${cmd} ${argv.join(' ')} failed (exit ${r.status}):\n${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout || '').trim();
};
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, o) => fs.writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`);
const inside = (a, b) => `${path.resolve(a)}/`.startsWith(`${path.resolve(b)}/`);
const slug = (s) => s.replace(/[^\w.-]+/g, '-');

for (const bin of ['git', 'docker']) {
  if (run(bin, ['--version']).status !== 0) die(`${bin} is not on PATH`);
}
if (run('docker', ['compose', 'version']).status !== 0) die('docker compose (v2) is not available');

const REPO = opt('repo');
if (REPO && !/^[\w.-]+\/[\w.-]+$/.test(REPO)) usage('--repo must be owner/repo');
if (!REPO && CMD !== 'list') usage('--repo must be owner/repo');
const [OWNER, REPO_NAME] = REPO ? REPO.split('/') : [];
const MIRROR = REPO ? path.join(HOME, OWNER, `${REPO_NAME}.git`) : null;
const SHOPS = REPO ? path.join(HOME, OWNER, REPO_NAME) : null;
const mgit = (...argv) => must('git', ['--git-dir', MIRROR, ...argv]);
// Anything that talks to the remote gets a deadline: a hung connection must not hang a build.
const NET = { timeout: 20 * 60000 };
const mgitNet = (...argv) => must('git', ['--git-dir', MIRROR, ...argv], NET);

// Two locks, both files under the home directory holding the pid of their owner, so a lock left by
// a process that died is recognised as such and taken over rather than waited on forever.
//   mirror: the mirror and the port range, held for the few seconds they are touched
//   build:  the image build and the install, held for minutes. Two installs side by side run two
//           webpack builds, two composer installs and two installers at once, which exhausts the
//           memory of an ordinary laptop. A second `up` waits its turn instead, unless --parallel.
const held = new Set();
async function locked(name, waitMsg, maxWaitMs, fn) {
  const LOCK = path.join(HOME, `.${name}.lock`);
  // The home holds copies of every repository built here, private ones included: readable by its
  // owner only.
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); held.add(LOCK); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0;
      try { pid = Number(fs.readFileSync(LOCK, 'utf8')); } catch (_) { continue; }
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (err) { alive = err.code === 'EPERM'; }
      if (!pid || !alive) { try { fs.unlinkSync(LOCK); } catch (_) { /* someone else took it over */ } continue; }
      if (i === 0) say(`${waitMsg} (process ${pid})`);
      if (Date.now() - t0 > maxWaitMs) die(`${LOCK} has been held by process ${pid} for ${Math.round(maxWaitMs / 60000)} minutes`);
      await sleep(2000);
    }
  }
  try { return await fn(); } finally { try { fs.unlinkSync(LOCK); } catch (_) { /* gone */ } held.delete(LOCK); }
}
// die() exits from inside a lock, which skips `finally`: release what is held on the way out instead.
process.on('exit', () => { for (const l of held) try { fs.unlinkSync(l); } catch (_) { /* already gone */ } });
// A signal skips the exit handlers unless it is turned into an exit. A lock left anyway, by a
// SIGKILL say, names a dead pid and is taken over by the next run.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130));

// The one proof of ownership: git says this directory is a worktree of the skill's mirror.
function isOurs(ws) {
  if (!fs.existsSync(ws)) return false;
  const r = run('git', ['-C', ws, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.status === 0 && path.resolve(r.stdout.trim()) === path.resolve(MIRROR);
}

// Every shop this skill holds for a repository, found from the state directories it wrote.
function shops(repoDir) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name.endsWith('.state') && fs.existsSync(path.join(p, 'shop.json'))) {
        try { out.push({ ...readJson(path.join(p, 'shop.json')), ws: p.slice(0, -'.state'.length), state: p }); } catch (_) { /* half-written */ }
      } else walk(p, depth + 1);
    }
  };
  walk(repoDir, 0);
  return out;
}

const projectOf = (rel) => `psenv-${OWNER}-${REPO_NAME}-${rel}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

const isFree = (port) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false));
  s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
});

// The HTTP port is the one port chosen by hand: the installer writes the shop's domain into the
// database, so it has to be known before the shop exists. Every other port is left to Docker. It is
// kept per shop, so a shop rebuilt at another commit answers on the same URL, and a port another
// shop of this skill holds is never handed out, even while that shop is stopped.
async function pickHttpPort(preferred, self) {
  const taken = new Set();
  for (const d of fs.existsSync(HOME) ? fs.readdirSync(HOME) : []) {
    const od = path.join(HOME, d);
    if (d.startsWith('.') || !fs.statSync(od).isDirectory()) continue;
    for (const r of fs.readdirSync(od).filter((x) => !x.endsWith('.git'))) {
      for (const s of shops(path.join(HOME, d, r))) if (s.ws !== self && s.httpPort) taken.add(s.httpPort);
    }
  }
  if (preferred && !taken.has(preferred) && await isFree(preferred)) return preferred;
  for (let p = 8100; p < 9000; p++) if (!taken.has(p) && await isFree(p)) return p;
  die('no free port between 8100 and 8999 for the shop');
}

// The mirror: created once per repository, fetched before every build. With --source, the objects
// come from the developer's clone through --reference, then --dissociate copies the ones needed, so
// the mirror never depends on that clone afterwards. Without it, a partial clone: commits and trees
// now, file contents when a worktree checks them out.
//
// The URL is the one the developer already authenticates with: --url, else the remote of --source
// that points to this repository, else HTTPS. A private repository is typically reached over SSH,
// and an HTTPS URL there would fail, or worse, wait for a password nobody is there to type.
function ensureMirror() {
  if (fs.existsSync(MIRROR)) return;
  const source = opt('source') || process.env.PS_ENV_SOURCE;
  const src = source ? path.resolve(source.replace(/^~(?=\/|$)/, os.homedir())) : null;
  if (src && run('git', ['-C', src, 'rev-parse', '--git-dir']).status !== 0) die(`--source ${src} is not a git repository`);
  const sameRepo = (u) => new RegExp(`[:/]${REPO.replace(/[.]/g, '\\.')}(\\.git)?/?$`, 'i').test(u);
  const fromSource = src && (run('git', ['-C', src, 'remote', '-v']).stdout || '').split('\n')
    .map((l) => l.split(/\s+/)[1]).find((u) => u && sameRepo(u));
  const url = opt('url') || fromSource || `https://github.com/${REPO}.git`;
  fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
  if (src) {
    say(`creating the mirror of ${REPO} from ${url}, with the objects of ${src}, then cutting it loose`);
    must('git', ['clone', '--bare', '--reference', src, '--dissociate', url, MIRROR], NET);
  } else {
    say(`creating the mirror of ${REPO}, without file contents until a shop checks them out`);
    must('git', ['clone', '--bare', '--filter=blob:none', url, MIRROR], NET);
  }
}

// Which commit to build, and the shop it goes into. Names are stable, not shas, so a shop rebuilt
// after a push to the pull request keeps its directory, its port and its URL.
function resolveTarget() {
  const PR = opt('pr');
  const REF = opt('ref');
  if (PR) {
    if (!/^\d+$/.test(PR)) usage('--pr must be a pull request number');
    const BASE = opt('base');
    const AT = opt('at');
    if (!BASE) usage('--base must name the base branch, as gh pr view reports it in baseRefName');
    if (!['merge-base', 'head'].includes(AT)) usage('--at must be merge-base or head');
    say(`fetching PR #${PR} and ${BASE}`);
    // A fork's branch is reachable from the base repository as pull/N/head, so no second remote.
    mgitNet('fetch', '--force', '--quiet', url(), `+refs/pull/${PR}/head:refs/pull/${PR}/head`, `+refs/heads/${BASE}:refs/heads/${BASE}`);
    const head = mgit('rev-parse', `refs/pull/${PR}/head`);
    const mergeBase = mgit('merge-base', `refs/pull/${PR}/head`, `refs/heads/${BASE}`);
    const sha = AT === 'head' ? head : mergeBase;
    return { rel: `pr-${PR}/${AT}`, sha, state: `${AT === 'head' ? 'PR head' : 'merge base'} ${sha}`, pr: Number(PR), base: BASE, at: AT, head, mergeBase };
  }
  if (!REF) usage('give --pr with --base and --at, or --ref');
  if (REF.startsWith('-')) usage('--ref cannot start with a dash');
  say(`fetching ${REF}`);
  const remote = must('git', ['--git-dir', MIRROR, 'ls-remote', url(), `refs/heads/${REF}`, `refs/tags/${REF}`], NET);
  if (remote.includes(`refs/heads/${REF}`)) {
    mgitNet('fetch', '--force', '--quiet', url(), `+refs/heads/${REF}:refs/heads/${REF}`);
    const sha = mgit('rev-parse', `refs/heads/${REF}`);
    return { rel: `branch/${slug(REF)}`, sha, state: `branch ${REF} ${sha}`, ref: REF };
  }
  if (remote.includes(`refs/tags/${REF}`)) {
    mgitNet('fetch', '--force', '--quiet', url(), `+refs/tags/${REF}:refs/tags/${REF}`);
    const sha = mgit('rev-parse', `refs/tags/${REF}^{commit}`);
    return { rel: `tag/${slug(REF)}`, sha, state: `tag ${REF} ${sha}`, ref: REF };
  }
  if (!/^[0-9a-f]{7,40}$/.test(REF)) die(`${REF} is neither a branch, a tag nor a commit sha of ${REPO}`);
  // GitHub only serves a bare commit by its full sha; a short one has to be in the mirror already.
  if (REF.length === 40) run('git', ['--git-dir', MIRROR, 'fetch', '--quiet', url(), REF], NET);
  const r = run('git', ['--git-dir', MIRROR, 'rev-parse', '--verify', '--quiet', `${REF}^{commit}`]);
  if (r.status !== 0) die(`commit ${REF} is not in ${REPO}. Give its full 40-character sha`);
  const sha = r.stdout.trim();
  return { rel: `commit/${sha.slice(0, 12)}`, sha, state: `commit ${sha}`, ref: REF };
}
// Fetches go to the URL the mirror was created with, so a private repository stays on SSH.
const url = () => mgit('remote', 'get-url', 'origin');

// Files the container wrote as root survive `git clean` and `rm -rf`. Handing them back to the
// developer's user through a throwaway container is the one fix that needs no sudo.
function reclaim(ws) {
  const uid = process.getuid ? process.getuid() : 1000;
  const gid = process.getgid ? process.getgid() : 1000;
  say(`handing files written by the container back to ${uid}:${gid}`);
  must('docker', ['run', '--rm', '-v', `${ws}:/w`, 'busybox', 'chown', '-R', `${uid}:${gid}`, '/w']);
}

function composeDown(shop, extra = []) {
  const file = path.join(shop.state, 'compose.json');
  // Without a rendered file, compose still finds the project by its labels.
  const argv = fs.existsSync(file)
    ? ['compose', '-p', shop.project, '-f', file, 'down', '-v', '--remove-orphans', ...extra]
    : ['compose', '-p', shop.project, 'down', '-v', '--remove-orphans', ...extra];
  const r = run('docker', argv, { cwd: fs.existsSync(shop.ws) ? shop.ws : os.tmpdir() });
  if (r.status !== 0) say(`note: docker compose down said: ${(r.stderr || '').trim()}`);
}

// The core's docker-compose.yml is used as the checked-out commit has it, so a PR that changes it is
// built with its change. Only what would collide with another shop on this machine is rewritten:
// maintained branches hard-code 8001:80, 3306:3306 and a network named prestashop-network, which is
// exactly what the developer's own environment publishes, and what a second shop of this skill would.
function render(shop, httpPort, creds) {
  const raw = run('docker', ['compose', '-p', shop.project, '-f', 'docker-compose.yml', 'config', '--format', 'json'], {
    cwd: shop.ws,
    env: { ...process.env, PS_DOMAIN: `localhost:${httpPort}`, HTTP_HOST_PORT: String(httpPort) },
  });
  if (raw.status !== 0) die(`this commit has no usable docker-compose.yml, so it is not a PrestaShop core checkout:\n${raw.stderr.trim()}`);
  const cfg = JSON.parse(raw.stdout);
  const services = cfg.services || {};
  const web = Object.keys(services).find((k) => (services[k].ports || []).some((p) => Number(p.target) === 80));
  if (!web) die('no service in docker-compose.yml publishes port 80, so there is no shop to open');

  for (const [key, svc] of Object.entries(services)) {
    delete svc.container_name;
    svc.labels = { ...(svc.labels || {}), 'prestashop-env.workspace': shop.ws };
    svc.ports = (svc.ports || []).map((p) => {
      const out = { ...p, host_ip: '127.0.0.1' };   // never on the LAN: a throwaway shop with a known password
      if (key === web && Number(p.target) === 80) out.published = String(httpPort);
      else delete out.published;                    // Docker picks a free one
      return out;
    });
  }
  const w = services[web];
  w.environment = {
    ...(w.environment || {}),
    PS_DOMAIN: `localhost:${httpPort}`,
    ADMIN_MAIL: creds.email,
    ADMIN_PASSWD: creds.password,
  };
  // The container writes into the bind-mounted checkout as this user, so `git clean` can remove
  // what it wrote. Only where the Dockerfile takes the argument.
  if (w.build && w.build.args) {
    if ('USER_ID' in w.build.args && process.getuid) w.build.args.USER_ID = String(process.getuid());
    if ('GROUP_ID' in w.build.args && process.getgid) w.build.args.GROUP_ID = String(process.getgid());
  }
  for (const kind of ['networks', 'volumes']) {
    for (const [key, def] of Object.entries(cfg[kind] || {})) {
      if (def && def.external) die(`docker-compose.yml declares the ${kind.slice(0, -1)} "${key}" as external, which another shop may be using`);
      cfg[kind][key] = { ...(def || {}), name: `${shop.project}_${key}` };
    }
  }
  cfg.name = shop.project;
  const text = `${JSON.stringify(cfg, null, 2)}\n`;
  fs.writeFileSync(path.join(shop.state, 'compose.json'), text, { mode: 0o600 });
  return { web, adminFolder: w.environment.PS_FOLDER_ADMIN || 'admin-dev', composeSha256: sha256(text) };
}

const get = (u) => new Promise((resolve) => {
  const req = http.get(u, { timeout: 15000 }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve(0));
});

// `up -d` returns long before the shop exists: composer, the asset build and the installer all run
// at container start. The shop is ready when the entrypoint hands over to the web server and the
// front page answers. Anything else within the timeout is a failed build, reported as such.
async function waitReady(compose, cwd, web, fo, timeoutMs, logFile) {
  const STAGES = [
    [/Running composer/, 'composer install'],
    [/Build assets/, 'building the assets'],
    [/Installing PrestaShop/, 'installing PrestaShop'],
    [/Starting web server now/, 'starting the web server'],
  ];
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const logs = run('docker', compose('logs', '--no-color', web), { cwd }).stdout || '';
    fs.writeFileSync(logFile, logs);
    for (const [re, label] of STAGES) {
      if (!seen.has(label) && re.test(logs)) { seen.add(label); say(`  ${Math.round((Date.now() - t0) / 1000)}s: ${label}`); }
    }
    if (/PrestaShop installation failed|Composer installation failed/.test(logs)) die(`the installer failed, see ${logFile}`);
    const ps = run('docker', compose('ps', '--all', '--format', '{{.Service}} {{.State}}'), { cwd }).stdout || '';
    const state = (ps.split('\n').find((l) => l.startsWith(`${web} `)) || '').split(' ')[1];
    if (state && state !== 'running') die(`the ${web} container is ${state}, see ${logFile}`);
    if (seen.has('starting the web server')) {
      const status = await get(fo);
      if (status && status < 400) return Math.round((Date.now() - t0) / 1000);
    }
    await sleep(10000);
  }
  die(`the shop was not ready after ${Math.round(timeoutMs / 60000)} minutes, see ${logFile}`);
}

function versions(ws, compose, web) {
  const out = {};
  for (const f of ['src/Core/Version.php', 'app/AppKernel.php']) {
    const p = path.join(ws, f);
    const m = fs.existsSync(p) && fs.readFileSync(p, 'utf8').match(/VERSION\s*=\s*'([^']+)'/);
    if (m) { out.prestashop = m[1]; break; }
  }
  const php = run('docker', compose('exec', '-T', web, 'php', '-r', 'echo PHP_VERSION;'), { cwd: ws });
  if (php.status === 0) out.php = php.stdout.trim();
  return out;
}

async function up() {
  const LABEL = opt('label') || 'env';
  if (!/^[\w.-]+$/.test(LABEL)) usage('--label is letters, digits, dots and dashes');
  const timeoutMs = Number(opt('timeout') || 45) * 60000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) usage('--timeout must be a positive number of minutes');
  if (opt('name') && !/^[\w.-]+$/.test(opt('name'))) usage('--name is letters, digits, dots and dashes');
  const creds = { email: process.env.PS_ENV_ADMIN_EMAIL, password: process.env.PS_ENV_ADMIN_PASSWORD };
  if (!creds.email || !creds.password) die('export PS_ENV_ADMIN_EMAIL and PS_ENV_ADMIN_PASSWORD first: they become the admin account of the shop');

  // Everything that touches the mirror or the port range happens under the lock, then the lock is
  // released: the build itself, the long part, runs alongside any other shop's.
  const prep = await locked('mirror', 'waiting for another build to release the mirror', 10 * 60000, async () => {
    ensureMirror();
    const target = resolveTarget();
    const rel = opt('name') ? `custom/${opt('name')}` : target.rel;
    const ws = path.join(SHOPS, rel);
    const shop = { ws, state: `${ws}.state`, project: projectOf(rel) };
    const OUT = path.resolve(opt('out') || shop.state);
    // The worktree is served over HTTP. Logs and measurements written inside it would be too.
    if (inside(OUT, ws)) die(`--out ${OUT} is inside the shop's worktree ${ws}, which the shop serves`);

    if (fs.existsSync(ws) && !isOurs(ws)) die(`${ws} exists and is not a worktree of ${MIRROR}. Move it away or set PS_ENV_HOME`);
    fs.mkdirSync(shop.state, { recursive: true, mode: 0o700 });
    const meta = fs.existsSync(path.join(shop.state, 'shop.json')) ? readJson(path.join(shop.state, 'shop.json')) : {};

    say(`tearing down the previous shop in ${rel}, database included`);
    composeDown({ ...shop });
    if (!fs.existsSync(ws)) {
      say(`adding the worktree ${ws}`);
      fs.mkdirSync(path.dirname(ws), { recursive: true });
      mgit('worktree', 'prune');
      mgit('worktree', 'add', '--force', '--detach', '--no-checkout', ws, target.sha);
    }
    const httpPort = await pickHttpPort(meta.httpPort, ws);
    writeJson(path.join(shop.state, 'shop.json'), { createdBy: 'prestashop-env', repo: REPO, rel, project: shop.project, httpPort, sha: target.sha, label: target.state });
    return { target, rel, shop, OUT, httpPort };
  });
  const { target, rel, shop, OUT, httpPort } = prep;
  fs.mkdirSync(OUT, { recursive: true });

  // Two shops of the same pull request are only comparable when they agree on the pair of commits.
  // A push moves the head, a rebase moves the merge base: either way the other one measured another PR.
  const drift = [];
  if (target.pr) {
    for (const f of fs.readdirSync(OUT).filter((x) => x.endsWith('.json') && x !== `${LABEL}.json`)) {
      let o; try { o = readJson(path.join(OUT, f)); } catch (e) { continue; }
      if (o.createdBy !== 'prestashop-env' || o.pr !== target.pr) continue;
      if (o.head !== target.head) drift.push(`the PR head moved from ${o.head} to ${target.head} since "${o.label}" was built`);
      if (o.mergeBase !== target.mergeBase) drift.push(`the merge base moved from ${o.mergeBase} to ${target.mergeBase} since "${o.label}" was built`);
    }
    for (const d of drift) say(`warning: ${d}`);
  }

  const ws = shop.ws;
  const git = (...argv) => must('git', ['-C', ws, ...argv]);
  say(`checking out ${target.state} in ${rel} and removing every untracked file`);
  git('checkout', '--quiet', '--force', '--detach', target.sha);
  if (run('git', ['-C', ws, 'clean', '-dffxq']).status !== 0) { reclaim(ws); git('clean', '-dffxq'); }

  const { web, adminFolder, composeSha256 } = render(shop, httpPort, creds);
  const COMPOSE = path.join(shop.state, 'compose.json');
  const compose = (...argv) => ['compose', '-p', shop.project, '-f', COMPOSE, ...argv];
  const FO = `http://localhost:${httpPort}`;
  const BO = `${FO}/${adminFolder}`;

  const buildLog = path.join(OUT, `${LABEL}-build.log`);
  const containerLog = path.join(OUT, `${LABEL}-container.log`);
  const readyIn = args.parallel
    ? await buildAndStart()
    : await locked('build', 'waiting for another build to finish: one install at a time, unless --parallel', 3 * timeoutMs, buildAndStart);

  async function buildAndStart() {
    // The image holds PHP and Apache only, the code is bind-mounted, and Docker's layer cache is keyed
    // on content: a commit that changes .docker/ gets fresh layers either way. --no-cache only guards
    // against a stale upstream package, at the price of a much longer build.
    say(`building the image${args['no-cache'] ? ' without the layer cache' : ''}, log in ${buildLog}`);
    const fd = fs.openSync(buildLog, 'w');
    const b = run('docker', compose('build', ...(args['no-cache'] ? ['--no-cache'] : [])), { cwd: ws, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    if (b.status !== 0) die(`the image did not build, see ${buildLog}`);

    say(`starting ${shop.project} on ${FO}: composer, assets and the installer run now, which takes a while`);
    must('docker', compose('up', '-d', '--force-recreate', '--remove-orphans'), { cwd: ws });
    return waitReady(compose, ws, web, FO, timeoutMs, containerLog);
  }
  // The log prints the admin password in its banner. It is a throwaway password, but a log is the
  // kind of file that gets attached to an issue, so it never carries one.
  fs.writeFileSync(containerLog, fs.readFileSync(containerLog, 'utf8').split(creds.password).join('[redacted]'));

  const measured = {
    createdBy: 'prestashop-env', label: LABEL, repo: REPO, shop: rel,
    ...target, rel: undefined, drift,
    fo: FO, bo: BO, adminFolder, adminEmail: creds.email,
    versions: versions(ws, compose, web),
    // What to put in front of a command so it runs inside this shop, where PHP and the database are.
    exec: `docker compose -p ${shop.project} -f ${COMPOSE} exec -T ${web}`,
    workspace: ws, project: shop.project, composeSha256,
    noCache: !!args['no-cache'], readyInSeconds: readyIn, readyAt: new Date().toISOString(),
  };
  writeJson(path.join(OUT, `${LABEL}.json`), measured);
  say(`ready in ${readyIn}s: PrestaShop ${measured.versions.prestashop || '?'}, PHP ${measured.versions.php || '?'}, back office ${BO}`);
  say(`measured in ${path.join(OUT, `${LABEL}.json`)}`);
  process.stdout.write(`${FO}\n`);
}

async function down() {
  const all = shops(SHOPS);
  const PR = opt('pr'); const AT = opt('at'); const REF = opt('ref'); const NAME = opt('name');
  let picked;
  if (args.all === true) picked = all;
  else if (PR) picked = all.filter((s) => s.rel === `pr-${PR}/${AT}` || (!AT && s.rel.startsWith(`pr-${PR}/`)));
  else if (REF) picked = all.filter((s) => [`branch/${slug(REF)}`, `tag/${slug(REF)}`].includes(s.rel) || (s.rel.startsWith('commit/') && s.sha.startsWith(REF)));
  else if (NAME) picked = all.filter((s) => s.rel === `custom/${NAME}`);
  else usage('down needs --pr, --ref, --name or --all');
  if (!picked.length) { say('no shop of this skill matches'); return; }

  for (const s of picked) {
    say(`stopping ${s.rel} and deleting its database${args.purge ? ', its image and its worktree' : ''}`);
    composeDown(s, args.purge ? ['--rmi', 'local'] : []);
    if (!args.purge) continue;
    if (fs.existsSync(s.ws) && !isOurs(s.ws)) { say(`note: ${s.ws} is not a worktree of ${MIRROR}, so it is left alone`); continue; }
    if (fs.existsSync(s.ws) && run('git', ['--git-dir', MIRROR, 'worktree', 'remove', '--force', '--force', s.ws]).status !== 0) {
      reclaim(s.ws);
      mgit('worktree', 'remove', '--force', '--force', s.ws);
    }
    fs.rmSync(s.state, { recursive: true, force: true });
    // Empty pr-N/ or branch/ directories left behind say nothing; remove them.
    for (let d = path.dirname(s.ws); inside(d, SHOPS) && d !== SHOPS; d = path.dirname(d)) {
      try { fs.rmdirSync(d); } catch (_) { break; }
    }
  }
  if (fs.existsSync(MIRROR)) run('git', ['--git-dir', MIRROR, 'worktree', 'prune']);
  if (args.purge && args.all === true && fs.existsSync(MIRROR)) {
    say(`deleting the mirror ${MIRROR}`);
    fs.rmSync(MIRROR, { recursive: true, force: true });
  }
}

function list() {
  const repos = [];
  if (REPO) repos.push([REPO, SHOPS]);
  else for (const o of fs.existsSync(HOME) ? fs.readdirSync(HOME) : []) {
    const od = path.join(HOME, o);
    if (o.startsWith('.') || !fs.statSync(od).isDirectory()) continue;
    for (const r of fs.readdirSync(od)) if (!r.endsWith('.git') && fs.statSync(path.join(od, r)).isDirectory()) repos.push([`${o}/${r}`, path.join(od, r)]);
  }
  const running = new Set((run('docker', ['ps', '--filter', 'label=prestashop-env.workspace', '--format', '{{.Label "com.docker.compose.project"}}']).stdout || '').split('\n').filter(Boolean));
  let n = 0;
  for (const [repo, dir] of repos) {
    for (const s of shops(dir)) {
      n++;
      say(`${repo}  ${s.rel.padEnd(24)} ${running.has(s.project) ? 'running' : 'stopped'}  http://localhost:${s.httpPort}  ${s.label}`);
    }
  }
  if (!n) say('no shop of this skill is on this machine');
}

const main = { up, down: () => locked('mirror', 'waiting for another build to release the mirror', 10 * 60000, down), list: async () => list() }[CMD];
main().catch((e) => die(e.stack || e.message));
