import {
  ButtonItem,
  ConfirmModal,
  DropdownItem,
  PanelSection,
  PanelSectionRow,
  SliderField,
  ToggleField,
  showModal,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import { Component, ErrorInfo, ReactNode, useEffect, useRef, useState } from "react";
import { FaSlidersH } from "react-icons/fa";

type Values = Record<string, number | null>;

interface State {
  ok: true;
  values: Values;
  presets: { id: string; name: string; values?: Values }[];
  matching: string | null;
  gameRunning: boolean;
  resolutions: [number, number][];
}
type Result = State | { ok: false; error: string };

// Backend calls never throw: a crashed, slow or missing backend becomes an error result.
function isState(r: any): r is State {
  return (
    r && r.ok === true && r.values && typeof r.values === "object" &&
    Array.isArray(r.presets) && Array.isArray(r.resolutions)
  );
}
function safe<A extends unknown[]>(name: string): (...args: A) => Promise<Result> {
  const fn = callable<A, Result>(name);
  return async (...args: A) => {
    try {
      const r = await fn(...args);
      if (isState(r)) return r;
      if (r && r.ok === false && typeof r.error === "string") return r;
      return { ok: false, error: "Unexpected reply from the plugin backend" };
    } catch (e) {
      console.error("FNV Settings:", name, e);
      return { ok: false, error: "Plugin backend not responding. Try reloading Decky." };
    }
  };
}
const getState = safe<[]>("get_state");
const setValuesCall = safe<[values: Record<string, number | boolean>]>("set_values");
const applyPresetCall = safe<[id: string]>("apply_preset");
const saveCustomCall = safe<[]>("save_custom");

function toast(body: string) {
  try {
    toaster.toast({ title: "FNV Settings", body });
  } catch (e) {
    console.error("FNV Settings: toast failed", e);
  }
}

// ---------------------------------------------------------------- controls

interface DropdownOpt {
  label: string;
  set: Record<string, number>;
}
type Control =
  | { kind: "dropdown"; label: string; options: (v: Values, s: State) => DropdownOpt[]; selected?: (v: Values) => number }
  | { kind: "toggle"; label: string; key: string; invert?: boolean }
  // min/max/step are the backend's limits, used only when no preset values are available;
  // normally the slider's stops are the shipped presets' values.
  | { kind: "slider"; label: string; key: string; min: number; max: number; step: number };

interface Section {
  title: string;
  controls: Control[];
}

const D = "Display.";

function opts(keys: string[], entries: [string, number][]): () => DropdownOpt[] {
  return () => entries.map(([label, value]) => ({ label, set: Object.fromEntries(keys.map((k) => [k, value])) }));
}

// Values of 0 or 1 both mean "off" for sample counts.
const offOrValue = (key: string, choices: number[]) => (v: Values) => {
  const cur = v[key] ?? 0;
  return cur <= 1 ? 0 : choices.indexOf(cur);
};

function aspect(w: number, h: number): string {
  const r = w / h;
  if (Math.abs(r - 16 / 10) < 0.01) return "16:10";
  if (Math.abs(r - 16 / 9) < 0.02) return "16:9";
  return "";
}

const SECTIONS: Section[] = [
  {
    title: "Display",
    controls: [
      {
        kind: "dropdown",
        label: "Resolution",
        options: (_v, s) =>
          s.resolutions.map(([w, h]) => ({
            label: `${w}×${h} (${aspect(w, h)})`,
            set: { [D + "iSize W"]: w, [D + "iSize H"]: h },
          })),
      },
      {
        kind: "dropdown",
        label: "Anti-aliasing",
        options: opts([D + "iMultiSample", D + "iWaterMultisamples"], [["Off", 0], ["2x MSAA", 2], ["4x MSAA", 4], ["8x MSAA", 8]]),
        selected: offOrValue(D + "iMultiSample", [0, 2, 4, 8]),
      },
      {
        kind: "dropdown",
        label: "Anisotropic filtering",
        options: opts([D + "iMaxAnisotropy"], [["Off", 0], ["2x", 2], ["4x", 4], ["8x", 8], ["15x", 15]]),
        selected: offOrValue(D + "iMaxAnisotropy", [0, 2, 4, 8, 15]),
      },
      { kind: "toggle", label: "Windowed", key: D + "bFull Screen", invert: true },
      { kind: "toggle", label: "VSync", key: D + "iPresentInterval" },
      {
        kind: "dropdown",
        label: "Screen effect",
        options: () => [
          { label: "None", set: { "BlurShaderHDR.bDoHighDynamicRange": 0, "BlurShader.bUseBlurShader": 0 } },
          { label: "Bloom", set: { "BlurShaderHDR.bDoHighDynamicRange": 0, "BlurShader.bUseBlurShader": 1 } },
          { label: "HDR", set: { "BlurShaderHDR.bDoHighDynamicRange": 1, "BlurShader.bUseBlurShader": 0 } },
        ],
        selected: (v) => (v["BlurShaderHDR.bDoHighDynamicRange"] ? 2 : v["BlurShader.bUseBlurShader"] ? 1 : 0),
      },
    ],
  },
  {
    title: "Detail",
    controls: [
      {
        kind: "dropdown",
        label: "Texture size",
        options: opts([D + "iTexMipMapSkip"], [["Large", 0], ["Medium", 1], ["Small", 2]]),
      },
      { kind: "toggle", label: "Transparency multisampling", key: D + "bTransparencyMultisampling" },
      { kind: "toggle", label: "Depth of field", key: "Imagespace.bDoDepthOfField" },
      {
        kind: "dropdown",
        label: "Radial blur",
        options: opts(["Imagespace.iRadialBlurLevel"], [["Off", 0], ["Low", 1], ["High", 2]]),
      },
      { kind: "slider", label: "Decals per frame", key: D + "iMaxDecalsPerFrame", min: 0, max: 50, step: 1 },
      { kind: "toggle", label: "3.0 grass shader", key: "Grass.b30GrassVS" },
    ],
  },
  {
    title: "Shadows",
    controls: [
      { kind: "toggle", label: "Shadows", key: D + "bDrawShadows" },
      {
        kind: "dropdown",
        label: "Shadow quality",
        options: opts([D + "iShadowMapResolution"], [["Low (256)", 256], ["Medium (512)", 512], ["High (1024)", 1024]]),
      },
      {
        kind: "dropdown",
        label: "Shadow filtering",
        options: opts([D + "iShadowFilter"], [["Low", 0], ["Medium", 1], ["High", 2]]),
      },
      { kind: "slider", label: "Interior actor shadows", key: D + "iActorShadowCountInt", min: 0, max: 10, step: 1 },
      { kind: "slider", label: "Exterior actor shadows", key: D + "iActorShadowCountExt", min: 0, max: 10, step: 1 },
    ],
  },
  {
    title: "Water",
    controls: [
      { kind: "toggle", label: "Refractions", key: "Water.bUseWaterRefractions" },
      { kind: "toggle", label: "Reflections", key: "Water.bUseWaterReflections" },
      { kind: "toggle", label: "Reflection blur", key: "Water.bUseWaterReflectionBlur" },
      { kind: "toggle", label: "Displacement", key: "Water.bUseWaterDisplacements" },
      { kind: "toggle", label: "Depth fog", key: "Water.bUseWaterDepth" },
      { kind: "toggle", label: "Reflect explosions", key: "Water.bReflectExplosions" },
      { kind: "toggle", label: "High-detail reflections", key: "Water.bForceHighDetailReflections" },
      { kind: "toggle", label: "Silhouette reflections", key: "Water.bAutoWaterSilhouetteReflections" },
      {
        kind: "dropdown",
        label: "Reflection size",
        options: opts(["Water.iWaterReflectWidth", "Water.iWaterReflectHeight"], [["256", 256], ["512", 512], ["1024", 1024]]),
      },
      { kind: "slider", label: "Reflection blur amount", key: "Water.iWaterBlurAmount", min: 0, max: 4, step: 1 },
    ],
  },
  {
    title: "Distance",
    controls: [
      { kind: "slider", label: "Actor fade", key: "LOD.fLODFadeOutMultActors", min: 1, max: 15, step: 0.5 },
      { kind: "slider", label: "Object fade", key: "LOD.fLODFadeOutMultObjects", min: 1, max: 15, step: 0.5 },
      { kind: "slider", label: "Item fade", key: "LOD.fLODFadeOutMultItems", min: 1, max: 15, step: 0.5 },
      { kind: "slider", label: "Grass fade", key: "Grass.fGrassStartFadeDistance", min: 0, max: 10000, step: 250 },
      { kind: "slider", label: "Specular distance", key: D + "fSpecularLODStartFade", min: 0, max: 5000, step: 100 },
      { kind: "slider", label: "Light fade", key: D + "fLightLODStartFade", min: 0, max: 5000, step: 100 },
      { kind: "slider", label: "Shadow fade", key: D + "fShadowLODStartFade", min: 0, max: 5000, step: 20 },
      { kind: "slider", label: "Tree LOD fade", key: "TerrainManager.fTreeLoadDistance", min: 0, max: 75000, step: 1000 },
      { kind: "slider", label: "Distant LOD", key: "TerrainManager.fBlockLoadDistanceLow", min: 10000, max: 100000, step: 5000 },
      { kind: "slider", label: "Land quality", key: "TerrainManager.fSplitDistanceMult", min: 0.5, max: 2, step: 0.05 },
    ],
  },
];

const SHORT: Record<string, string> = { low: "Low", medium: "Med", high: "High", veryhigh: "V.High" };
const fmt = (n: number) => String(Number(n.toFixed(2)));

interface Stop {
  value: number;
  label: string;
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// Slider stops are the real preset values, lowest preset to highest. Presets sharing a
// value share a stop ("Low/Med"); a current value no preset uses gets a "Yours" stop.
function presetStops(
  key: string,
  presets: { id: string; values?: Values }[],
  cur: number | null | undefined,
): Stop[] {
  const stops: Stop[] = [];
  for (const p of presets) {
    const val = p.values?.[key];
    if (typeof val !== "number" || !isFinite(val)) continue;
    const hit = stops.find((st) => same(st.value, val));
    if (hit) hit.label += "/" + SHORT[p.id];
    else stops.push({ value: val, label: SHORT[p.id] });
  }
  if (typeof cur === "number" && isFinite(cur) && !stops.some((st) => same(st.value, cur))) {
    stops.push({ value: cur, label: "Yours" });
  }
  return stops.sort((a, b) => a.value - b.value);
}

function snap(n: number, min: number, step: number): number {
  return Number((Math.round((n - min) / step) * step + min).toFixed(4));
}

function selectedIndex(c: Extract<Control, { kind: "dropdown" }>, list: DropdownOpt[], v: Values): number {
  if (c.selected) return c.selected(v);
  return list.findIndex((o) => Object.entries(o.set).every(([k, val]) => v[k] === val));
}

// ---------------------------------------------------------------- panel

function Content() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({ Display: true });
  const [sliders, setSliders] = useState<Record<string, number>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const mounted = useRef(true);

  const take = (r: Result, okMessage?: string) => {
    if (!mounted.current) return;
    if (r.ok) {
      setState(r);
      setError(null);
      if (okMessage) toast(okMessage);
    } else {
      toast(r.error);
      refresh();
    }
  };

  const refresh = async () => {
    const r = await getState();
    if (!mounted.current) return;
    if (r.ok) {
      setState(r);
      setError(null);
    } else {
      setError(r.error);
    }
  };

  useEffect(() => {
    mounted.current = true;
    // No polling: the game check runs when the panel opens and on every write
    // (the backend refuses writes while the game runs), so idle cost is zero.
    refresh();
    return () => {
      mounted.current = false;
      Object.values(timers.current).forEach(clearTimeout);
    };
  }, []);

  if (error) {
    return (
      <PanelSection title="FNV Settings">
        <PanelSectionRow>{error}</PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={refresh}>Retry</ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }
  if (!state) {
    return (
      <PanelSection>
        <PanelSectionRow>Loading…</PanelSectionRow>
      </PanelSection>
    );
  }

  const v = state.values;
  const locked = state.gameRunning;

  const write = async (values: Record<string, number | boolean>, label: string) => {
    take(await setValuesCall(values), label);
  };

  // Sliders send many changes while dragging; write once they settle.
  const slide = (key: string, label: string, value: number) => {
    setSliders((s) => ({ ...s, [key]: value }));
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(async () => {
      delete timers.current[key];
      await write({ [key]: value }, `${label}: ${fmt(value)}`);
      if (!mounted.current) return;
      setSliders((s) => {
        const { [key]: _, ...rest } = s;
        return rest;
      });
    }, 600);
  };

  const shipped = state.presets.filter((p) => p.id in SHORT && p.values && typeof p.values === "object");
  // "Low 2.5 · Med 2.5 · High 6 · V.High 15": what each shipped preset uses for a control.
  const describe = (label: (pv: Values) => string | null) => {
    const parts = shipped.map((p) => {
      const l = label(p.values as Values);
      return l === null ? null : `${SHORT[p.id]} ${l}`;
    });
    return parts.every((x) => x === null) ? undefined : parts.filter(Boolean).join(" · ");
  };

  const render = (c: Control) => {
    if (c.kind === "toggle") {
      const on = Boolean(v[c.key]) !== Boolean(c.invert);
      return (
        <ToggleField
          label={c.label}
          description={describe((pv) =>
            typeof pv[c.key] === "number" ? (Boolean(pv[c.key]) !== Boolean(c.invert) ? "on" : "off") : null,
          )}
          checked={on}
          disabled={locked}
          onChange={(checked: boolean) => write({ [c.key]: checked !== Boolean(c.invert) }, `${c.label}: ${checked ? "on" : "off"}`)}
        />
      );
    }
    if (c.kind === "slider") {
      const cur = sliders[c.key] ?? v[c.key];
      const stops = presetStops(c.key, shipped, v[c.key]);
      const description = describe((pv) => (typeof pv[c.key] === "number" ? fmt(pv[c.key] as number) : null));
      if (stops.length >= 2) {
        const at = typeof cur === "number" ? stops.findIndex((st) => same(st.value, cur)) : -1;
        return (
          <SliderField
            label={typeof cur === "number" ? `${c.label}: ${fmt(cur)}` : c.label}
            description={description}
            value={Math.max(0, at)}
            min={0}
            max={stops.length - 1}
            step={1}
            notchCount={stops.length}
            notchLabels={stops.map((st, i) => ({ notchIndex: i, label: st.label, value: i }))}
            notchTicksVisible
            disabled={locked}
            onChange={(i: number) => {
              const st = stops[Math.round(i)];
              if (st && !(typeof cur === "number" && same(st.value, cur))) slide(c.key, c.label, st.value);
            }}
          />
        );
      }
      // Presets unavailable: plain slider over the allowed range.
      const raw = typeof cur === "number" ? cur : c.min;
      return (
        <SliderField
          label={c.label}
          description={description}
          value={Math.min(c.max, Math.max(c.min, raw))}
          min={c.min}
          max={c.max}
          step={c.step}
          showValue
          disabled={locked}
          onChange={(n: number) => {
            if (typeof n === "number" && isFinite(n)) slide(c.key, c.label, Math.min(c.max, Math.max(c.min, snap(n, c.min, c.step))));
          }}
        />
      );
    }
    const list = c.options(v, state);
    const idx = selectedIndex(c, list, v);
    return (
      <DropdownItem
        label={c.label}
        description={describe((pv) => {
          const i = selectedIndex(c, list, pv);
          return i >= 0 && list[i] ? list[i].label : null;
        })}
        rgOptions={list.map((o, i) => ({ data: i, label: o.label }))}
        selectedOption={idx >= 0 ? idx : null}
        strDefaultLabel="Custom value"
        disabled={locked}
        onChange={(o) => {
          const picked = list[o?.data];
          if (picked) write(picked.set, `${c.label}: ${picked.label}`);
        }}
      />
    );
  };

  const presetName = (id: string) => state.presets.find((p) => p.id === id)?.name ?? id;

  return (
    <>
      {locked && (
        <PanelSection>
          <PanelSectionRow>Close New Vegas first. The game overwrites these settings when it exits.</PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={refresh}>
              Check again
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}
      <PanelSection title="Preset">
        <PanelSectionRow>
          <DropdownItem
            label="Preset"
            rgOptions={state.presets.map((p) => ({ data: p.id, label: p.name }))}
            selectedOption={state.matching}
            strDefaultLabel="Modified"
            disabled={locked}
            onChange={async (o) => {
              if (typeof o?.data === "string") take(await applyPresetCall(o.data), `Applied ${presetName(o.data)}`);
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={locked}
            onClick={() =>
              showModal(
                <ConfirmModal
                  strTitle="Save as Custom preset?"
                  strDescription="This replaces your Custom preset (Custom.ini in the game folder) with the current settings."
                  strOKButtonText="Save"
                  onOK={async () => take(await saveCustomCall(), "Saved current settings as Custom")}
                />,
              )
            }
          >
            Save current as Custom
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
      {SECTIONS.map((s) => (
        <PanelSection key={s.title} title={s.title}>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setOpen((o) => ({ ...o, [s.title]: !o[s.title] }))}>
              {open[s.title] ? "Hide" : "Show"}
            </ButtonItem>
          </PanelSectionRow>
          {open[s.title] &&
            s.controls.map((c) => <PanelSectionRow key={c.label}>{render(c)}</PanelSectionRow>)}
        </PanelSection>
      ))}
    </>
  );
}

// Last line of defence: a rendering bug shows a message instead of breaking the Steam UI.
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("FNV Settings crashed", error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <PanelSection title="FNV Settings">
        <PanelSectionRow>Something went wrong showing the settings.</PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => this.setState({ failed: false })}>
            Reload
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }
}

export default definePlugin(() => ({
  name: "FNV Settings",
  titleView: <div className={staticClasses.Title}>FNV Settings</div>,
  content: (
    <Boundary>
      <Content />
    </Boundary>
  ),
  icon: <FaSlidersH />,
}));
