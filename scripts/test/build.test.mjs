// Generator tests. Run: node --test scripts/test/
// Each test works on a throw-away copy of the project, with fetch() mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOCK = pathToFileURL(path.join(ROOT, 'scripts', 'test', 'mock-github.mjs')).href;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-test-'));
  fs.cpSync(ROOT, dir, { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(p) });
  return dir;
}
function run(dir, { args = [], scenario = {}, env = {} } = {}) {
  const r = spawnSync(process.execPath, ['--import', MOCK, 'scripts/build.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_TOKEN: 'test-token', BUILD_RETRY_DELAY_MS: '1', MOCK_GITHUB: JSON.stringify(scenario), ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function snapshot(dir) {
  const h = crypto.createHash('sha1');
  const files = ['README.md', 'README.es.md', ...fs.readdirSync(path.join(dir, 'assets/generated')).map((f) => `assets/generated/${f}`)].sort();
  for (const f of files) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex');
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const WITH_ZENT = undefined;
const WITHOUT_ZENT = { repos: [{ nameWithOwner: 'ArnauAlemanyDev/ArnauAlemanyDev', stargazerCount: 0, isFork: false }] };

test('sample build: both READMEs, 5 numbered sections, project link, no leftovers', () => {
  const d = sandbox();
  const r = run(d, { args: ['--sample'], env: { GITHUB_TOKEN: '' } });
  assert.equal(r.code, 0, r.err);
  for (const f of ['README.md', 'README.es.md']) {
    const md = read(d, f);
    assert.match(md, /<a href="https:\/\/github\.com\/ArnauAlemanyDev\/Zent">/);
    assert.equal((md.match(/<h3>/g) || []).length, 5);
    assert.ok(!/Invox/i.test(md), 'stale Invox reference');
    assert.ok(!/\[(Repository|Repositorio|Live demo|Demo)\]/.test(md), 'blue link row must be gone');
    assert.ok(!/arnau\.alemany/.test(md.replace(/href="[^"]*"/g, '')), 'email address must not be visible text (only inside the mailto link)');
    assert.match(md, /href="mailto:arnau\.alemany\.espert@gmail\.com"/);
    for (const im of md.match(/<img\b[^>]*>/g)) assert.match(im, /alt="[^"]{3,}"/);
  }
  assert.match(read(d, 'README.md'), /<b>EN<\/b> · <a href="README\.es\.md">ES<\/a>/);
  assert.match(read(d, 'README.es.md'), /<a href="README\.md">EN<\/a> · <b>ES<\/b>/);
  // numbering in the generated headings
  const num = (key) => read(d, `assets/generated/section-${key}-en-dark.svg`).match(/>(\d\d)<\/text>/)[1];
  assert.deepEqual(['work', 'skills', 'education', 'year', 'connect'].map(num), ['01', '02', '03', '04', '05']);
  // no star glyph/number in project rows, and no Invox anywhere in generated assets
  for (const f of fs.readdirSync(path.join(d, 'assets/generated'))) assert.ok(!/Invox/i.test(read(d, `assets/generated/${f}`)), f);
});

test('live build: aggregates stars (forks excluded), paginates, exposes only configured projects', () => {
  const d = sandbox();
  const repos = [
    { nameWithOwner: 'ArnauAlemanyDev/ArnauAlemanyDev', stargazerCount: 0, isFork: false },
    { nameWithOwner: 'ArnauAlemanyDev/Zent', stargazerCount: 3, isFork: false },
    { nameWithOwner: 'ArnauAlemanyDev/a-fork', stargazerCount: 100, isFork: true },
    { nameWithOwner: 'ArnauAlemanyDev/other-public-repo', stargazerCount: 2, isFork: false },
  ];
  const r = run(d, { scenario: { repos, pageSize: 2 } });
  assert.equal(r.code, 0, r.err);
  const md = read(d, 'README.md');
  assert.match(md, /Repositories: 4\. Stars: 5\. Followers: 4\. Contributions, past year: 11\./);
  assert.match(read(d, 'assets/generated/year-en-dark.svg'), /11 contributions in the last 12 months · 8 commits · busiest week 9/);
  assert.ok(!md.includes('other-public-repo') && !md.includes('a-fork'));
});

test('unavailable project (renamed / private / deleted) is skipped, build still succeeds and renumbers', () => {
  const d = sandbox();
  const r = run(d, { scenario: WITHOUT_ZENT });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /Project "ArnauAlemanyDev\/Zent" is not among your public repositories/);
  const md = read(d, 'README.md');
  assert.ok(!md.includes('github.com/ArnauAlemanyDev/Zent'));
  assert.equal((md.match(/<h3>/g) || []).length, 4);
  assert.match(read(d, 'assets/generated/section-skills-en-dark.svg'), />01<\/text>/);
  assert.ok(!fs.existsSync(path.join(d, 'assets/generated/project-1-en-dark.svg')), 'obsolete project asset removed');
});

test('GitHub Actions: warnings are emitted as workflow annotations', () => {
  const d = sandbox();
  const r = run(d, { scenario: WITHOUT_ZENT, env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /::warning::Project "ArnauAlemanyDev\/Zent"/);
});

test('transient API errors are retried', () => {
  const d = sandbox();
  const r = run(d, { scenario: { mode: 'flaky', failFirst: 2 } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /retrying/);
});

const FAILURES = [
  ['persistent HTTP 500', { scenario: { mode: 'http500' } }, /failed after 3 attempts/],
  ['bad credentials (401)', { scenario: { mode: 'http401' } }, /rejected the token/],
  ['unknown account', { scenario: { mode: 'notfound' } }, /could not resolve the account/],
  ['empty contribution calendar', { scenario: { mode: 'empty-calendar' } }, /empty contribution calendar/],
  ['avatar download fails', { scenario: { mode: 'avatar-fail' } }, /Avatar download returned HTTP 404/],
  ['missing token', { env: { GITHUB_TOKEN: '' } }, /GITHUB_TOKEN is not set/],
  ['--sample inside CI', { args: ['--sample'], env: { GITHUB_ACTIONS: 'true' } }, /--sample must never run in CI/],
];
for (const [name, opts, pattern] of FAILURES) {
  test(`failure keeps last valid files, no sample fallback: ${name}`, () => {
    const d = sandbox();
    const before = snapshot(d);
    const r = run(d, opts);
    assert.equal(r.code, 1);
    assert.match(r.err, pattern);
    assert.match(r.err, /Existing files were left untouched/);
    assert.equal(snapshot(d), before, 'files changed despite the failure');
  });
}

test('invalid config is reported by field and writes nothing', () => {
  const d = sandbox();
  const cfgPath = path.join(d, 'profile.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  delete cfg.projects[0].description.es;
  cfg.contact[1].enabled = true; // enabled but empty href
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const before = snapshot(d);
  const r = run(d, { args: ['--sample'] });
  assert.equal(r.code, 1);
  assert.match(r.err, /projects\[0\]\.description needs "en" and "es"/);
  assert.match(r.err, /contact\[1\] \("linkedin"\) is enabled but "href"/);
  assert.equal(snapshot(d), before);
});

test('enabling a contact channel adds it to both READMEs', () => {
  const d = sandbox();
  const cfgPath = path.join(d, 'profile.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  Object.assign(cfg.contact[1], { enabled: true, href: 'https://www.linkedin.com/in/example' });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  assert.equal(run(d, { args: ['--sample'] }).code, 0);
  for (const f of ['README.md', 'README.es.md']) assert.match(read(d, f), /href="https:\/\/www\.linkedin\.com\/in\/example"/);
});

test('cleanup only removes obsolete generated SVGs, never unrelated files', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(d, 'assets/generated/obsolete-thing.svg'), '<svg/>');
  fs.writeFileSync(path.join(d, 'assets/header-dark.svg'), '<svg/>'); // someone else's file
  assert.equal(run(d, { args: ['--sample'] }).code, 0);
  assert.ok(!fs.existsSync(path.join(d, 'assets/generated/obsolete-thing.svg')));
  assert.ok(fs.existsSync(path.join(d, 'assets/header-dark.svg')));
});

test('a missing icon degrades to a dot instead of breaking the build', () => {
  const d = sandbox();
  fs.rmSync(path.join(d, 'assets/icons/simple/react.svg'));
  const r = run(d, { args: ['--sample'] });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /Icon "react" is not available/);
});
