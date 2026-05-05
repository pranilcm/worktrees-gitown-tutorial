#!/usr/bin/env node
/**
 * Git Worktrees & Git Town — Interactive Demo Server
 * Runs real git commands in a sandboxed repo and streams output back to the demo page.
 */

const http = require('http');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 7391;
const SANDBOX_DIR = path.join(os.tmpdir(), 'git-demo-sandbox');
const WORKTREES_DIR = path.join(os.tmpdir(), 'git-demo-worktrees');

// ── CORS helper ──
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Run a command, resolve with { stdout, stderr, code } ──
function run(cmd, args, cwd, env = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      timeout: 15000,
    }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: err ? (err.code || 1) : 0,
      });
    });
  });
}

// ── Stream a command line-by-line via SSE ──
function stream(cmd, args, cwd, res, env = {}) {
  cors(res);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', TERM: 'dumb', ...env },
  });

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  proc.stdout.on('data', d => send('stdout', d.toString()));
  proc.stderr.on('data', d => send('stderr', d.toString()));
  proc.on('close', code => {
    send('exit', code);
    res.end();
  });
}

// ── Setup the sandbox repo ──
async function setupSandbox() {
  // Clean previous runs
  fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
  fs.rmSync(WORKTREES_DIR, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });

  const g = (args, cwd = SANDBOX_DIR) => run('git', args, cwd);

  await g(['init', '-b', 'main']);
  await g(['config', 'user.email', 'demo@gitdemo.dev']);
  await g(['config', 'user.name', 'Git Demo']);
  await g(['config', 'commit.gpgsign', 'false']);

  // Seed files
  fs.writeFileSync(path.join(SANDBOX_DIR, 'README.md'), '# Demo App\nA sample project for the Git demo.\n');
  fs.writeFileSync(path.join(SANDBOX_DIR, 'app.js'), 'console.log("Hello, world!");\n');
  fs.mkdirSync(path.join(SANDBOX_DIR, 'src'), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX_DIR, 'src', 'index.js'), 'export default {};\n');

  await g(['add', '.']);
  await g(['commit', '-m', 'Initial commit: bootstrap project']);

  // Add a couple more commits for realism
  fs.writeFileSync(path.join(SANDBOX_DIR, 'src', 'auth.js'), 'export function login() {}\n');
  await g(['add', '.']);
  await g(['commit', '-m', 'Add auth module stub']);

  fs.writeFileSync(path.join(SANDBOX_DIR, 'src', 'api.js'), 'export function fetchUser() {}\n');
  await g(['add', '.']);
  await g(['commit', '-m', 'Add API module stub']);

  console.log(`✓ Sandbox repo ready at ${SANDBOX_DIR}`);
  return SANDBOX_DIR;
}

// ── Command registry ──
// Maps step IDs to actual git commands executed in the sandbox
const STEPS = {
  // ─ Worktree steps ─
  'wt-list-before': async (res) => {
    stream('git', ['worktree', 'list'], SANDBOX_DIR, res);
  },
  'wt-add-feature': async (res) => {
    const target = path.join(WORKTREES_DIR, 'project-feature');
    fs.rmSync(target, { recursive: true, force: true });
    stream('git', ['worktree', 'add', target, '-b', 'feature/user-auth'], SANDBOX_DIR, res);
  },
  'wt-add-hotfix': async (res) => {
    const target = path.join(WORKTREES_DIR, 'project-hotfix');
    fs.rmSync(target, { recursive: true, force: true });
    stream('git', ['worktree', 'add', target, '-b', 'hotfix/critical-bug'], SANDBOX_DIR, res);
  },
  'wt-list-after': async (res) => {
    stream('git', ['worktree', 'list'], SANDBOX_DIR, res);
  },
  'wt-commit-hotfix': async (res) => {
    const hotfixDir = path.join(WORKTREES_DIR, 'project-hotfix');
    fs.writeFileSync(path.join(hotfixDir, 'hotfix.js'), `// Critical bug fix — patched at ${Date.now()}\nexport function fixLogin() { return true; }\n`);
    const g = (args) => run('git', args, hotfixDir, { GIT_AUTHOR_NAME: 'Git Demo', GIT_COMMITTER_NAME: 'Git Demo', GIT_AUTHOR_EMAIL: 'demo@gitdemo.dev', GIT_COMMITTER_EMAIL: 'demo@gitdemo.dev' });
    await g(['add', '.']);
    stream('git', ['commit', '-m', 'fix: resolve login crash on null session'], hotfixDir, res, {
      GIT_AUTHOR_NAME: 'Git Demo', GIT_COMMITTER_NAME: 'Git Demo',
      GIT_AUTHOR_EMAIL: 'demo@gitdemo.dev', GIT_COMMITTER_EMAIL: 'demo@gitdemo.dev',
    });
  },
  'wt-feature-untouched': async (res) => {
    // Show that feature worktree is completely clean / unchanged
    stream('git', ['status'], path.join(WORKTREES_DIR, 'project-feature'), res);
  },
  'wt-remove-hotfix': async (res) => {
    cors(res);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    const result = await run('git', ['worktree', 'remove', path.join(WORKTREES_DIR, 'project-hotfix')], SANDBOX_DIR);
    if (result.code === 0) {
      send('stdout', `Removed worktree: ${path.join(WORKTREES_DIR, 'project-hotfix')}\n✓ Hotfix directory deleted. Branch hotfix/critical-bug still exists in the repo.\n`);
    } else {
      send('stderr', result.stderr || 'Failed to remove worktree\n');
    }
    send('exit', result.code);
    res.end();
  },
  'wt-list-final': async (res) => {
    stream('git', ['worktree', 'list'], SANDBOX_DIR, res);
  },
  'wt-log': async (res) => {
    stream('git', ['log', '--oneline', '--all', '--graph', '--decorate'], SANDBOX_DIR, res);
  },

  // ─ Git Town steps ─
  // Git Town needs a remote — we use a bare clone as the "remote"
  'gt-setup': async (res) => {
    cors(res);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);

    const remoteDir = path.join(WORKTREES_DIR, 'remote.git');
    fs.rmSync(remoteDir, { recursive: true, force: true });

    send('stdout', `Setting up bare remote at ${remoteDir}\n`);
    await run('git', ['clone', '--bare', SANDBOX_DIR, remoteDir], os.tmpdir());
    send('stdout', `✓ Bare remote created\n`);

    await run('git', ['remote', 'remove', 'origin'], SANDBOX_DIR);
    await run('git', ['remote', 'add', 'origin', remoteDir], SANDBOX_DIR);
    await run('git', ['fetch', 'origin'], SANDBOX_DIR);
    await run('git', ['branch', '--set-upstream-to=origin/main', 'main'], SANDBOX_DIR);
    send('stdout', `✓ origin remote pointed at bare repo\n`);

    // Configure git town
    await run('git-town', ['config', 'main-branch', 'main'], SANDBOX_DIR);
    send('stdout', `✓ git town configured (main-branch = main)\n`);

    send('stdout', `\nReady! Run "git town hack feature/payment" next.\n`);
    send('exit', 0);
    res.end();
  },
  'gt-hack': async (res) => {
    // Remove branch if it already exists from a previous run
    await run('git', ['branch', '-D', 'feature/payment'], SANDBOX_DIR).catch(() => {});
    await run('git', ['push', 'origin', '--delete', 'feature/payment'], SANDBOX_DIR).catch(() => {});
    stream('git-town', ['hack', 'feature/payment'], SANDBOX_DIR, res);
  },
  'gt-add-work': async (res) => {
    cors(res);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);

    fs.writeFileSync(path.join(SANDBOX_DIR, 'src', 'payment.js'), '// Payment gateway\nexport async function charge(amount) {\n  return { status: "ok", amount };\n}\n');
    const env = { GIT_AUTHOR_NAME: 'Git Demo', GIT_COMMITTER_NAME: 'Git Demo', GIT_AUTHOR_EMAIL: 'demo@gitdemo.dev', GIT_COMMITTER_EMAIL: 'demo@gitdemo.dev' };
    await run('git', ['add', '.'], SANDBOX_DIR, env);
    const r = await run('git', ['commit', '-m', 'feat: add payment gateway'], SANDBOX_DIR, env);
    send('stdout', r.stdout + '\n');
    send('stdout', '✓ Committed src/payment.js on feature/payment\n');
    send('exit', 0);
    res.end();
  },
  'gt-sync': async (res) => {
    stream('git-town', ['sync'], SANDBOX_DIR, res);
  },
  'gt-diff-parent': async (res) => {
    stream('git-town', ['diff-parent'], SANDBOX_DIR, res);
  },
  'gt-ship': async (res) => {
    stream('git-town', ['ship', '--message', 'feat: payment gateway (squash)'], SANDBOX_DIR, res,
      { GIT_AUTHOR_NAME: 'Git Demo', GIT_COMMITTER_NAME: 'Git Demo', GIT_AUTHOR_EMAIL: 'demo@gitdemo.dev', GIT_COMMITTER_EMAIL: 'demo@gitdemo.dev' });
  },
  'gt-log': async (res) => {
    stream('git', ['log', '--oneline', '--all', '--graph', '--decorate'], SANDBOX_DIR, res);
  },

  // ─ Sandbox info ─
  'sandbox-info': async (res) => {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sandboxDir: SANDBOX_DIR, worktreesDir: WORKTREES_DIR }));
  },
  'sandbox-reset': async (res) => {
    cors(res);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    send('stdout', 'Resetting sandbox...\n');
    await setupSandbox();
    send('stdout', '✓ Sandbox reset. Fresh repo ready.\n');
    send('exit', 0);
    res.end();
  },
};

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const step = url.searchParams.get('step');

  if (url.pathname === '/run' && step) {
    const handler = STEPS[step];
    if (!handler) {
      cors(res);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown step: ${step}` }));
      return;
    }
    try {
      await handler(res);
    } catch (err) {
      cors(res);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/health') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sandbox: SANDBOX_DIR }));
    return;
  }

  cors(res);
  res.writeHead(404);
  res.end();
});

// ── Boot ──
(async () => {
  console.log('⚙  Setting up sandbox repo...');
  await setupSandbox();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n🚀 Demo server running at http://localhost:${PORT}`);
    console.log(`   Sandbox: ${SANDBOX_DIR}`);
    console.log(`   Worktrees dir: ${WORKTREES_DIR}\n`);
    console.log('   Open git-worktrees-gittown.html in your browser and click "▶ Run" on any step.\n');
  });
})();
