"""Backend tests. Run from the plugin root: python3 -I -m unittest discover -s tests -v

Uses copies of the real game files when they exist (FNV_PREFS / FNV_GAME env vars
override the paths), otherwise small built-in fixtures.
"""
import asyncio
import importlib.util
import logging
import os
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Stub of Decky's backend module, which only exists inside the loader.
decky = types.ModuleType("decky")
decky.logger = logging.getLogger("fnv-settings-test")
decky.DECKY_USER_HOME = "/nonexistent"
sys.modules["decky"] = decky

spec = importlib.util.spec_from_file_location("fnv_main", os.path.join(ROOT, "main.py"))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

HOME = os.path.expanduser("~")
REAL_PREFS = os.environ.get("FNV_PREFS", os.path.join(HOME, ".local/share/Steam", M.PREFS_REL))
REAL_GAME = os.environ.get("FNV_GAME", os.path.join(HOME, ".local/share/Steam", M.GAME_REL))
SHIPPED = ["low.ini", "medium.ini", "high.ini", "VeryHigh.ini"]

FIXTURE_PREFS = (
    "[General]\r\nsStartingCell=\r\n[Display]\r\niSize W=1280\r\niSize H=800\r\n"
    "iMultiSample=4\r\nbFull Screen=0\r\niPresentInterval=0\r\n"
    "[GeneralWarnings]\r\nSMasterMismatchWarning=One of the files has changed.\r\n"
    "This may result in errors. Saving again will clear this message\r\n"
    "but not necessarily fix any errors.\r\n[Water]\r\nbUseWaterReflections=1\r\n"
)


def fixture_preset(level):
    v = {"low": 1, "medium": 2, "high": 4, "VeryHigh": 8}[level]
    return ("\r\n[Display]\r\niMultiSample=%d\r\niMaxAnisotropy=%d\r\n"
            "[Water]\r\nbUseWaterReflections=%d\r\n" % (v, min(v * 2, 15), 0 if level == "low" else 1))


class Env:
    """A fake home with a Steam library holding copies of the game's files."""

    def __init__(self, use_real=True, with_custom=False):
        self.tmp = tempfile.mkdtemp(prefix="fnvtest-")
        self.home = os.path.join(self.tmp, "home")
        lib = os.path.join(self.home, ".local/share/Steam")
        self.prefs = os.path.join(lib, M.PREFS_REL)
        self.game = os.path.join(lib, M.GAME_REL)
        os.makedirs(os.path.dirname(self.prefs))
        os.makedirs(self.game)
        self.real = use_real and os.path.isfile(REAL_PREFS) and \
            all(os.path.isfile(os.path.join(REAL_GAME, f)) for f in SHIPPED)
        if self.real:
            shutil.copyfile(REAL_PREFS, self.prefs)
            for f in SHIPPED:
                shutil.copyfile(os.path.join(REAL_GAME, f), os.path.join(self.game, f))
        else:
            with open(self.prefs, "w", encoding="latin-1", newline="") as f:
                f.write(FIXTURE_PREFS)
            for f in SHIPPED:
                with open(os.path.join(self.game, f), "w", newline="") as fh:
                    fh.write(fixture_preset(f[:-4]))
        if with_custom and self.real and os.path.isfile(os.path.join(REAL_GAME, "Custom.ini")):
            shutil.copyfile(os.path.join(REAL_GAME, "Custom.ini"), os.path.join(self.game, "Custom.ini"))
        self.proc = os.path.join(self.tmp, "proc")
        os.makedirs(self.proc)
        self.add_process(100, ["/usr/bin/steam", "-gamepadui"])
        self.s = M.Settings(self.home, proc=self.proc)

    def add_process(self, pid, argv):
        d = os.path.join(self.proc, str(pid))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "cmdline"), "wb") as f:
            f.write(b"\0".join(a.encode() for a in argv) + b"\0")

    def prefs_bytes(self):
        with open(self.prefs, "rb") as f:
            return f.read()

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


def changed_lines(before, after):
    a = before.decode("latin-1").split("\r\n")
    b = after.decode("latin-1").split("\r\n")
    if len(a) != len(b):
        return None
    return {i: (x, y) for i, (x, y) in enumerate(zip(a, b)) if x != y}


class Base(unittest.TestCase):
    use_real = True

    def setUp(self):
        self.env = Env(use_real=self.use_real)
        self.s = self.env.s

    def tearDown(self):
        self.env.cleanup()


# ---------------------------------------------------------------- parser

class TestIniDoc(unittest.TestCase):
    def test_round_trip_is_byte_identical(self):
        for text in [FIXTURE_PREFS, "a\nb", "[S]\nk=v\n", "", "[S]\r\nk=v"]:
            self.assertEqual(M.IniDoc(text).text(), text)

    def test_real_prefs_round_trip_and_read(self):
        if not os.path.isfile(REAL_PREFS):
            self.skipTest("real FalloutPrefs.ini not present")
        with open(REAL_PREFS, "rb") as f:
            raw = f.read()
        doc = M.IniDoc(raw.decode("latin-1"))
        self.assertEqual(doc.text().encode("latin-1"), raw)
        self.assertEqual(doc.newline, "\r\n")
        self.assertIsNotNone(doc.get("Display", "iSize W"))

    def test_case_insensitive(self):
        doc = M.IniDoc(FIXTURE_PREFS)
        self.assertEqual(doc.get("display", "ISIZE w"), "1280")
        doc.set("DISPLAY", "isize w", "1920")
        self.assertIn("\r\niSize W=1920\r\n", doc.text())

    def test_free_text_lines_untouched(self):
        doc = M.IniDoc(FIXTURE_PREFS)
        doc.set("Water", "bUseWaterReflections", "0")
        self.assertIn("This may result in errors. Saving again will clear this message\r\n"
                      "but not necessarily fix any errors.\r\n", doc.text())
        self.assertIsNone(doc.get("GeneralWarnings", "This may result in errors. Saving again will clear this message"))

    def test_missing_key_inserted_into_section(self):
        doc = M.IniDoc(FIXTURE_PREFS)
        doc.set("Display", "iMaxAnisotropy", "8")
        lines = doc.text().split("\r\n")
        i = lines.index("iMaxAnisotropy=8")
        self.assertEqual(lines[i - 1], "iPresentInterval=0")
        self.assertEqual(lines[i + 1], "[GeneralWarnings]")

    def test_missing_section_appended(self):
        doc = M.IniDoc(FIXTURE_PREFS)
        doc.set("BlurShader", "bUseBlurShader", "1")
        self.assertTrue(doc.text().endswith("\r\n[BlurShader]\r\nbUseBlurShader=1\r\n"))
        self.assertEqual(doc.get("BlurShader", "bUseBlurShader"), "1")

    def test_latin1_preserved(self):
        text = "[Display]\r\nsD3DDevice=Caf\xe9 GPU\r\niSize W=1\r\n"
        doc = M.IniDoc(text)
        doc.set("Display", "iSize W", "2")
        self.assertIn("Caf\xe9", doc.text())

    def test_comments_and_spaces(self):
        doc = M.IniDoc("[Display]\n;iSize W=1\niSize W = 5\n")
        self.assertEqual(doc.get("Display", "iSize W"), "5")
        doc.set("Display", "iSize W", "7")
        self.assertEqual(doc.text(), "[Display]\n;iSize W=1\niSize W =7\n")


# ---------------------------------------------------------------- validation

class TestValidation(Base):
    BAD = [
        ("Display.sD3DDevice", 1),
        ("Display.iSize W", "1920"),
        ("Display.iMultiSample", 3),
        ("Display.iMultiSample", 4.5),
        ("Display.iMultiSample", True),
        ("Display.bFull Screen", 2),
        ("Display.bFull Screen", "1"),
        ("Display.iMaxDecalsPerFrame", 51),
        ("Display.iMaxDecalsPerFrame", 2.5),
        ("LOD.fLODFadeOutMultActors", 16),
        ("LOD.fLODFadeOutMultActors", float("nan")),
        ("LOD.fLODFadeOutMultActors", float("inf")),
        ("Water.iWaterBlurAmount", -1),
        ("Display.iShadowMapResolution", "../../etc/passwd"),
        ("General.sLanguage", "ENGLISH\r\n[Display]"),
        ("Nope", 1),
    ]

    def test_bad_values_rejected_and_file_unchanged(self):
        before = self.env.prefs_bytes()
        for key, val in self.BAD:
            with self.subTest(key=key, val=val):
                r = M._result(self.s.set_values, {key: val})
                self.assertFalse(r["ok"], r)
        self.assertEqual(self.env.prefs_bytes(), before)
        self.assertFalse(os.path.exists(self.env.prefs + M.BACKUP_SUFFIX))

    def test_one_bad_value_rejects_whole_batch(self):
        before = self.env.prefs_bytes()
        r = M._result(self.s.set_values, {"Display.iMultiSample": 2, "Display.iMaxAnisotropy": 3})
        self.assertFalse(r["ok"])
        self.assertEqual(self.env.prefs_bytes(), before)

    def test_resolution_rules(self):
        for vals in [{"Display.iSize W": 1920},
                     {"Display.iSize W": 1920, "Display.iSize H": 1200 - 1},
                     {"Display.iSize W": 1280, "Display.iSize H": 1080}]:
            with self.subTest(vals=vals):
                self.assertFalse(M._result(self.s.set_values, vals)["ok"])

    def test_empty_or_wrong_type(self):
        for vals in [{}, None, [], "x"]:
            self.assertFalse(M._result(self.s.set_values, vals)["ok"])


# ---------------------------------------------------------------- every control

def every_value(full):
    spec = M.SETTABLE[full]
    if spec[0] == "bool":
        return [True, False, 0, 1]
    if spec[0] == "choice":
        return sorted(spec[1])
    if spec[0] == "int":
        return [spec[1], (spec[1] + spec[2]) // 2, spec[2]]
    return [spec[1], (spec[1] + spec[2]) / 2, spec[2]]


class TestEveryControl(Base):
    def test_each_key_writes_only_itself(self):
        for full in M.SETTABLE:
            if full.startswith("Display.iSize"):
                continue
            for val in every_value(full):
                with self.subTest(key=full, val=val):
                    before = self.env.prefs_bytes()
                    r = self.s.set_values({full: val})
                    self.assertTrue(r["ok"])
                    after = self.env.prefs_bytes()
                    section, key = M.split_key(full)
                    self.assertEqual(M.IniDoc.load(self.env.prefs).get(section, key), M.format_value(full, val))
                    self.assertEqual(M.to_number(M.format_value(full, val)), r["values"][full] if not isinstance(val, bool) else int(val))
                    diff = changed_lines(before, after)
                    if diff is None:  # key was missing and got inserted
                        self.assertEqual(len(after.split(b"\r\n")), len(before.split(b"\r\n")) + (1 if M.IniDoc(before.decode("latin-1"))._section_range(section) else 3))
                    else:
                        self.assertLessEqual(len(diff), 1, diff)
                        for x, y in diff.values():
                            self.assertEqual(x.split("=")[0].strip().lower(), key.lower())

    def test_every_resolution(self):
        for w, h in M.RESOLUTIONS:
            with self.subTest(res=(w, h)):
                before = self.env.prefs_bytes()
                r = self.s.set_values({"Display.iSize W": w, "Display.iSize H": h})
                self.assertTrue(r["ok"])
                self.assertEqual((r["values"]["Display.iSize W"], r["values"]["Display.iSize H"]), (w, h))
                diff = changed_lines(before, self.env.prefs_bytes())
                self.assertIsNotNone(diff)
                for x, _ in diff.values():
                    self.assertTrue(x.startswith("iSize "))

    def test_only_line_count_and_crlf_preserved(self):
        before = self.env.prefs_bytes()
        self.s.set_values({"Display.iMultiSample": 2, "Water.bUseWaterReflections": 0})
        after = self.env.prefs_bytes()
        self.assertEqual(after.count(b"\r\n"), before.count(b"\r\n"))
        self.assertEqual(len(changed_lines(before, after)), 2)
        self.assertNotIn(b"\n", after.replace(b"\r\n", b""))

    def test_float_format_matches_game(self):
        self.s.set_values({"LOD.fLODFadeOutMultActors": 7.5})
        self.assertEqual(M.IniDoc.load(self.env.prefs).get("LOD", "fLODFadeOutMultActors"), "7.5000")


# ---------------------------------------------------------------- presets

def preset_entries(env, name):
    return env.s.load_preset(env.game, name)


class TestPresets(Base):
    def test_shipped_presets_listed(self):
        ids = [p["id"] for p in self.s.state()["presets"]]
        self.assertEqual(ids[:4], ["low", "medium", "high", "veryhigh"])

    def test_each_preset_applies_exactly_its_keys(self):
        for pid, _, filename in M.PRESETS[:4]:
            with self.subTest(preset=pid):
                before = self.env.prefs_bytes()
                res_before = M.IniDoc(before.decode("latin-1"))
                entries = preset_entries(self.env, filename)
                if self.env.real:
                    self.assertEqual(len(entries), 41)
                r = self.s.apply_preset(pid)
                self.assertTrue(r["ok"])
                self.assertEqual(r["matching"], pid)
                doc = M.IniDoc.load(self.env.prefs)
                preset_keys = {k.lower() for k, _ in entries}
                for full, value in entries:
                    self.assertEqual(doc.get(*M.split_key(full)), value)
                # Nothing outside the preset changed (compared line by line, so
                # duplicate keys like the game's repeated STestFile1 are covered).
                outside = lambda d: [e for e in d.entries()
                                     if ("%s.%s" % (e[0], e[1])).lower() not in preset_keys]
                self.assertEqual(outside(doc), outside(res_before))
                for k in ("iSize W", "iSize H", "bFull Screen", "iPresentInterval"):
                    self.assertEqual(doc.get("Display", k), res_before.get("Display", k))

    def test_preset_values_exposed_and_live_after_apply(self):
        for pid, _, filename in M.PRESETS[:4]:
            with self.subTest(preset=pid):
                listed = {p["id"]: p for p in self.s.state()["presets"]}[pid]["values"]
                self.assertEqual(listed, {k: M.to_number(v) for k, v in preset_entries(self.env, filename)})
                live = self.s.apply_preset(pid)["values"]
                for k, v in listed.items():
                    self.assertAlmostEqual(live[k], v)

    def test_matching_none_when_modified(self):
        self.s.apply_preset("high")
        r = self.s.set_values({"Imagespace.iRadialBlurLevel": 0 if self.env.real else 0,
                               "Display.iMaxAnisotropy": 15 if not self.env.real else 2})
        self.assertIsNone(r["matching"])

    def test_unknown_preset(self):
        for bad in ["ultra", "../high", "", None]:
            self.assertFalse(M._result(self.s.apply_preset, bad)["ok"])

    def test_missing_preset_file(self):
        os.remove(os.path.join(self.env.game, "low.ini"))
        r = self.s.state()
        self.assertNotIn("low", [p["id"] for p in r["presets"]])
        self.assertFalse(M._result(self.s.apply_preset, "low")["ok"])

    def test_preset_file_case_insensitive(self):
        os.rename(os.path.join(self.env.game, "VeryHigh.ini"), os.path.join(self.env.game, "veryhigh.INI"))
        self.assertTrue(self.s.apply_preset("veryhigh")["ok"])

    def test_preset_junk_ignored(self):
        with open(os.path.join(self.env.game, "low.ini"), "a", newline="") as f:
            f.write("[General]\r\nsStartingCell=Evil\r\n[Display]\r\niSize W=99999\r\nfDecalLOD1=abc\r\n")
        before = M.IniDoc.load(self.env.prefs)
        self.s.apply_preset("low")
        doc = M.IniDoc.load(self.env.prefs)
        self.assertEqual(doc.get("General", "sStartingCell"), before.get("General", "sStartingCell"))
        self.assertNotEqual(doc.get("Display", "fDecalLOD1"), "abc")


# ---------------------------------------------------------------- custom preset

class TestCustom(Base):
    def custom_path(self):
        return os.path.join(self.env.game, "Custom.ini")

    def test_created_once_from_current(self):
        before = M.IniDoc.load(self.env.prefs)
        self.assertTrue(self.s.ensure_custom())
        self.assertTrue(os.path.isfile(self.custom_path()))
        with open(self.custom_path(), "rb") as f:
            raw = f.read()
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""))
        entries = preset_entries(self.env, "Custom.ini")
        official = self.s.official_keys(self.env.game)
        present = [k for k in official if before.get(*M.split_key(k)) is not None]
        self.assertEqual([k for k, _ in entries], present)
        for full, value in entries:
            self.assertEqual(before.get(*M.split_key(full)), value)
        if self.env.real:
            self.assertEqual(len(entries), 41)
        # Not recreated or overwritten.
        with open(self.custom_path(), "ab") as f:
            f.write(b"; marker\r\n")
        self.assertFalse(self.s.ensure_custom())
        with open(self.custom_path(), "rb") as f:
            self.assertTrue(f.read().endswith(b"; marker\r\n"))

    def test_custom_has_exactly_the_official_keys_and_no_display_settings(self):
        self.s.ensure_custom()
        names = [(sec.lower(), key.lower()) for sec, key, _ in M.IniDoc.load(self.custom_path()).entries()]
        for full in M.DISPLAY_ONLY:
            sec, key = M.split_key(full)
            self.assertNotIn((sec.lower(), key.lower()), names, full)
        official = [(sec.lower(), key.lower()) for sec, key, _ in
                    M.IniDoc.load(os.path.join(self.env.game, "low.ini")).entries()]
        present = M.IniDoc.load(self.env.prefs)
        self.assertEqual(names, [n for n in official if present.get(*n) is not None])

    def test_custom_saved_from_an_official_preset_is_identical_to_it(self):
        for pid, _, filename in M.PRESETS[:4]:
            with self.subTest(preset=pid):
                self.s.apply_preset(pid)
                self.s.save_custom()
                with open(self.custom_path(), "rb") as a, open(os.path.join(self.env.game, filename), "rb") as b:
                    self.assertEqual(a.read(), b.read())

    def test_creating_custom_does_not_touch_prefs(self):
        before = self.env.prefs_bytes()
        self.s.ensure_custom()
        self.assertEqual(self.env.prefs_bytes(), before)

    def test_new_custom_file_has_normal_permissions(self):
        old = os.umask(0o022)
        try:
            self.s.ensure_custom()
        finally:
            os.umask(old)
        self.assertEqual(os.stat(self.custom_path()).st_mode & 0o777, 0o644)

    def test_custom_listed_and_matching(self):
        self.s.ensure_custom()
        r = self.s.state()
        self.assertEqual({k: r["presets"][-1][k] for k in ("id", "name")}, {"id": "custom", "name": "Custom (yours)"})
        self.assertEqual(r["matching"], "custom")

    def test_apply_custom_restores_settings_but_never_resolution(self):
        self.s.ensure_custom()
        original = self.s.state()["values"]
        self.s.apply_preset("low")
        display = {"Display.iSize W": 2560, "Display.iSize H": 1440,
                   "Display.bFull Screen": True, "Display.iPresentInterval": True,
                   "BlurShader.bUseBlurShader": True}
        self.s.set_values(display)
        r = self.s.apply_preset("custom")
        for k, v in original.items():
            if v is None:
                continue
            if k in M.DISPLAY_ONLY:
                self.assertEqual(r["values"][k], int(display[k]), k)
            else:
                self.assertEqual(r["values"][k], v, k)
        self.assertEqual(r["matching"], "custom")

    def test_older_custom_with_resolution_cannot_change_it(self):
        self.s.ensure_custom()
        with open(self.custom_path(), "ab") as f:
            f.write(b"\r\n[Display]\r\niSize W=3840\r\niSize H=2160\r\nbFull Screen=1\r\n"
                    b"iPresentInterval=1\r\n[BlurShader]\r\nbUseBlurShader=1\r\n")
        before = M.IniDoc.load(self.env.prefs)
        self.s.apply_preset("custom")
        after = M.IniDoc.load(self.env.prefs)
        for full in M.DISPLAY_ONLY:
            self.assertEqual(after.get(*M.split_key(full)), before.get(*M.split_key(full)), full)
        self.assertEqual(self.s.state()["matching"], "custom")

    def test_no_preset_touches_display_settings(self):
        self.s.ensure_custom()
        for pid, _, filename in M.PRESETS:
            with self.subTest(preset=pid):
                keys = {k for k, _ in preset_entries(self.env, filename)}
                self.assertFalse(keys & M.DISPLAY_ONLY)

    def test_no_official_presets_means_no_custom(self):
        for f in SHIPPED:
            os.remove(os.path.join(self.env.game, f))
        self.assertFalse(self.s.ensure_custom())
        self.assertFalse(os.path.exists(self.custom_path()))
        self.assertFalse(M._result(self.s.save_custom)["ok"])

    def test_save_then_apply_round_trips(self):
        self.s.ensure_custom()
        self.s.apply_preset("medium")
        self.s.set_values({"Display.iSize W": 1920, "Display.iSize H": 1080, "Display.iMultiSample": 2})
        saved = self.s.save_custom()["values"]
        self.s.apply_preset("veryhigh")
        before = self.s.apply_preset("custom")
        self.assertEqual(before["values"], saved)
        prefs_after_apply = self.env.prefs_bytes()
        self.s.apply_preset("custom")
        self.assertEqual(self.env.prefs_bytes(), prefs_after_apply)

    def test_save_custom_allowed_while_game_running(self):
        # Saving only reads the prefs, so it's safe even with the game open.
        self.env.add_process(4242, ["Z:\\home\\deck\\steamapps\\common\\Fallout New Vegas\\FalloutNV.exe"])
        self.assertTrue(self.s.save_custom()["ok"])


# ---------------------------------------------------------------- safety

class TestSafety(Base):
    RUNNING = [
        ["Z:\\home\\deck\\.local\\share\\Steam\\steamapps\\common\\Fallout New Vegas\\FalloutNV.exe"],
        ["C:\\Program Files (x86)\\Steam\\steamapps\\common\\Fallout New Vegas\\falloutnv.exe", "-x"],
        ["/home/deck/.local/share/Steam/steamapps/common/Fallout New Vegas/FalloutNV.exe"],
        ["wine64", "FalloutNV.exe"],
    ]
    NOT_RUNNING = [
        ["/usr/bin/python3", "/tmp/notes_about_FalloutNV.exe.txt"],
        ["nvse_loader.exe"],
        ["FalloutNVLauncher.exe"],
    ]

    def test_writes_refused_while_game_runs(self):
        for i, argv in enumerate(self.RUNNING):
            with self.subTest(argv=argv):
                env = Env(use_real=False)
                try:
                    env.add_process(500 + i, argv)
                    before = env.prefs_bytes()
                    for call in (lambda: env.s.set_values({"Display.iMultiSample": 2}),
                                 lambda: env.s.apply_preset("low")):
                        r = M._result(call)
                        self.assertFalse(r["ok"])
                        self.assertIn("Close", r["error"])
                    self.assertTrue(env.s.state()["gameRunning"])
                    self.assertEqual(env.prefs_bytes(), before)
                finally:
                    env.cleanup()

    def test_other_processes_not_mistaken_for_game(self):
        for i, argv in enumerate(self.NOT_RUNNING):
            self.env.add_process(600 + i, argv)
        self.assertFalse(self.s.state()["gameRunning"])
        self.assertTrue(self.s.set_values({"Display.iMultiSample": 2})["ok"])

    def test_unreadable_proc_entries_ignored(self):
        os.makedirs(os.path.join(self.env.proc, "777"))  # no cmdline file
        self.assertFalse(M.game_running(self.env.proc))
        self.assertFalse(M.game_running(os.path.join(self.env.tmp, "missing")))

    def test_backup_made_once(self):
        original = self.env.prefs_bytes()
        backup = self.env.prefs + M.BACKUP_SUFFIX
        self.s.set_values({"Display.iMultiSample": 2})
        with open(backup, "rb") as f:
            self.assertEqual(f.read(), original)
        self.s.set_values({"Display.iMultiSample": 8})
        self.s.apply_preset("low")
        with open(backup, "rb") as f:
            self.assertEqual(f.read(), original)

    def test_atomic_write_failure_keeps_original(self):
        before = self.env.prefs_bytes()
        with mock.patch.object(M.os, "replace", side_effect=OSError("disk full")):
            r = M._result(self.s.set_values, {"Display.iMultiSample": 2})
        self.assertFalse(r["ok"])
        self.assertEqual(self.env.prefs_bytes(), before)
        leftovers = [f for f in os.listdir(os.path.dirname(self.env.prefs)) if f.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_file_mode_preserved(self):
        os.chmod(self.env.prefs, 0o640)
        self.s.set_values({"Display.iMultiSample": 2})
        self.assertEqual(os.stat(self.env.prefs).st_mode & 0o777, 0o640)

    def test_missing_prefs_reports_error(self):
        os.remove(self.env.prefs)
        for call in (self.s.state, lambda: self.s.set_values({"Display.iMultiSample": 2}),
                     lambda: self.s.apply_preset("low"), self.s.save_custom):
            r = M._result(call)
            self.assertFalse(r["ok"])
            self.assertIn("FalloutPrefs.ini not found", r["error"])
        self.assertFalse(self.s.ensure_custom())

    def test_unexpected_error_is_reported_not_raised(self):
        with mock.patch.object(M.Settings, "state", side_effect=RuntimeError("boom")):
            r = asyncio.run(self._plugin().get_state())
        self.assertEqual(r, {"ok": False, "error": "Unexpected error: boom"})

    def _plugin(self):
        p = M.Plugin()
        p.settings = self.s
        return p


class TestPaths(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fnvpaths-")
        self.home = os.path.join(self.tmp, "home")
        self.root = os.path.join(self.home, ".local/share/Steam")
        os.makedirs(os.path.join(self.root, "steamapps"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def lib(self, name, prefs=False, game=False):
        path = os.path.join(self.tmp, name)
        if prefs:
            os.makedirs(os.path.dirname(os.path.join(path, M.PREFS_REL)), exist_ok=True)
            open(os.path.join(path, M.PREFS_REL), "w").close()
        if game:
            os.makedirs(os.path.join(path, M.GAME_REL), exist_ok=True)
        return path

    def write_vdf(self, *paths):
        body = "".join('\t"%d"\n\t{\n\t\t"path"\t\t"%s"\n\t}\n' % (i, p) for i, p in enumerate(paths))
        with open(os.path.join(self.root, "steamapps/libraryfolders.vdf"), "w") as f:
            f.write('"libraryfolders"\n{\n' + body + "}\n")

    def test_falls_back_to_other_libraries(self):
        a = self.lib("sd1")
        b = self.lib("sd2", prefs=True)
        c = self.lib("sd3", game=True)
        self.write_vdf(self.root, a, b, c)
        prefs, game = M.find_paths(self.home)
        self.assertEqual(prefs, os.path.join(b, M.PREFS_REL))
        self.assertEqual(game, os.path.join(c, M.GAME_REL))

    def test_internal_library_wins(self):
        self.lib("sd1", prefs=True, game=True)
        os.makedirs(os.path.dirname(os.path.join(self.root, M.PREFS_REL)))
        open(os.path.join(self.root, M.PREFS_REL), "w").close()
        self.write_vdf(self.root, os.path.join(self.tmp, "sd1"))
        prefs, game = M.find_paths(self.home)
        self.assertEqual(prefs, os.path.join(self.root, M.PREFS_REL))
        self.assertEqual(game, os.path.join(self.tmp, "sd1", M.GAME_REL))

    def test_no_vdf_and_missing_libraries(self):
        self.assertEqual(M.find_paths(self.home), (None, None))
        self.write_vdf("/run/media/deck/unplugged-card")
        self.assertEqual(M.find_paths(self.home), (None, None))


class TestPluginApi(Base):
    """The async methods Decky calls, end to end."""

    def test_async_api(self):
        p = M.Plugin()
        p.settings = self.s
        run = asyncio.run
        run(p._main())
        self.assertTrue(os.path.isfile(os.path.join(self.env.game, "Custom.ini")))
        st = run(p.get_state())
        self.assertTrue(st["ok"])
        self.assertEqual(run(p.set_values({"Display.iMultiSample": 2}))["values"]["Display.iMultiSample"], 2)
        self.assertEqual(run(p.apply_preset("high"))["matching"], "high")
        self.assertTrue(run(p.save_custom())["ok"])
        self.assertEqual(run(p.get_state())["matching"], "custom")
        self.assertFalse(run(p.set_values({"bad": 1}))["ok"])
        run(p._unload())
        run(p._uninstall())

    def test_main_never_raises(self):
        p = M.Plugin()
        p.settings = M.Settings(os.path.join(self.env.tmp, "nohome"))
        asyncio.run(p._main())

    def test_plugin_uses_decky_home(self):
        self.assertEqual(M.Plugin().settings.home, decky.DECKY_USER_HOME)


class TestFixturesOnly(TestEveryControl):
    """Same control checks against the small fixture, to cover missing keys and sections."""
    use_real = False


class TestPresetsFixture(TestPresets):
    use_real = False


class TestCustomFixture(TestCustom):
    use_real = False


if __name__ == "__main__":
    unittest.main()
