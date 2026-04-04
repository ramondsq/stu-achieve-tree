# Repository Guidelines

## Project Structure & Module Organization
`cloudfunctions/api/` is the active backend and should hold all privileged business logic, database access, and storage integration. `miniprogram/` contains the WeChat Mini Program client. `public/` contains the static teacher and student web pages deployed to CloudBase Static Hosting. `server.js` is a legacy Express entry point kept for local reference and smoke checks, not the production deployment path. Historical migration artifacts remain in `functions/api/` and `scripts/`; avoid extending them unless you are working on legacy compatibility.

## Build, Test, and Development Commands
`npm install` installs the root Node dependencies.

`npm run dev` starts `server.js` on port `3000` for local smoke testing of the legacy flow.

`npm --prefix cloudfunctions/api install` installs the Cloud Function dependency locally. For real Mini Program testing, import `miniprogram/` into WeChat DevTools and run the Cloud Function dependency install/upload flow there.

There is no build step at present: `public/` is plain static HTML/CSS/JS, and the Mini Program is run directly in WeChat DevTools.

## Coding Style & Naming Conventions
Follow the existing JavaScript style: 2-space indentation, semicolons, and single quotes. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants, and lowercase REST-style paths such as `/api/student/login`. Keep CloudBase collection names and storage prefixes consistent with the existing `achv_*` and `student-code` patterns. No formatter or linter is configured, so keep changes small and visually consistent with nearby code.

## Testing Guidelines
No automated test suite is committed yet. Validate backend changes with `npm run dev` when possible, then verify the actual CloudBase flow through the teacher page, student page, and Mini Program. If you add tests, prefer `*.test.js` naming and place them near the changed module or under a new top-level `tests/` directory.

## Commit & Pull Request Guidelines
Recent history uses concise conventional prefixes such as `feat:`, `fix:`, and `checkpoint:`. Keep commit subjects short and imperative. Pull requests should state which surface changed (`cloudfunctions/api`, `public`, or `miniprogram`), list any environment or collection changes, include manual verification steps, and attach screenshots for UI changes.

## Security & Configuration Tips
Use `.env.example` as the template for local secrets and never commit `.env` files. Keep secrets, publishable keys, and environment IDs out of client-side code unless they are intentionally public. New privileged operations should stay in `cloudfunctions/api`, not in `public/` or `miniprogram/`.
