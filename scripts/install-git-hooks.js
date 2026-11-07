// Installs this repo's committed git hooks (githooks/) into .git/hooks/,
// so they actually run for every contributor without each person having
// to set core.hooksPath by hand. Runs automatically via npm's "prepare"
// lifecycle script on `npm install`; safe to re-run any time with
// `npm run prepare` or `node scripts/install-git-hooks.js`.
//
// Deliberately a plain copy, not a symlink (symlinks need an extra
// Windows privilege/dev-mode setting this team can't assume everyone
// has) and not core.hooksPath (that would redirect EVERY hook, including
// any personal/local ones a contributor already has in .git/hooks/,
// which this repo has no business touching).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function main() {
  let gitDir;
  try {
    gitDir = execSync('git rev-parse --git-dir', { cwd: __dirname, encoding: 'utf8' }).trim();
  } catch (err) {
    console.log('install-git-hooks: not inside a git repository, skipping (fine for a packaged/deployed copy).');
    return;
  }
  const repoRoot = path.join(__dirname, '..');
  const hooksSrcDir = path.join(repoRoot, 'githooks');
  const hooksDestDir = path.isAbsolute(gitDir) ? path.join(gitDir, 'hooks') : path.join(repoRoot, gitDir, 'hooks');
  if (!fs.existsSync(hooksSrcDir)) {
    console.log('install-git-hooks: no githooks/ directory found, nothing to install.');
    return;
  }
  fs.mkdirSync(hooksDestDir, { recursive: true });
  const files = fs.readdirSync(hooksSrcDir).filter((f) => !f.endsWith('.md'));
  for (const file of files) {
    const src = path.join(hooksSrcDir, file);
    const dest = path.join(hooksDestDir, file);
    fs.copyFileSync(src, dest);
    try { fs.chmodSync(dest, 0o755); } catch (err) { /* chmod is a no-op on Windows filesystems - Git for Windows still runs the hook */ }
    console.log('install-git-hooks: installed ' + file + ' -> ' + dest);
  }
}

main();
