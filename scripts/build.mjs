#!/usr/bin/env node
// Generates README.md (EN), README.es.md (ES) and the SVG assets in assets/generated/
// from profile.config.json + live GitHub data.
//
//   node scripts/build.mjs            live data (needs GITHUB_TOKEN; the Action provides it)
//   node scripts/build.mjs --sample   offline preview from scripts/sample-data.json
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
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.config.json'), 'utf8'));
const LANGS = ['en', 'es'];

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
const loc = (v, lang) => (typeof v === 'string' ? v : v[lang]);
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
const plural = (o, n) => fill(n === 1 ? o.one : o.other, { n });
const nf = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const num = (n) => (n < 1000 ? String(n) : nf.format(n).toLowerCase());

// Estimated text width (px) — only used for wrapping and for starting rules after titles.
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

// Real fonts differ from the Arial metrics used for estimates (Inter ≈ +8%, SF ≈ +5%, DejaVu ≈ +19%).
// Wrapping keeps a safety margin so text is never clipped at the right edge of an SVG.
const SAFETY = 1.12;

function wrap(text, maxW, size, bold = false) {
  const lines = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (!cur || tw(next, size, bold) * SAFETY <= maxW) cur = next;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
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

function svg(v, H, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${v.W}" height="${H}" viewBox="0 0 ${v.W} ${H}" fill="none" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<style>.s{font-family:${SANS}}.m{font-family:${MONO}}</style>
${body}
</svg>
`;
}

const hline = (x1, x2, y, color) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${color}" stroke-width="1"/>`;

function starPath(cx, cy, R = 5.5, r = 2.3) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rad = i % 2 ? r : R;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

/* ───────────────────────── data ───────────────────────── */

async function gql(query, variables = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set. Use --sample for an offline preview.');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-readme-builder' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

const sumWeeks = (weeks) => weeks.map((w) => w.contributionDays.reduce((s, d) => s + d.contributionCount, 0));

async function loadLive() {
  const login = process.env.PROFILE_USER || cfg.username;
  const aliases = cfg.projects
    .map((p, i) => {
      if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo)) throw new Error(`Invalid repo in config: ${p.repo}`);
      const [owner, name] = p.repo.split('/');
      return `p${i}: repository(owner: "${owner}", name: "${name}") { stargazerCount }`;
    })
    .join('\n');

  const data = await gql(
    `query($login: String!) {
      user(login: $login) {
        createdAt
        avatarUrl(size: 208)
        followers { totalCount }
        repositories(ownerAffiliations: OWNER, privacy: PUBLIC, first: 100) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { stargazerCount isFork }
        }
        contributionsCollection {
          totalCommitContributions
          contributionCalendar { totalContributions weeks { contributionDays { contributionCount } } }
        }
      }
      ${aliases}
    }`,
    { login },
  );
  const u = data.user;
  if (!u) throw new Error(`User ${login} not found`);

  // Stars on your own (non-fork) public repositories, paginated.
  let repos = u.repositories;
  let stars = 0;
  for (;;) {
    stars += repos.nodes.filter((r) => !r.isFork).reduce((s, r) => s + r.stargazerCount, 0);
    if (!repos.pageInfo.hasNextPage) break;
    const more = await gql(
      `query($login: String!, $after: String) {
        user(login: $login) { repositories(ownerAffiliations: OWNER, privacy: PUBLIC, first: 100, after: $after) {
          pageInfo { hasNextPage endCursor } nodes { stargazerCount isFork } } }
      }`,
      { login, after: repos.pageInfo.endCursor },
    );
    repos = more.user.repositories;
  }

  const projectStars = {};
  cfg.projects.forEach((p, i) => {
    projectStars[p.repo] = data[`p${i}`] ? data[`p${i}`].stargazerCount : null;
  });

  const av = await fetch(u.avatarUrl);
  if (!av.ok) throw new Error(`Avatar download failed (${av.status})`);
  const mime = (av.headers.get('content-type') || 'image/png').split(';')[0];
  const b64 = Buffer.from(await av.arrayBuffer()).toString('base64');

  const cal = u.contributionsCollection.contributionCalendar;
  return {
    since: new Date(u.createdAt).getUTCFullYear(),
    repos: u.repositories.totalCount,
    stars,
    followers: u.followers.totalCount,
    commits: u.contributionsCollection.totalCommitContributions,
    contributions: cal.totalContributions,
    weeks: sumWeeks(cal.weeks),
    projectStars,
    avatar: { mime, b64 },
  };
}

function loadSample() {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'sample-data.json'), 'utf8'));
  const jpg = fs.readFileSync(path.join(ROOT, 'assets', 'avatar-placeholder.jpg'));
  return {
    since: new Date(s.createdAt).getUTCFullYear(),
    repos: s.repos,
    stars: s.stars,
    followers: s.followers,
    commits: s.commits,
    contributions: s.weeklyTotals.reduce((a, b) => a + b, 0),
    weeks: s.weeklyTotals,
    projectStars: s.projectStars,
    avatar: { mime: 'image/jpeg', b64: jpg.toString('base64') },
  };
}

// Optional monochrome icons (Simple Icons, CC0). Cached in assets/icons/ so builds stay reproducible.
async function loadIcon(slug) {
  if (!/^[a-z0-9]+$/.test(slug)) return null;
  const file = path.join(ICON_DIR, `${slug}.svg`);
  if (!fs.existsSync(file) && !SAMPLE) {
    try {
      const r = await fetch(`https://cdn.jsdelivr.net/npm/simple-icons@13/icons/${slug}.svg`);
      if (r.ok) {
        fs.mkdirSync(ICON_DIR, { recursive: true });
        fs.writeFileSync(file, await r.text());
      }
    } catch {
      /* falls through to text-only */
    }
  }
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, 'utf8').match(/<path[^>]*\sd="([^"]+)"/);
  return m ? m[1] : null;
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
  return { alt, svg: svg(v, H, cfg.displayName, alt, parts.join('\n')) };
}

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
    const rowH = 74;
    cols.forEach(([n, label], i) => {
      const x = xs[i % 2];
      const row = Math.floor(i / 2);
      parts.push(t(x, 46 + row * rowH, num(n), { size: 28, fillColor: c.text, weight: 600 }));
      parts.push(t(x, 66 + row * rowH, label, { size: 12, fillColor: c.muted, mono: true }));
    });
    H = 66 + rowH + 14;
  } else {
    const xs = [0, 140, 280, 420];
    cols.forEach(([n, label], i) => {
      parts.push(t(xs[i], 48, num(n), { size: 30, fillColor: c.text, weight: 600 }));
      parts.push(t(xs[i], 70, label, { size: 12, fillColor: c.muted, mono: true }));
    });
    H = 88;
  }
  return { alt, svg: svg(v, H, 'GitHub', alt, parts.join('\n')) };
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
  return { alt, svg: svg(v, 30, title, alt, body) };
}

function project(lang, p, index, stars, c, v) {
  const L = cfg.i18n[lang];
  const { W, compact } = v;
  const desc = loc(p.description, lang);
  const dSize = compact ? 14 : 14.5;
  const dStep = compact ? 20 : 21;
  const lines = wrap(desc, W - 30 - (compact ? 4 : 20), dSize);
  const techLines = p.tech && p.tech.length ? wrapSegments(p.tech, W - 30, compact ? 11.5 : 12) : [];
  const top = index > 0 ? 22 : 8;
  const nameY = top + 24;
  const descY = nameY + 28;
  const techY = descY + (lines.length - 1) * dStep + 26;
  const H = (techLines.length ? techY + (techLines.length - 1) * 17 : descY + (lines.length - 1) * dStep) + 20;
  const starsTxt = String(stars);
  const starsX = W - mw(starsTxt, 12.5) - 15;
  const body = [
    index > 0 ? hline(30, W, 0.5, c.rule) : '',
    t(0, nameY - 1, String(index + 1).padStart(2, '0'), { size: 12.5, fillColor: c.muted, mono: true }),
    t(30, nameY, p.name, { size: 22, fillColor: c.text, weight: 600, ls: -0.3 }),
    `<path d="${starPath(starsX + 5.5, nameY - 5.5)}" fill="${c.muted}"/>`,
    t(W, nameY - 1, starsTxt, { size: 12.5, fillColor: c.muted, mono: true, anchor: 'end' }),
    ...lines.map((l, i) => t(30, descY + i * dStep, l, { size: dSize, fillColor: c.soft })),
    ...techLines.map((l, i) => t(30, techY + i * 17, l, { size: compact ? 11.5 : 12, fillColor: c.muted, mono: true })),
  ]
    .filter(Boolean)
    .join('\n');
  const alt = sentences([`${String(index + 1).padStart(2, '0')} ${p.name}`, desc, (p.tech || []).join(' · '), `${stars} ${L.starsAlt}`]);
  return { alt, svg: svg(v, H, p.name, alt, body) };
}

function skills(lang, c, icons, v) {
  const useIcons = cfg.skills.icons;
  const { W, compact } = v;
  const cols = compact ? 2 : 3;
  const x0 = compact ? 0 : 150;
  const colW = (W - x0) / cols;
  const ROW = 28;
  let y = 0;
  const parts = [];
  const textOut = [];

  cfg.skills.groups.forEach((g, gi) => {
    const top = y;
    const glabel = loc(g.label, lang);
    const rows = Math.ceil(g.items.length / cols);
    const labelBase = top + 29;
    const firstBase = compact ? labelBase + 26 : labelBase;
    if (gi > 0) parts.push(hline(0, W, top + 0.5, c.rule));
    parts.push(t(0, labelBase, glabel, { size: 12.5, fillColor: c.muted, mono: true }));

    g.items.forEach((it, k) => {
      const name = loc(it.name, lang);
      const note = it.note ? loc(it.note, lang) : '';
      let x = x0 + (k % cols) * colW;
      const by = firstBase + Math.floor(k / cols) * ROW;
      if (useIcons) {
        const d = it.icon ? icons[it.icon] : null;
        parts.push(
          d
            ? `<path transform="translate(${x} ${by - 13}) scale(0.667)" d="${d}" fill="${c.muted}"/>`
            : `<circle cx="${x + 8}" cy="${by - 5}" r="2" fill="${c.muted}"/>`,
        );
        x += 24;
      }
      parts.push(t(x, by, name, { size: 15, fillColor: c.text }));
      if (note) parts.push(t(x + tw(name, 15) + 8, by, note, { size: 11.5, fillColor: c.muted, mono: true }));
    });

    y = firstBase + (rows - 1) * ROW + 24;
    textOut.push(`${glabel}: ${g.items.map((i) => loc(i.name, lang) + (i.note ? ` (${loc(i.note, lang)})` : '')).join(', ')}`);
  });

  const alt = sentences(textOut);
  return { alt, svg: svg(v, y, cfg.i18n[lang].sections.skills, alt, parts.join('\n')) };
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
  return { alt, svg: svg(v, H, cfg.i18n[lang].sections.year, alt, body.join('\n')) };
}

/* ───────────────────────── README ───────────────────────── */

// Four sources: narrow+dark, narrow+light, wide+dark, and the light wide <img> as the fallback.
function picture(name, alt) {
  const p = `assets/generated/${name}`;
  return `<picture>
  <source media="(max-width: ${NARROW_MAX}px) and (prefers-color-scheme: dark)" srcset="${p}-dark-m.svg">
  <source media="(max-width: ${NARROW_MAX}px)" srcset="${p}-light-m.svg">
  <source media="(prefers-color-scheme: dark)" srcset="${p}-dark.svg">
  <img src="${p}-light.svg" alt="${esc(alt)}" width="100%">
</picture>`;
}

function readme(lang, parts) {
  const L = cfg.i18n[lang];
  const switcher = lang === 'en' ? '<b>EN</b> · <a href="README.es.md">ES</a>' : '<a href="README.md">EN</a> · <b>ES</b>';
  const out = [];
  out.push('<!-- Generated by scripts/build.mjs. Edit profile.config.json, not this file. -->');
  out.push(`<p align="right">${switcher}</p>`);
  out.push(picture(`header-${lang}`, parts.header.alt));
  out.push(picture(`stats-${lang}`, parts.stats.alt));

  const heading = (key) => `<h3>\n${picture(`section-${key}-${lang}`, parts.sections[key].alt)}\n</h3>`;

  out.push(heading('work'));
  parts.projects.forEach((p, i) => {
    out.push(picture(`project-${i + 1}-${lang}`, p.alt));
    const links = [`[${L.projectLinks.repo}](https://github.com/${p.cfg.repo})`];
    if (p.cfg.demo) links.push(`[${L.projectLinks.demo}](${p.cfg.demo})`);
    out.push(links.join(' · '));
  });

  out.push(heading('skills'));
  out.push(picture(`skills-${lang}`, parts.skills.alt));

  out.push(heading('year'));
  out.push(picture(`year-${lang}`, parts.year.alt));

  out.push(heading('connect'));
  const gh = cfg.links.github;
  out.push(
    [
      `**${L.connect.github}** · [${gh.replace('https://', '')}](${gh})`,
      `**${L.connect.email}** · [${cfg.links.email}](mailto:${cfg.links.email})`,
    ].join('  \n'),
  );
  return out.join('\n\n') + '\n';
}

/* ───────────────────────── main ───────────────────────── */

const data = SAMPLE ? loadSample() : await loadLive();

const projects = cfg.projects.filter((p) => {
  const ok = data.projectStars[p.repo] != null;
  if (!ok) console.warn(`! ${p.repo} is not reachable (private or missing): skipped.`);
  return ok;
});

const icons = {};
if (cfg.skills.icons) {
  const slugs = new Set(cfg.skills.groups.flatMap((g) => g.items.map((i) => i.icon).filter(Boolean)));
  for (const s of slugs) {
    icons[s] = await loadIcon(s);
    if (!icons[s]) console.warn(`! No icon for "${s}": a neutral dot is used instead.`);
  }
}

const files = new Map();
const sectionKeys = ['work', 'skills', 'year', 'connect'];

for (const lang of LANGS) {
  const L = cfg.i18n[lang];
  const parts = { sections: {}, projects: [] };
  for (const [theme, c] of Object.entries(THEMES)) {
    for (const v of Object.values(VIEWS)) {
      const put = (name, out) => files.set(`${name}-${lang}-${theme}${v.suffix}.svg`, out.svg);
      const h = header(lang, c, data, v);
      const s = stats(lang, c, data, v);
      const sk = skills(lang, c, icons, v);
      const y = yearChart(lang, c, data, v);
      put('header', h);
      put('stats', s);
      put('skills', sk);
      put('year', y);
      sectionKeys.forEach((key, i) => {
        const sec = section(i + 1, L.sections[key], c, v);
        put(`section-${key}`, sec);
        parts.sections[key] = sec;
      });
      projects.forEach((p, i) => {
        const pr = project(lang, p, i, data.projectStars[p.repo], c, v);
        put(`project-${i + 1}`, pr);
        parts.projects[i] = { ...pr, cfg: p };
      });
      Object.assign(parts, { header: h, stats: s, skills: sk, year: y });
    }
  }
  fs.writeFileSync(path.join(ROOT, lang === 'en' ? 'README.md' : 'README.es.md'), readme(lang, parts));
}

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.svg')) fs.unlinkSync(path.join(OUT, f)); // drop stale assets
for (const [name, content] of files) fs.writeFileSync(path.join(OUT, name), content);

console.log(
  `${SAMPLE ? 'sample' : 'live'} build ok: ${files.size} SVG, 2 READMEs · ${data.repos} repos, ${data.stars} stars, ${data.followers} followers, ${data.contributions} contributions`,
);
