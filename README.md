# FNV Settings

Decky Loader plugin to change Fallout: New Vegas graphics settings from Game Mode,
replacing the game's launcher. Writes `FalloutPrefs.ini` in the game's Proton prefix.

- Presets: the game folder's Low / Medium / High / Very High, plus your own
  `Custom.ini` (created from your settings on first load; "Save current as Custom" updates it).
- Settings: resolution, anti-aliasing, anisotropic filtering, window mode, vsync,
  screen effect, detail, shadows, water, and fade distances.
- Refuses to write while the game is running; keeps a one-time backup at
  `FalloutPrefs.ini.fnvsettings.bak`.

Build: `pnpm install && pnpm run build`. Test: `pnpm test`.
