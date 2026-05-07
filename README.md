# Petty

[中文说明](README.zh-CN.md)

Petty is a desktop pet app for playing pets that are compatible with the Codex desktop pet asset format.

The app ships with one built-in pet, Hana, and lets you import your own local pet folder from the settings window or the pet context menu.

## What It Does

- Plays animated desktop pets from a spritesheet.
- Supports the `hatch-pet` package shape: `pet.json` plus `spritesheet.webp`.
- Includes one built-in pet: `resources/hana/`.
- Lets you import custom pet folders locally.
- Lets you switch pets from the settings window.
- Supports basic interactions such as click, double click, drag, and right-click context menu.
- Provides size controls and a debug overlay toggle.

## Custom Pets

To create a custom pet package, use the Codex `hatch-pet` skill:

https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md

After generation, import the resulting folder into Petty. The folder must include:

```text
pet.json
spritesheet.webp
```

## Development

Install dependencies:

```sh
npm install
```

Run the Vite frontend:

```sh
npm run dev
```

Run the desktop app:

```sh
npm run tauri:dev
```

Run the desktop app with devtools enabled:

```sh
npm run tauri:dev-console
```

Build the web frontend:

```sh
npm run build
```

Build the native Tauri app:

```sh
npm run tauri:build
```

## Project Structure

- `src/`: TypeScript frontend.
- `src/pet-runtime/`: pet loading, rendering, state, behavior, and screen-surface runtime code.
- `src-tauri/`: Tauri host shell and platform integrations.
- `resources/`: built-in pet packages.
- `docs/`: product and technical notes.
