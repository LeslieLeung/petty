# Repository Guidelines

## Project Structure & Module Organization

Petty is a Tauri 2 desktop pet app with a Vite/TypeScript frontend and a Rust host shell. Frontend entry points live in `src/main.ts` and `src/settings.ts`, with styling in `src/styles.css` and `src/settings.css`. Runtime behavior is grouped under `src/pet-runtime/`: `behavior/`, `render/`, `resource/`, `state/`, and `surface/`. Built-in pet definitions and sprites are stored in `resources/<pet-id>/`, for example `resources/hana/pet.json` and `spritesheet.webp`. Tauri host code and platform integrations live in `src-tauri/src/`; generated schemas and icons remain under `src-tauri/gen/` and `src-tauri/icons/`. Product and architecture notes are in `docs/`.

## Build, Test, and Development Commands

- `npm run dev`: start the Vite dev server on `127.0.0.1`.
- `npm run tauri:dev`: run the desktop app against the dev server.
- `npm run tauri:dev-console`: run Tauri with `PETTY_DEVTOOLS=1` for debugging.
- `npm run build`: type-check with `tsc` and produce the web build in `dist/`.
- `npm run tauri:build`: sync versions, then build the native Tauri app.
- `npm run package:mac` / `npm run package:windows`: run the custom packaging script.

Rust-only checks can be run from `src-tauri/` with `cargo test` when host-side tests are added.

## Coding Style & Naming Conventions

Use TypeScript modules with two-space indentation, single quotes, and no semicolons, matching existing `src/` files. Prefer explicit types for public interfaces, Tauri command payloads, and runtime manifests. Use `PascalCase` for classes and interfaces, `camelCase` for functions and variables, and kebab-case for asset folders such as `resources/my-pet/`. Rust code follows `rustfmt` and snake_case functions; serialize Tauri payloads with `#[serde(rename_all = "camelCase")]`.

## Testing Guidelines

There is no dedicated test suite yet. For now, verify changes with `npm run build` and, when behavior is user-visible, `npm run tauri:dev`. Add future frontend tests near covered code using `*.test.ts`, and keep Rust unit tests in the relevant `src-tauri/src/*.rs` module. For pet assets, validate that `pet.json` states match spritesheet clips before packaging.

## Commit & Pull Request Guidelines

Git history currently uses concise Conventional Commit-style messages, for example `feat: keep physical size`. Continue with `type: summary` (`feat`, `fix`, `docs`, `chore`, `refactor`) in imperative mood. Pull requests should include a short description, commands run, platform tested, linked issue if applicable, and screenshots or recordings for UI, pet behavior, or packaging changes.

## Security & Configuration Tips

Do not commit generated local app data, private signing material, or machine-specific build outputs. Keep Tauri capability changes in `src-tauri/capabilities/default.json` minimal and explain why any new permission is required.
