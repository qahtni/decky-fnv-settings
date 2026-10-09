"""FNV Settings: edit Fallout: New Vegas graphics settings from Game Mode.

Replaces the game's launcher, which can't be used on the Deck. The game reads
FalloutPrefs.ini from its Proton prefix; presets live in the game folder as
small INI files whose keys get copied into FalloutPrefs.ini, as the launcher does.
"""
import os
import re
import shutil
import tempfile

import decky

APP_ID = "22380"
PREFS_REL = ("steamapps/compatdata/" + APP_ID + "/pfx/drive_c/users/steamuser/"
             "Documents/My Games/FalloutNV/FalloutPrefs.ini")
GAME_REL = "steamapps/common/Fallout New Vegas"
BACKUP_SUFFIX = ".fnvsettings.bak"
GAME_EXE = "falloutnv.exe"

# (id, display name, file name) in dropdown order. Custom is the user's own preset.
PRESETS = [
    ("low", "Low", "low.ini"),
    ("medium", "Medium", "medium.ini"),
    ("high", "High", "high.ini"),
    ("veryhigh", "Very High", "VeryHigh.ini"),
    ("custom", "Custom (yours)", "Custom.ini"),
]
CUSTOM_ID = "custom"

RESOLUTIONS = [
    # 16:10
    (1280, 800), (1440, 900), (1680, 1050), (1920, 1200), (2560, 1600),
    # 16:9
    (1280, 720), (1366, 768), (1600, 900), (1920, 1080), (2560, 1440), (3840, 2160),
]


def _bool():
    return ("bool",)


def _choice(*vals):
    return ("choice", frozenset(vals))


def _int(lo, hi):
    return ("int", lo, hi)


def _float(lo, hi):
    return ("float", lo, hi)


# Keys the menu may write, with the values allowed for each. Anything else is rejected.
SETTABLE = {
    "Display.iSize W": _choice(*{w for w, _ in RESOLUTIONS}),
    "Display.iSize H": _choice(*{h for _, h in RESOLUTIONS}),
    "Display.iMultiSample": _choice(0, 2, 4, 8),
    "Display.iWaterMultisamples": _choice(0, 2, 4, 8),
    "Display.bTransparencyMultisampling": _bool(),
    "Display.iMaxAnisotropy": _choice(0, 2, 4, 8, 15),
    "Display.bFull Screen": _bool(),
    "Display.iPresentInterval": _bool(),
    "Display.iTexMipMapSkip": _choice(0, 1, 2),
    "Display.iMaxDecalsPerFrame": _int(0, 50),
    "Display.bDrawShadows": _bool(),
    "Display.iShadowMapResolution": _choice(256, 512, 1024),
    "Display.iShadowFilter": _choice(0, 1, 2),
    "Display.iActorShadowCountInt": _int(0, 10),
    "Display.iActorShadowCountExt": _int(0, 10),
    "Display.fSpecularLODStartFade": _float(0, 5000),
    "Display.fShadowLODStartFade": _float(0, 5000),
    "Display.fLightLODStartFade": _float(0, 5000),
    "BlurShaderHDR.bDoHighDynamicRange": _bool(),
    "BlurShader.bUseBlurShader": _bool(),
    "Imagespace.bDoDepthOfField": _bool(),
    "Imagespace.iRadialBlurLevel": _choice(0, 1, 2),
    "Grass.b30GrassVS": _bool(),
    "Grass.fGrassStartFadeDistance": _float(0, 10000),
    "LOD.fLODFadeOutMultActors": _float(1, 15),
    "LOD.fLODFadeOutMultObjects": _float(1, 15),
    "LOD.fLODFadeOutMultItems": _float(1, 15),
    "TerrainManager.fTreeLoadDistance": _float(0, 75000),
    "TerrainManager.fBlockLoadDistanceLow": _float(10000, 100000),
    "TerrainManager.fSplitDistanceMult": _float(0.5, 2),
    "Water.bUseWaterRefractions": _bool(),
    "Water.bUseWaterReflections": _bool(),
    "Water.bUseWaterReflectionBlur": _bool(),
    "Water.bUseWaterDisplacements": _bool(),
    "Water.bUseWaterDepth": _bool(),
    "Water.bReflectExplosions": _bool(),
    "Water.bForceHighDetailReflections": _bool(),
    "Water.bAutoWaterSilhouetteReflections": _bool(),
    "Water.iWaterReflectWidth": _choice(256, 512, 1024),
    "Water.iWaterReflectHeight": _choice(256, 512, 1024),
    "Water.iWaterBlurAmount": _int(0, 4),
}

# Keys the shipped presets set that the menu doesn't expose directly.
PRESET_ONLY = [
    "Display.iTexMipMapMinimum",
    "Display.fDecalLOD1",
    "Display.fDecalLOD2",
    "TerrainManager.fBlockLoadDistance",
    "TerrainManager.fHighBlockLoadDistanceLow",
]

# Everything the Custom preset snapshots, grouped by section in file order.
MANAGED = list(SETTABLE) + PRESET_ONLY
SECTION_ORDER = ["Display", "LOD", "TerrainManager", "Grass", "Imagespace",
                 "Water", "BlurShaderHDR", "BlurShader"]

_NUMBER = re.compile(r"^-?\d+(\.\d+)?$")


class SettingsError(Exception):
    pass


# ---------------------------------------------------------------- INI editing

class IniDoc:
    """Line-based INI editor that leaves every untouched byte as it was.

    FalloutPrefs.ini contains free-text lines (a multi-line warning string), so a
    strict parser can't round-trip it. Section and key names match
    case-insensitively, like the game.
    """

    def __init__(self, text):
        self.newline = "\r\n" if "\r\n" in text else "\n"
        self.trailing_newline = text.endswith(("\n", "\r"))
        self.lines = text.splitlines()

    @classmethod
    def load(cls, path):
        with open(path, "r", encoding="latin-1", newline="") as f:
            return cls(f.read())

    def text(self):
        out = self.newline.join(self.lines)
        return out + self.newline if self.trailing_newline else out

    @staticmethod
    def _header(line):
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            return s[1:-1].strip().lower()
        return None

    @staticmethod
    def _key(line):
        if "=" not in line or line.lstrip().startswith((";", "#")):
            return None
        return line.split("=", 1)[0].strip().lower()

    def _section_range(self, section):
        """(start, end) line indices of the section body, or None."""
        want = section.lower()
        start = None
        for i, line in enumerate(self.lines):
            h = self._header(line)
            if h is None:
                continue
            if start is not None:
                return start, i
            if h == want:
                start = i + 1
        return (start, len(self.lines)) if start is not None else None

    def get(self, section, key):
        rng = self._section_range(section)
        if rng is None:
            return None
        want = key.lower()
        for i in range(*rng):
            if self._key(self.lines[i]) == want:
                return self.lines[i].split("=", 1)[1].strip()
        return None

    def set(self, section, key, value):
        value = str(value)
        rng = self._section_range(section)
        if rng is None:
            if self.lines and self.lines[-1].strip():
                self.lines.append("")
            self.lines += ["[%s]" % section, "%s=%s" % (key, value)]
            self.trailing_newline = True
            return
        want = key.lower()
        found = False
        last_key_line = rng[0] - 1
        for i in range(*rng):
            k = self._key(self.lines[i])
            if k is not None:
                last_key_line = i
            if k == want:
                self.lines[i] = self.lines[i].split("=", 1)[0] + "=" + value
                found = True
        if not found:
            self.lines.insert(last_key_line + 1, "%s=%s" % (key, value))

    def entries(self):
        """Ordered (section, key, value) for every key=value line inside a section."""
        out, section = [], None
        for line in self.lines:
            h = self._header(line)
            if h is not None:
                section = line.strip()[1:-1].strip()
                continue
            k = self._key(line)
            if section is not None and k is not None:
                name, value = line.split("=", 1)
                out.append((section, name.strip(), value.strip()))
        return out


def split_key(full):
    section, key = full.split(".", 1)
    return section, key


def to_number(raw):
    if raw is None or not _NUMBER.match(raw.strip()):
        return None
    f = float(raw)
    return int(f) if f.is_integer() and "." not in raw else f


def format_value(full, value):
    key = split_key(full)[1]
    if key.startswith("f"):
        return "%.4f" % float(value)
    return str(int(value))


def validate(full, value):
    """Return the value as written to the INI, or raise SettingsError."""
    spec = SETTABLE.get(full)
    if spec is None:
        raise SettingsError("Unknown setting: %s" % full)
    kind = spec[0]
    if kind == "bool":
        if value is True or value is False or (type(value) is int and value in (0, 1)):
            return str(int(value))
        raise SettingsError("%s must be on or off" % full)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SettingsError("%s must be a number" % full)
    if value != value or value in (float("inf"), float("-inf")):
        raise SettingsError("%s must be a number" % full)
    if kind == "choice":
        if value not in spec[1]:
            raise SettingsError("%s can't be %s" % (full, value))
    elif kind == "int":
        if value != int(value) or not spec[1] <= value <= spec[2]:
            raise SettingsError("%s must be a whole number from %s to %s" % (full, spec[1], spec[2]))
    elif kind == "float":
        if not spec[1] <= value <= spec[2]:
            raise SettingsError("%s must be between %s and %s" % (full, spec[1], spec[2]))
    return format_value(full, value)


# ---------------------------------------------------------------- environment

def steam_libraries(home):
    """Steam library roots: the internal one first, then those in libraryfolders.vdf."""
    root = os.path.join(home, ".local/share/Steam")
    libs = [root]
    vdf = os.path.join(root, "steamapps/libraryfolders.vdf")
    try:
        with open(vdf, encoding="utf-8", errors="replace") as f:
            for path in re.findall(r'"path"\s+"([^"]+)"', f.read()):
                path = path.replace("\\\\", "\\")
                if os.path.realpath(path) not in map(os.path.realpath, libs):
                    libs.append(path)
    except OSError:
        pass
    return libs


def find_paths(home):
    prefs = game = None
    for lib in steam_libraries(home):
        if prefs is None and os.path.isfile(os.path.join(lib, PREFS_REL)):
            prefs = os.path.join(lib, PREFS_REL)
        if game is None and os.path.isdir(os.path.join(lib, GAME_REL)):
            game = os.path.join(lib, GAME_REL)
    return prefs, game


def game_running(proc="/proc"):
    try:
        pids = [p for p in os.listdir(proc) if p.isdigit()]
    except OSError:
        return False
    for pid in pids:
        try:
            with open(os.path.join(proc, pid, "cmdline"), "rb") as f:
                args = f.read().decode("utf-8", "replace").split("\0")
        except OSError:
            continue
        # Under Proton the exe shows up as a Windows or Unix path in any argument.
        for arg in args:
            if arg.replace("\\", "/").rsplit("/", 1)[-1].strip().lower() == GAME_EXE:
                return True
    return False


def write_atomic(path, text):
    """Write text (latin-1) to path through a temp file and rename."""
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".fnvsettings-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="latin-1", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if os.path.exists(path):
            shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------- core

class Settings:
    """All file logic, separate from the Decky Plugin class so it can be tested."""

    def __init__(self, home, proc="/proc"):
        self.home = home
        self.proc = proc

    def paths(self):
        prefs, game = find_paths(self.home)
        if prefs is None:
            raise SettingsError("FalloutPrefs.ini not found. Launch New Vegas once through Steam first.")
        return prefs, game

    def preset_file(self, game, filename):
        if game is None:
            return None
        try:
            for name in os.listdir(game):
                if name.lower() == filename.lower():
                    return os.path.join(game, name)
        except OSError:
            pass
        return None

    def load_preset(self, game, filename):
        path = self.preset_file(game, filename)
        if path is None:
            return None
        entries = []
        for section, key, value in IniDoc.load(path).entries():
            full = "%s.%s" % (section, key)
            canon = next((m for m in MANAGED if m.lower() == full.lower()), None)
            if canon is not None and to_number(value) is not None:
                entries.append((canon, value))
        return entries

    def _check_writable(self):
        if game_running(self.proc):
            raise SettingsError("Close Fallout: New Vegas first. It overwrites these settings when it exits.")

    def _commit(self, prefs, doc):
        backup = prefs + BACKUP_SUFFIX
        if not os.path.exists(backup):
            shutil.copy2(prefs, backup)
        write_atomic(prefs, doc.text())

    def state(self):
        prefs, game = self.paths()
        doc = IniDoc.load(prefs)
        values = {}
        for full in MANAGED:
            values[full] = to_number(doc.get(*split_key(full)))
        presets, matching = [], None
        for pid, name, filename in PRESETS:
            entries = self.load_preset(game, filename)
            if not entries:
                continue
            preset_values = {k: to_number(v) for k, v in entries}
            presets.append({"id": pid, "name": name, "values": preset_values})
            same = all(values.get(k) is not None and abs(float(values[k]) - float(v)) < 1e-6
                       for k, v in preset_values.items())
            # The user's own preset wins when a shipped one matches too.
            if same and (matching is None or pid == CUSTOM_ID):
                matching = pid
        return {
            "ok": True,
            "values": values,
            "presets": presets,
            "matching": matching,
            "gameRunning": game_running(self.proc),
            "resolutions": [list(r) for r in RESOLUTIONS],
            "prefsPath": prefs,
        }

    def set_values(self, values):
        if not isinstance(values, dict) or not values:
            raise SettingsError("No settings given")
        checked = [(full, validate(full, v)) for full, v in values.items()]
        if ("Display.iSize W" in values) != ("Display.iSize H" in values):
            raise SettingsError("Resolution width and height must be set together")
        if "Display.iSize W" in values and \
                (values["Display.iSize W"], values["Display.iSize H"]) not in RESOLUTIONS:
            raise SettingsError("Unsupported resolution")
        self._check_writable()
        prefs, _ = self.paths()
        doc = IniDoc.load(prefs)
        for full, raw in checked:
            doc.set(*split_key(full), raw)
        self._commit(prefs, doc)
        return self.state()

    def apply_preset(self, preset_id):
        match = [p for p in PRESETS if p[0] == preset_id]
        if not match:
            raise SettingsError("Unknown preset")
        self._check_writable()
        prefs, game = self.paths()
        entries = self.load_preset(game, match[0][2])
        if not entries:
            raise SettingsError("%s preset file not found in the game folder" % match[0][1])
        doc = IniDoc.load(prefs)
        for full, value in entries:
            doc.set(*split_key(full), value)
        self._commit(prefs, doc)
        return self.state()

    def save_custom(self):
        prefs, game = self.paths()
        if game is None:
            raise SettingsError("Game folder not found")
        doc = IniDoc.load(prefs)
        lines = []
        for section in SECTION_ORDER:
            keys = [k for k in MANAGED if split_key(k)[0] == section]
            rows = []
            for full in keys:
                v = doc.get(*split_key(full))
                if v is not None and to_number(v) is not None:
                    rows.append("%s=%s" % (split_key(full)[1], v))
            if rows:
                lines += ["", "[%s]" % section] + rows
        path = self.preset_file(game, "Custom.ini") or os.path.join(game, "Custom.ini")
        write_atomic(path, "\r\n".join(lines) + "\r\n")
        return self.state()

    def ensure_custom(self):
        """Create Custom.ini from the current settings, once."""
        try:
            prefs, game = self.paths()
        except SettingsError:
            return False
        if game is None or self.preset_file(game, "Custom.ini") is not None:
            return False
        self.save_custom()
        return True


def _result(fn, *args):
    try:
        return fn(*args)
    except SettingsError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:  # report instead of leaving the panel hanging
        decky.logger.exception("FNV Settings failed")
        return {"ok": False, "error": "Unexpected error: %s" % e}


class Plugin:
    def __init__(self):
        self.settings = Settings(decky.DECKY_USER_HOME)

    async def get_state(self):
        return _result(self.settings.state)

    async def set_values(self, values):
        return _result(self.settings.set_values, values)

    async def apply_preset(self, preset_id):
        return _result(self.settings.apply_preset, preset_id)

    async def save_custom(self):
        return _result(self.settings.save_custom)

    async def _main(self):
        try:
            if self.settings.ensure_custom():
                decky.logger.info("Created Custom.ini from current settings")
        except Exception:
            decky.logger.exception("Could not create Custom.ini")

    async def _unload(self):
        pass

    async def _uninstall(self):
        pass
