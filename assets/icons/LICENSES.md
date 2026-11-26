# Icon licences

Monochrome icons used in the *Technical expertise* section. They are stored locally and drawn by
`scripts/build.mjs` as a single path. Nothing is loaded from third-party servers at view time.

| Folder | Source | Licence |
|---|---|---|
| `simple/` | [Simple Icons](https://simpleicons.org) | CC0 1.0 Universal (public domain dedication) |
| `mdi/` | [Material Design Icons](https://pictogrammers.com/library/mdi/) by Pictogrammers | Apache License 2.0 |

Brand logos are trademarks of their respective owners. They appear only to identify the
technologies used, and do not imply endorsement.

Icon references in `profile.config.json`: `"react"` is `simple/react.svg`; `"mdi:database"` is
`mdi/database.svg`. If a `simple/` icon is missing the build tries to download it once from the
Simple Icons package and caches it here; add `mdi/` icons by copying the SVG from the library.
