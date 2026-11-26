#!/usr/bin/env node
// Generates README.md (EN), README.es.md (ES) and the SVG assets in assets/generated/
// from profile.config.json + live GitHub data.
//
//   node scripts/build.mjs            live data (needs GITHUB_TOKEN; the Action provides it)
//   node scripts/build.mjs --sample   offline preview from scripts/sample-data.json
//
// Failure policy: everything is generated and validated in memory first. If anything fails
// (API down, bad token, invalid config) NOTHING is written, so the last valid files stay in
// place, and sample data is never used as a substitute for live data.
//
// No dependencies. Node 18+.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGULAR, BOLD } from './text-metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'generated');
const ICON_DIR = path.join(ROOT, 'assets', 'icons');
const SAMPLE = process.argv.includes('--sample');
const LANGS = ['en', 'es'];
const RETRY_DELAY = Number(process.env.BUILD_RETRY_DELAY_MS ?? 1000);

/* ───────────────────────── errors & logging ───────────────────────── */

class BuildError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

function warn(msg) {
  console.warn(`! ${msg}`);
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning::${msg.replace(/\s*\n\s*/g, ' ')}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries transient failures (network, 5xx). BuildError means "retrying will not help".
async function withRetry(label, fn, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (err instanceof BuildError || i === attempts) break;
      const wait = RETRY_DELAY * 2 ** (i - 1);
      warn(`${label} failed (${err.message}); retrying in ${wait / 1000}s (${i}/${attempts - 1})`);
      await sleep(wait);
    }
  }
  if (last instanceof BuildError) throw last;
  throw new BuildError(`${label} failed after ${attempts} attempts: ${last.message}`, 'This is usually a temporary GitHub outage. Re-run the workflow later; the previous files were kept.');
}

/* ───────────────────────── config ───────────────────────── */

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.config.json'), 'utf8'));
} catch (err) {
  console.error(`✖ Cannot read profile.config.json: ${err.message}`);
  process.exit(1);
}

const loc = (v, lang) => (typeof v === 'string' ? v : v?.[lang]);
const hasLoc = (v) => LANGS.every((l) => typeof loc(v, l) === 'string' && loc(v, l).trim() !== '');

function validateConfig() {
  const errs = [];
  const need = (ok, msg) => ok || errs.push(msg);
  need(cfg.username, '"username" is required');
  need(cfg.displayName, '"displayName" is required');
  const SECTION_KEYS = ['work', 'skills', 'education', 'year', 'connect'];
  for (const lang of LANGS) {
    const L = cfg.i18n?.[lang];
    if (!L) {
      errs.push(`"i18n.${lang}" is missing`);
      continue;
    }
    for (const k of ['handle', 'subtitle', 'openRepo']) need(L[k], `"i18n.${lang}.${k}" is required`);
    for (const k of ['repos', 'stars', 'followers', 'contributions']) need(L.stats?.[k], `"i18n.${lang}.stats.${k}" is required`);
    for (const k of SECTION_KEYS) need(L.sections?.[k], `"i18n.${lang}.sections.${k}" is required`);
    for (const k of ['contributions', 'commits']) need(L.chart?.[k]?.one && L.chart?.[k]?.other, `"i18n.${lang}.chart.${k}" needs "one" and "other"`);
    for (const k of ['busiest', 'none', 'alt']) need(L.chart?.[k], `"i18n.${lang}.chart.${k}" is required`);
  }
  (cfg.projects || []).forEach((p, i) => {
    need(/^[\w.-]+\/[\w.-]+$/.test(p.repo || ''), `projects[${i}].repo must look like "owner/name"`);
    need(p.name, `projects[${i}].name is required`);
    need(hasLoc(p.description), `projects[${i}].description needs "en" and "es"`);
    if (p.demo) need(/^https:\/\//.test(p.demo), `projects[${i}].demo must be an https URL`);
  });
  (cfg.skills?.groups || []).forEach((g, i) => {
    need(hasLoc(g.label), `skills.groups[${i}].label needs "en" and "es"`);
    (g.items || []).forEach((it, k) => need(hasLoc(it.name), `skills.groups[${i}].items[${k}].name is required`));
  });
  (cfg.education || []).forEach((e, i) => {
    for (const k of ['title', 'kind', 'detail']) need(hasLoc(e[k]), `education[${i}].${k} needs "en" and "es" (or a plain string)`);
  });
  (cfg.contact || []).forEach((c, i) => {
    if (!c.enabled) return;
    need(/^(https:\/\/|mailto:)/.test(c.href || ''), `contact[${i}] ("${c.id}") is enabled but "href" must start with https:// or mailto:`);
    need(hasLoc(c.label), `contact[${i}].label needs "en" and "es"`);
  });
  if (errs.length) throw new BuildError(`profile.config.json has problems:\n  - ${errs.join('\n  - ')}`, 'Fix the listed fields and run the build again.');
}

/* ───────────────────────── design tokens ───────────────────────── */

// Every SVG exists in two layouts. GitHub scales images to the container width, so a 640px
// layout would shrink to ~54% on a phone and its small labels become unreadable. The narrow
// layout is drawn at 360px and chosen with <source media="(max-width: …)">.
const VIEWS = {
  wide: { suffix: '', W: 640, compact: false },
  narrow: { suffix: '-m', W: 360, compact: true },
};
const NARROW_MAX = 600; // viewport px

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

// Backgrounds are transparent so the SVGs sit directly on GitHub's own page colour.
const THEMES = {
  dark: { text: '#E6EDF3', soft: '#C9D1D9', muted: '#8B949E', green: '#3FB950', rule: '#21262D', ring: '#30363D' },
  light: { text: '#1F2328', soft: '#3D444D', muted: '#59636E', green: '#1A7F37', rule: '#D1D9E0', ring: '#D1D9E0' },
};

/* ───────────────────────── helpers ───────────────────────── */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
const plural = (o, n) => fill(n === 1 ? o.one : o.other, { n });
const nf = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const num = (n) => (n < 1000 ? String(n) : nf.format(n).toLowerCase());

// Real fonts differ from the Arial metrics used for estimates (Inter ≈ +8%, SF ≈ +5%, DejaVu ≈ +19%).
// Layout keeps a safety margin so text is never clipped at the right edge of an SVG.
const SAFETY = 1.12;

// Estimated text width (px) — only used for wrapping and for placing rules/arrows.
function tw(s, size, bold = false, ls = 0) {
  const table = bold ? BOLD : REGULAR;
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    w += c < 256 ? table[c] : 1000;
  }
  return (w * size) / 1000 + ls * (s.length - 1);
}
const mw = (s, size) => s.length * size * 0.6;

function wrap(text, maxW, size, bold = false) {
  const lines = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const word of para.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (!cur || tw(next, size, bold) * SAFETY <= maxW) cur = next;
      else {
        lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

// Greedy line-fill of short mono segments joined with " · ".
function wrapSegments(segs, maxW, size) {
  const lines = [];
  let cur = '';
  for (const sgm of segs) {
    const next = cur ? `${cur} · ${sgm}` : sgm;
    if (!cur || mw(next, size) * 1.04 <= maxW) cur = next;
    else {
      lines.push(cur);
      cur = sgm;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Joins fragments into clean alt text: "Fragment one. Fragment two."
const sentences = (xs) =>
  xs
    .filter(Boolean)
    .map((x) => x.trim().replace(/[.\s]+$/, ''))
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
    .join('. ') + '.';

function t(x, y, str, { size, fillColor, mono = false, weight, anchor, ls }) {
  return `<text x="${x}" y="${y}" class="${mono ? 'm' : 's'}" font-size="${size}" fill="${fillColor}"${
    weight ? ` font-weight="${weight}"` : ''
  }${anchor ? ` text-anchor="${anchor}"` : ''}${ls ? ` letter-spacing="${ls}"` : ''}>${esc(str)}</text>`;
}

function svg(W, H, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<style>.s{font-family:${SANS}}.m{font-family:${MONO}}</style>
${body}
</svg>
`;
}

const hline = (x1, x2, y, color) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${color}" stroke-width="1"/>`;

// Small "opens a link" arrow (↗), drawn as a path so it never depends on font glyphs.
const arrow = (cx, cy, color) =>
  `<path d="M${cx - 4} ${cy + 4}L${cx + 4} ${cy - 4}M${cx - 3} ${cy - 4}H${cx + 4}V${cy + 3}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;

/* ───────────────────────── data ───────────────────────── */

async function gql(query, variables = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new BuildError(
      'GITHUB_TOKEN is not set.',
      'In GitHub Actions it is provided by secrets.GITHUB_TOKEN. Locally, export GITHUB_TOKEN or use --sample for an offline preview.',
    );
  }
  return withRetry('GitHub API request', async () => {
    let res;
    try {
      res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-readme-builder' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      throw new Error(`network error: ${err.message}`);
    }
    if (res.status >= 500) throw new Error(`GitHub API responded ${res.status}`);
    if (res.status === 401) throw new BuildError('GitHub rejected the token (HTTP 401).', 'Check that the workflow passes secrets.GITHUB_TOKEN and that the token has not been revoked.');
    if (res.status === 403 || res.status === 429) throw new BuildError(`GitHub API refused the request (HTTP ${res.status}): rate limit or missing permissions.`, 'Wait and re-run the workflow. No data was replaced.');
    if (!res.ok) throw new BuildError(`GitHub API responded ${res.status}.`);
    const json = await res.json();
    if (json.errors?.length) {
      const e = json.errors[0];
      if (e.type === 'NOT_FOUND') throw new BuildError(`GitHub could not resolve the account: ${e.message}`, 'Check "username" in profile.config.json (or PROFILE_USER).');
      throw new BuildError(`GitHub API error: ${e.message}`);
    }
    return json.data;
  });
}

async function loadLive() {
  const login = process.env.PROFILE_USER || cfg.username;
  const repoFields = 'nameWithOwner stargazerCount isFork';
  const data = await gql(
    `query($login: String!) {
      user(login: $login) {
        createdAt
        avatarUrl(size: 208)
        followers { totalCount }
        repositories(ownerAffiliations: OWNER, privacy: PUBLIC, first: 100) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { ${repoFields} }
        }
        contributionsCollection {
          totalCommitContributions
          contributionCalendar { totalContributions weeks { contributionDays { contributionCount } } }
        }
      }
    }`,
    { login },
  );
  const u = data?.user;
  if (!u) throw new BuildError(`GitHub returned no data for "${login}".`, 'Check "username" in profile.config.json.');

  // One list of PUBLIC repositories gives us the star total and the allow-list of projects.
  // No per-repository query exists, so a renamed, deleted or private repo cannot break the build.
  let repos = u.repositories;
  let stars = 0;
  const publicRepos = [];
  for (;;) {
    for (const r of repos.nodes) {
      publicRepos.push(r.nameWithOwner);
      if (!r.isFork) stars += r.stargazerCount;
    }
    if (!repos.pageInfo.hasNextPage) break;
    const more = await gql(
      `query($login: String!, $after: String) {
        user(login: $login) { repositories(ownerAffiliations: OWNER, privacy: PUBLIC, first: 100, after: $after) {
          pageInfo { hasNextPage endCursor } nodes { ${repoFields} } } }
      }`,
      { login, after: repos.pageInfo.endCursor },
    );
    repos = more.user.repositories;
  }

  const cal = u.contributionsCollection?.contributionCalendar;
  const weeks = (cal?.weeks || []).map((w) => w.contributionDays.reduce((s, d) => s + d.contributionCount, 0));
  if (!weeks.length) throw new BuildError('GitHub returned an empty contribution calendar.', 'Nothing was replaced. Try again later.');

  const avatar = await withRetry('Avatar download', async () => {
    let res;
    try {
      res = await fetch(u.avatarUrl, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new Error(`network error: ${err.message}`);
    }
    if (res.status >= 500) throw new Error(`avatar server responded ${res.status}`);
    const mime = (res.headers.get('content-type') || '').split(';')[0];
    if (!res.ok || !mime.startsWith('image/')) throw new BuildError(`Avatar download returned HTTP ${res.status} (${mime || 'no content-type'}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 500_000) throw new BuildError('Avatar is unexpectedly large (>500 kB).');
    return { mime, b64: buf.toString('base64') };
  });

  return {
    since: new Date(u.createdAt).getUTCFullYear(),
    repos: u.repositories.totalCount,
    stars,
    followers: u.followers.totalCount,
    commits: u.contributionsCollection.totalCommitContributions,
    contributions: cal.totalContributions,
    weeks,
    publicRepos,
    avatar,
  };
}

function loadSample() {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'sample-data.json'), 'utf8'));
  const ext = fs.existsSync(path.join(ROOT, 'assets', 'avatar-placeholder.jpg')) ? 'jpg' : 'png';
  const img = fs.readFileSync(path.join(ROOT, 'assets', `avatar-placeholder.${ext}`));
  return {
    since: new Date(s.createdAt).getUTCFullYear(),
    repos: s.repos,
    stars: s.stars,
    followers: s.followers,
    commits: s.commits,
    contributions: s.weeklyTotals.reduce((a, b) => a + b, 0),
    weeks: s.weeklyTotals,
    publicRepos: s.publicRepos,
    avatar: { mime: ext === 'jpg' ? 'image/jpeg' : 'image/png', b64: img.toString('base64') },
  };
}

/* ───────────────────────── icons ───────────────────────── */

// "react" → assets/icons/simple/react.svg (Simple Icons, CC0)
// "mdi:database" → assets/icons/mdi/database.svg (Material Design Icons, Apache-2.0)
// Icons are local files. A missing Simple Icons file is downloaded once and cached; nothing is
// ever loaded from a third party when the profile is viewed.
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]+$/;

async function loadIcon(ref) {
  const [set, name] = ref.includes(':') ? ref.split(':') : ['simple', ref];
  if (!['simple', 'mdi'].includes(set) || !/^[a-z0-9-]+$/.test(name)) return null;
  const file = path.join(ICON_DIR, set, `${name}.svg`);
  if (!fs.existsSync(file) && set === 'simple' && !SAMPLE) {
    try {
      const r = await fetch(`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${name}.svg`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, await r.text());
      }
    } catch {
      /* falls through: icon unavailable */
    }
  }
  if (!fs.existsSync(file)) return null;
  const paths = [...fs.readFileSync(file, 'utf8').matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  return paths.length === 1 && PATH_DATA.test(paths[0]) ? paths[0] : null;
}

/* ───────────────────────── components ───────────────────────── */

function header(lang, c, d, v) {
  const L = cfg.i18n[lang];
  const { W, compact } = v;
  const handle = fill(L.handle, { year: d.since });
  const alt = sentences([cfg.displayName, L.subtitle, handle, L.intro]);
  const parts = [t(0, 18, handle, { size: compact ? 11.5 : 12.5, fillColor: c.muted, mono: true })];
  const r = compact ? 30 : 46; // avatar radius; the ring sits 3.25px outside it
  const cx = W - (r + 4);
  const cy = compact ? 38 : 80;
  let H;

  if (compact) {
    const sub = wrap(L.subtitle, W, 16);
    const intro = L.intro ? wrap(L.intro, W, 14) : [];
    const subY = 144;
    const introY = subY + (sub.length - 1) * 21 + 34;
    parts.push(t(0, 112, cfg.displayName, { size: 40, fillColor: c.text, weight: 700, ls: -1.1 }));
    sub.forEach((l, i) => parts.push(t(0, subY + i * 21, l, { size: 16, fillColor: c.soft })));
    intro.forEach((l, i) => parts.push(t(0, introY + i * 20, l, { size: 14, fillColor: c.muted })));
    H = (intro.length ? introY + (intro.length - 1) * 20 : subY + (sub.length - 1) * 21) + 28;
  } else {
    const intro = L.intro ? wrap(L.intro, 480, 15) : [];
    const introY = 172;
    parts.push(t(0, 94, cfg.displayName, { size: 56, fillColor: c.text, weight: 700, ls: -1.6 }));
    parts.push(t(0, 134, L.subtitle, { size: 19, fillColor: c.soft }));
    intro.forEach((l, i) => parts.push(t(0, introY + i * 22, l, { size: 15, fillColor: c.muted })));
    H = intro.length ? introY + (intro.length - 1) * 22 + 30 : 168;
  }

  parts.push(
    `<defs><clipPath id="a"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>`,
    `<circle cx="${cx}" cy="${cy}" r="${r + 3.25}" stroke="${c.ring}" stroke-width="1.5"/>`,
    `<image x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#a)" href="data:${d.avatar.mime};base64,${d.avatar.b64}"/>`,
  );
  return { alt, svg: svg(W, H, cfg.displayName, alt, parts.join('\n')) };
}

// Figures are deliberately modest: they support the portfolio, they are not the portfolio.
function stats(lang, c, d, v) {
  const L = cfg.i18n[lang].stats;
  const cols = [
    [d.repos, L.repos],
    [d.stars, L.stars],
    [d.followers, L.followers],
    [d.contributions, L.contributions],
  ];
  const alt = sentences(cols.map(([n, label]) => `${label}: ${n}`));
  const parts = [hline(0, v.W, 0.5, c.rule)];
  let H;
  if (v.compact) {
    const xs = [0, 150];
    const rowH = 66;
    cols.forEach(([n, label], i) => {
      const x = xs[i % 2];
      const row = Math.floor(i / 2);
      parts.push(t(x, 42 + row * rowH, num(n), { size: 24, fillColor: c.text, weight: 600 }));
      parts.push(t(x, 62 + row * rowH, label, { size: 12, fillColor: c.muted, mono: true }));
    });
    H = 62 + rowH + 14;
  } else {
    const xs = [0, 140, 280, 420];
    cols.forEach(([n, label], i) => {
      parts.push(t(xs[i], 43, num(n), { size: 25.5, fillColor: c.text, weight: 600 }));
      parts.push(t(xs[i], 64, label, { size: 12, fillColor: c.muted, mono: true }));
    });
    H = 80;
  }
  return { alt, svg: svg(v.W, H, 'GitHub', alt, parts.join('\n')) };
}

function section(index, title, c, v) {
  const label = String(index).padStart(2, '0');
  const x0 = 30;
  const ruleStart = x0 + tw(title, 16, true) * SAFETY + 14;
  const body = [
    t(0, 19, label, { size: 12.5, fillColor: c.green, mono: true }),
    t(x0, 19, title, { size: 16, fillColor: c.text, weight: 600 }),
    hline(ruleStart, v.W, 14.5, c.rule),
  ].join('\n');
  const alt = `${label} — ${title}`;
  return { alt, svg: svg(v.W, 30, title, alt, body) };
}

// The whole entry is wrapped in an HTML link by the README (see readme()), so the arrow only
// signals that it is navigable. SVG-internal links do not work inside <img>, so none are used.
function project(lang, p, index, c, v) {
  const L = cfg.i18n[lang];
  const { W, compact } = v;
  const desc = loc(p.description, lang);
  const dSize = compact ? 14 : 14.5;
  const dStep = compact ? 20 : 21;
  const lines = wrap(desc, W - 30 - (compact ? 4 : 20), dSize);
  const techLines = p.tech?.length ? wrapSegments(p.tech, W - 30, compact ? 11.5 : 12) : [];
  const top = index > 0 ? 22 : 8;
  const nameY = top + 24;
  const descY = nameY + 28;
  const techY = descY + (lines.length - 1) * dStep + 26;
  const H = (techLines.length ? techY + (techLines.length - 1) * 17 : descY + (lines.length - 1) * dStep) + 20;
  const body = [
    index > 0 ? hline(30, W, 0.5, c.rule) : '',
    t(0, nameY - 1, String(index + 1).padStart(2, '0'), { size: 12.5, fillColor: c.muted, mono: true }),
    t(30, nameY, p.name, { size: 22, fillColor: c.text, weight: 600, ls: -0.3 }),
    arrow(W - 6, nameY - 7, c.muted),
    ...lines.map((l, i) => t(30, descY + i * dStep, l, { size: dSize, fillColor: c.soft })),
    ...techLines.map((l, i) => t(30, techY + i * 17, l, { size: compact ? 11.5 : 12, fillColor: c.muted, mono: true })),
  ]
    .filter(Boolean)
    .join('\n');
  const alt = sentences([`${String(index + 1).padStart(2, '0')} ${p.name}`, desc, p.tech?.length ? p.tech.join(' · ') : '', L.openRepo]);
  return { alt, svg: svg(W, H, p.name, alt, body) };
}

// Categories are blocks with a ruled mono heading (like the section headings, one level down),
// laid out in two balanced columns on wide screens and one column on narrow ones.
function skills(lang, c, icons, v) {
  const { W, compact } = v;
  const useIcons = cfg.skills.icons;
  const COLS = compact ? 1 : 2;
  const GAP = 40;
  const colW = (W - GAP * (COLS - 1)) / COLS;
  const SUB = 2;
  const subW = colW / SUB;
  const ROW = 30;
  const HEAD = 42;
  const AFTER = 28;

  const heights = Array(COLS).fill(0);
  const parts = [];
  const textOut = [];

  cfg.skills.groups.forEach((g) => {
    const label = loc(g.label, lang);
    const rows = Math.ceil(g.items.length / SUB);
    const col = heights.indexOf(Math.min(...heights));
    const top = heights[col];
    const x0 = col * (colW + GAP);
    heights[col] += HEAD + (rows - 1) * ROW + AFTER;

    parts.push(t(x0, top + 12, label, { size: 12.5, fillColor: c.muted, mono: true }));
    parts.push(hline(x0 + mw(label, 12.5) * 1.04 + 14, x0 + colW, top + 8.5, c.rule));

    g.items.forEach((it, k) => {
      const name = loc(it.name, lang);
      const note = it.note ? loc(it.note, lang) : '';
      let x = x0 + (k % SUB) * subW;
      const by = top + HEAD + Math.floor(k / SUB) * ROW;
      const need = (useIcons ? 24 : 0) + tw(name, 15) * SAFETY + (note ? 8 + mw(note, 11.5) * 1.04 : 0);
      if (need > subW - 8) warn(`Skill "${name}" (${lang}) may not fit its column; shorten the name or note.`);
      if (useIcons) {
        const d = it.icon ? icons[it.icon] : null;
        parts.push(
          d
            ? `<path transform="translate(${x} ${by - 13.3}) scale(0.6667)" d="${d}" fill="${c.muted}"/>`
            : `<circle cx="${x + 8}" cy="${by - 5.3}" r="2" fill="${c.muted}"/>`,
        );
        x += 24;
      }
      parts.push(t(x, by, name, { size: 15, fillColor: c.text }));
      if (note) parts.push(t(x + tw(name, 15) + 8, by, note, { size: 11.5, fillColor: c.muted, mono: true }));
    });
    textOut.push(`${label}: ${g.items.map((i) => loc(i.name, lang) + (i.note ? ` (${loc(i.note, lang)})` : '')).join(', ')}`);
  });

  const H = Math.max(...heights) - AFTER + 12;
  const alt = sentences(textOut);
  return { alt, svg: svg(W, H, cfg.i18n[lang].sections.skills, alt, parts.join('\n')) };
}

function education(lang, c, v) {
  const { W, compact } = v;
  const tSize = compact ? 16 : 17;
  const parts = [];
  const textOut = [];
  let y = 0;
  cfg.education.forEach((e, i) => {
    // Manual "\n" breaks are a wide-layout nicety; on narrow screens the text simply flows.
    const raw = loc(e.title, lang);
    const title = wrap(compact ? raw.replace(/\n/g, ' ') : raw, W - 30, tSize, true);
    const meta = wrapSegments([loc(e.kind, lang), loc(e.detail, lang)], W - 30, compact ? 11.5 : 12);
    const top = y + (i > 0 ? 22 : 8);
    const base = top + 22;
    const metaY = base + (title.length - 1) * 22 + 24;
    if (i > 0) parts.push(hline(30, W, y + 0.5, c.rule));
    // ongoing = green dot (a small point of attention); completed = quiet grey dot
    parts.push(`<circle cx="4" cy="${base - 5.5}" r="3.5" fill="${e.ongoing ? c.green : c.muted}"/>`);
    title.forEach((l, k) => parts.push(t(30, base + k * 22, l, { size: tSize, fillColor: c.text, weight: 600 })));
    meta.forEach((l, k) => parts.push(t(30, metaY + k * 17, l, { size: compact ? 11.5 : 12, fillColor: c.muted, mono: true })));
    y = metaY + (meta.length - 1) * 17 + 18;
    textOut.push(`${loc(e.title, lang).replace(/\n/g, ' ')}. ${loc(e.kind, lang)} · ${loc(e.detail, lang)}`);
  });
  const alt = sentences(textOut);
  return { alt, svg: svg(W, y, cfg.i18n[lang].sections.education, alt, parts.join('\n')) };
}

function yearChart(lang, c, d, v) {
  const L = cfg.i18n[lang].chart;
  const { W, compact } = v;
  const weeks = d.weeks;
  const n = weeks.length;
  const max = Math.max(0, ...weeks);
  const slot = W / n;
  const bw = Math.max(3, slot * 0.62);
  const AREA = compact ? 72 : 88;
  const base = 8 + AREA;
  const body = [];

  weeks.forEach((val, i) => {
    const x = (i * slot + (slot - bw) / 2).toFixed(2);
    body.push(`<rect x="${x}" y="${base + 2}" width="${bw.toFixed(2)}" height="1.5" fill="${c.rule}"/>`);
    if (val > 0) {
      const ratio = val / max;
      const h = Math.max(6, Math.round(ratio * AREA));
      body.push(
        `<rect x="${x}" y="${base - h}" width="${bw.toFixed(2)}" height="${h}" rx="1" fill="${c.green}" fill-opacity="${(0.38 + 0.62 * ratio).toFixed(2)}"/>`,
      );
    }
  });

  const segs =
    d.contributions > 0
      ? [plural(L.contributions, d.contributions), d.commits != null ? plural(L.commits, d.commits) : null, fill(L.busiest, { n: max })].filter(Boolean)
      : [L.none];
  const size = compact ? 11.5 : 12;
  const capLines = wrapSegments(segs, W, size);
  capLines.forEach((l, i) => body.push(t(0, base + 30 + i * 18, l, { size, fillColor: c.muted, mono: true })));

  const alt = sentences([segs.join(' · '), L.alt]);
  const H = base + 30 + (capLines.length - 1) * 18 + 14;
  return { alt, svg: svg(W, H, cfg.i18n[lang].sections.year, alt, body.join('\n')) };
}

// Contact links are small images at natural size (not scaled with the page), wrapped in real
// HTML links by the README. Adding a channel in profile.config.json adds one more of these.
function contactLink(lang, link, c) {
  const label = loc(link.label, lang);
  const textW = tw(label, 15, true);
  const W = Math.ceil(textW * 1.04 + 8 + 10 + 28);
  const body = [
    t(0, 20, label, { size: 15, fillColor: c.text, weight: 600 }),
    arrow(Math.round(textW * 1.04 + 8 + 5), 14, c.muted),
  ].join('\n');
  const alt = loc(link.alt, lang) || label;
  return { alt, width: W, svg: svg(W, 30, label, alt, body) };
}

/* ───────────────────────── README ───────────────────────── */

// Wide layout by default: narrow+dark, narrow+light, wide+dark, and the light wide <img> as fallback.
function picture(name, alt, { responsive = true, width = '100%' } = {}) {
  const p = `assets/generated/${name}`;
  const narrow = responsive
    ? `  <source media="(max-width: ${NARROW_MAX}px) and (prefers-color-scheme: dark)" srcset="${p}-dark-m.svg">
  <source media="(max-width: ${NARROW_MAX}px)" srcset="${p}-light-m.svg">
`
    : '';
  return `<picture>
${narrow}  <source media="(prefers-color-scheme: dark)" srcset="${p}-dark.svg">
  <img src="${p}-light.svg" alt="${esc(alt)}" width="${width}">
</picture>`;
}

const link = (href, inner) => `<a href="${esc(href)}">\n${inner}\n</a>`;

function readme(lang, parts) {
  const switcher = lang === 'en' ? '<b>EN</b> · <a href="README.es.md">ES</a>' : '<a href="README.md">EN</a> · <b>ES</b>';
  const out = [
    '<!-- Generated by scripts/build.mjs. Edit profile.config.json, not this file. -->',
    `<p align="right">${switcher}</p>`,
    picture(`header-${lang}`, parts.header.alt),
    picture(`stats-${lang}`, parts.stats.alt),
  ];
  const heading = (key) => `<h3>\n${picture(`section-${key}-${lang}`, parts.sections[key].alt)}\n</h3>`;

  for (const key of parts.order) {
    out.push(heading(key));
    if (key === 'work') {
      parts.projects.forEach((p, i) => out.push(link(`https://github.com/${p.cfg.repo}`, picture(`project-${i + 1}-${lang}`, p.alt))));
    } else if (key === 'skills') {
      out.push(picture(`skills-${lang}`, parts.skills.alt));
    } else if (key === 'education') {
      out.push(picture(`education-${lang}`, parts.education.alt));
    } else if (key === 'year') {
      out.push(picture(`year-${lang}`, parts.year.alt));
    } else if (key === 'connect') {
      out.push(parts.contacts.map((k) => link(k.href, picture(`connect-${k.id}-${lang}`, k.alt, { responsive: false, width: k.width }))).join('\n'));
    }
  }
  return out.join('\n\n') + '\n';
}

/* ───────────────────────── self-check ───────────────────────── */

// Runs before anything is written. A broken output must never replace a good one.
function validateOutputs(files, readmes) {
  const errs = [];
  for (const [name, content] of files) {
    if (!content.startsWith('<svg') || !content.trimEnd().endsWith('</svg>')) errs.push(`${name}: not a complete SVG`);
    if (/NaN|undefined|\[object/.test(content)) errs.push(`${name}: contains NaN/undefined`);
  }
  for (const [name, md] of Object.entries(readmes)) {
    const imgs = md.match(/<img\b[^>]*>/g) || [];
    for (const im of imgs) if (!/\balt="[^"]+"/.test(im)) errs.push(`${name}: <img> without alt text`);
    for (const m of md.matchAll(/(?:srcset|src)="assets\/generated\/([^"]+)"/g)) if (!files.has(m[1])) errs.push(`${name}: references missing asset ${m[1]}`);
    for (const m of md.matchAll(/href="([^"]*)"/g)) if (!/^(https:\/\/|mailto:|README(\.es)?\.md$)/.test(m[1])) errs.push(`${name}: unexpected link target "${m[1]}"`);
    if (!md.includes('<p align="right">')) errs.push(`${name}: language switcher missing`);
  }
  if (errs.length) throw new BuildError(`Generated output failed validation:\n  - ${errs.join('\n  - ')}`, 'Nothing was written. This is a bug in the generator or the config.');
}

/* ───────────────────────── main ───────────────────────── */

async function main() {
  if (SAMPLE && process.env.GITHUB_ACTIONS === 'true') {
    throw new BuildError('--sample must never run in CI.', 'Sample data would replace the real statistics.');
  }
  validateConfig();

  const data = SAMPLE ? loadSample() : await loadLive();
  if (!SAMPLE) console.log(`GitHub data ok: ${data.repos} public repos, ${data.contributions} contributions.`);

  // Projects are checked against the public-repository list: renamed, deleted or private repos
  // are skipped with a warning instead of breaking the build (or leaking anything).
  const publicSet = new Set(data.publicRepos.map((r) => r.toLowerCase()));
  const projects = (cfg.projects || []).filter((p) => {
    const ok = publicSet.has(p.repo.toLowerCase());
    if (!ok) warn(`Project "${p.repo}" is not among your public repositories (renamed, private or deleted?). It was skipped; update "projects" in profile.config.json.`);
    return ok;
  });

  const icons = {};
  if (cfg.skills?.icons) {
    const refs = new Set((cfg.skills.groups || []).flatMap((g) => g.items.map((i) => i.icon).filter(Boolean)));
    for (const ref of refs) {
      icons[ref] = await loadIcon(ref);
      if (!icons[ref]) warn(`Icon "${ref}" is not available; a neutral dot is used instead.`);
    }
  }

  const contacts = (cfg.contact || []).filter((k) => k.enabled);
  const order = [
    projects.length && 'work',
    cfg.skills?.groups?.length && 'skills',
    cfg.education?.length && 'education',
    'year',
    contacts.length && 'connect',
  ].filter(Boolean);

  const files = new Map();
  const readmes = {};

  for (const lang of LANGS) {
    const L = cfg.i18n[lang];
    const parts = { order, sections: {}, projects: [], contacts: [] };
    for (const [theme, c] of Object.entries(THEMES)) {
      for (const v of Object.values(VIEWS)) {
        const put = (name, svgText) => files.set(`${name}-${lang}-${theme}${v.suffix}.svg`, svgText);
        const pieces = {
          header: header(lang, c, data, v),
          stats: stats(lang, c, data, v),
          year: yearChart(lang, c, data, v),
        };
        put('header', pieces.header.svg);
        put('stats', pieces.stats.svg);
        put('year', pieces.year.svg);
        Object.assign(parts, pieces);

        if (order.includes('skills')) {
          parts.skills = skills(lang, c, icons, v);
          put('skills', parts.skills.svg);
        }
        if (order.includes('education')) {
          parts.education = education(lang, c, v);
          put('education', parts.education.svg);
        }
        order.forEach((key, i) => {
          const sec = section(i + 1, L.sections[key], c, v);
          put(`section-${key}`, sec.svg);
          parts.sections[key] = sec;
        });
        projects.forEach((p, i) => {
          const pr = project(lang, p, i, c, v);
          put(`project-${i + 1}`, pr.svg);
          parts.projects[i] = { ...pr, cfg: p };
        });
      }
      // Contact links are not responsive: one natural-size SVG per theme.
      contacts.forEach((k, i) => {
        const cl = contactLink(lang, k, c);
        files.set(`connect-${k.id}-${lang}-${theme}.svg`, cl.svg);
        parts.contacts[i] = { id: k.id, href: k.href, alt: cl.alt, width: cl.width };
      });
    }
    readmes[lang === 'en' ? 'README.md' : 'README.es.md'] = readme(lang, parts);
  }

  validateOutputs(files, readmes);

  // Everything is valid: now (and only now) touch the disk.
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, content] of files) fs.writeFileSync(path.join(OUT, name), content);
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.svg') && !files.has(f)) fs.unlinkSync(path.join(OUT, f)); // obsolete generated assets only
  for (const [name, content] of Object.entries(readmes)) fs.writeFileSync(path.join(ROOT, name), content);

  console.log(
    `${SAMPLE ? 'sample' : 'live'} build ok: ${files.size} SVG, 2 READMEs · sections: ${order.join(', ')} · ${data.repos} repos, ${data.stars} stars, ${data.followers} followers, ${data.contributions} contributions`,
  );
}

try {
  await main();
} catch (err) {
  console.error(`\n✖ ${err.message}`);
  if (err.hint) console.error(`  ${err.hint}`);
  if (!(err instanceof BuildError)) console.error(err.stack);
  console.error('  Existing files were left untouched.');
  process.exit(1);
}
