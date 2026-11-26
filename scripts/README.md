# Profile build

`README.md` (EN), `README.es.md` (ES) and everything in `assets/generated/` are **generated**.
Edit `profile.config.json`, never those files: the next build overwrites them.

## Preview locally

```bash
node scripts/build.mjs --sample        # offline, uses scripts/sample-data.json (never in CI)
GITHUB_TOKEN=… node scripts/build.mjs  # live data, same as the Action
node --test scripts/test/build.test.mjs   # generator tests (no network needed)
```

Node 18+, no dependencies. Open `README.md` in any Markdown previewer that renders HTML, or push
to a branch and view it on GitHub.

## Add a project
Append to `projects` in `profile.config.json`:

```json
{
  "repo": "ArnauAlemanyDev/Name",
  "name": "Name",
  "demo": "https://…",
  "tech": ["React", "Vite"],
  "description": { "en": "One short sentence.", "es": "Una frase corta." }
}
```

The whole entry links to the repository. `demo` is stored for later but not shown. A repo that is
renamed, deleted or private is **skipped with a warning** (visible in the Action run), never a failure,
and private repositories can never appear: only your public repositories are accepted.

## Add a technology
Add `{ "name": "Go", "icon": "go" }` to a group in `skills.groups` (or add a group). Optional
`"note": { "en": "basic", "es": "básico" }` for an honest level qualifier. No levels are drawn.

Icons are local files in `assets/icons/` (see `LICENSES.md` there):
- `"react"` → `assets/icons/simple/react.svg` (Simple Icons). If the file is missing, the build
  downloads it once and caches it; commit it with the next run.
- `"mdi:database"` → `assets/icons/mdi/database.svg` (Material Design Icons, for things with no
  brand logo). Copy the SVG there.
- No `icon` or a missing file → a small neutral dot. Set `skills.icons` to `false` to hide icons.

## Edit education
`education` in `profile.config.json`. `"ongoing": true` draws the green dot. `detail` is a string
(`"2026"`) or `{ "en": …, "es": … }`. Use `\n` in a title to force a line break.

## Add a contact link
`contact` already has disabled placeholders for LinkedIn and Portfolio. Fill `href` and set
`"enabled": true`; they appear in both READMEs. Only enabled entries are shown.

## Sections
Order: Selected work, Technical expertise, Education, The year in contributions, Connect.
Numbers are assigned automatically; a section with no content is omitted and the rest renumber.

## How it updates
`.github/workflows/profile.yml` runs daily, on manual dispatch, and when the config, scripts or
icons change. It commits only when output changed, as `github-actions[bot]` (not counted as your
contributions).

## If something fails
The build generates and validates everything in memory first. On any error (API outage, rate
limit, invalid config) it prints a clear message, exits with an error and **writes nothing**, so
the last valid README and SVGs stay in place. Sample data is never used as a fallback.
