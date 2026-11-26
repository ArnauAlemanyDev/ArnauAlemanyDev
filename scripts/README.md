# Profile build

`README.md` (EN), `README.es.md` (ES) and everything in `assets/generated/` are **generated**.
Edit `profile.config.json`, never those files.

```bash
node scripts/build.mjs --sample     # offline preview (fixture data, placeholder avatar)
GITHUB_TOKEN=… node scripts/build.mjs   # live data, same as the Action
```

Node 18+, no dependencies.

## Add a project
Append an entry to `projects` in `profile.config.json` (`repo`, `name`, `tech`, `demo` optional,
`description.en` / `description.es`). A repo that is private or missing is skipped with a warning,
so you can list it before publishing it.

## Add a skill
Add `{ "name": "…" }` to a group in `skills.groups`. Use `"note": { "en": "basic", "es": "básico" }`
for an honest level qualifier. Groups are free: add a "Security" group when it applies.

## Icons (optional)
Set `skills.icons` to `true`. On the next live build, monochrome Simple Icons (CC0) are downloaded
for each `icon` slug and cached in `assets/icons/`. Items without an icon get a neutral dot.

## How it updates
`.github/workflows/profile.yml` runs daily, on manual dispatch, and whenever the config or scripts
change. It commits only when output changed, as `github-actions[bot]` (not counted as your contributions).
