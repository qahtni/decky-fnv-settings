# FNV Settings

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for changing
Fallout: New Vegas graphics settings from Game Mode on the Steam Deck, in place of the
game's launcher.

It edits `FalloutPrefs.ini` in the game's Proton prefix (Steam app 22380).

## Features

- **Presets:** the game's official Low / Medium / High / Very High preset files, plus
  **Custom (yours)**: a `Custom.ini` in the game folder with exactly the official presets'
  settings and layout, filled with your values. It's created the first time the plugin loads,
  and **Save current as Custom** updates it. Applying a preset updates every control live.
- **Presets never change resolution,** window mode, VSync or bloom, same as the launcher.
- **Settings:** resolution (common 16:10 and 16:9 sizes), anti-aliasing, anisotropic
  filtering, windowed, VSync, screen effect (None / Bloom / HDR), detail, shadows,
  water, and fade distances.
- **Preset-based sliders:** each slider's stops are the shipped presets' real values,
  from Low to Very High. Every control shows what each preset uses.
- **Safe while playing:** writes are refused while the game is running, because it
  rewrites its settings on exit. There's no polling; the check runs only when the panel
  opens and right before a write.
- **Careful with your files:** a one-time backup at `FalloutPrefs.ini.fnvsettings.bak`,
  atomic writes, and only the changed lines are touched.

## Install

Download `fnv-settings.zip` from [Releases](https://github.com/qahtni/decky-fnv-settings/releases).
In Decky, turn on **Settings → General → Developer mode**, then use
**Developer → Install Plugin from ZIP**.

In Game Mode, set the game's **Properties → General → Game Resolution** to match any
resolution above 800p.

## Development

```sh
pnpm install
pnpm run build   # dist/index.js
pnpm test        # backend (unittest) and frontend suites
```

The backend tests use copies of your real game files when present and small fixtures
otherwise. The frontend tests load the built bundle against mocked Decky globals.
