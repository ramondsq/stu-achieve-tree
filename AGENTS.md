# Repository Guidelines

## Project Structure & Module Organization
`cloudfunctions/api/` is the active backend and should hold all privileged business logic, database access, and storage integration. `miniprogram/` contains the WeChat Mini Program client. `public/` contains the static teacher and student web pages and is uploaded directly to CloudBase Static Hosting. The repository root `project.config.json` is the canonical WeChat DevTools entry and maps `miniprogram/` plus `cloudfunctions/` together. Root-level legacy Express and alternate deployment artifacts have been removed, so new work should stay on the CloudBase path only.

## Build, Test, and Development Commands
`npm --prefix cloudfunctions/api install` installs the Cloud Function dependency locally. For real Mini Program testing, import the repository root into WeChat DevTools so `miniprogramRoot` and `cloudfunctionRoot` stay in sync.

There is no build step at present: `public/` is plain static HTML/CSS/JS and can be uploaded directly to CloudBase Static Hosting, and the Mini Program is run directly in WeChat DevTools.

## Coding Style & Naming Conventions
Follow the existing JavaScript style: 2-space indentation, semicolons, and single quotes. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants, and lowercase REST-style paths such as `/api/student/login`. Keep CloudBase collection names and storage prefixes consistent with the existing `achv_*` and `student-code` patterns. No formatter or linter is configured, so keep changes small and visually consistent with nearby code.

## Testing Guidelines
No automated test suite is committed yet. Validate changes through the actual CloudBase flow in the teacher page, student page, and Mini Program. If you add tests, prefer `*.test.js` naming and place them near the changed module or under a new top-level `tests/` directory.

## Commit & Pull Request Guidelines
Recent history uses concise conventional prefixes such as `feat:`, `fix:`, and `checkpoint:`. Keep commit subjects short and imperative. Pull requests should state which surface changed (`cloudfunctions/api`, `public`, or `miniprogram`), list any environment or collection changes, include manual verification steps, and attach screenshots for UI changes.

## Security & Configuration Tips
Use `.env.example` as the template for Cloud Function secrets and never commit `.env` files. Keep WeChat DevTools private config files local-only, and keep secrets, publishable keys, and environment IDs out of client-side code unless they are intentionally public. When switching CloudBase environments, update `cloudbaserc.json`, `public/cloudbase-config.js`, `miniprogram/app.js`, and the environment summary in `README.md` together. New privileged operations should stay in `cloudfunctions/api`, not in `public/` or `miniprogram/`.
