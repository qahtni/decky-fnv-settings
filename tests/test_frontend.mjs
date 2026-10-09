// Frontend tests for the built bundle (dist/index.js), run with: node tests/test_frontend.mjs
// The bundle is loaded the way Decky loads it, against mock SP_REACT / SP_JSX / DFL
// globals and a fake backend, then rendered with a tiny hooks renderer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "dist/index.js");

// ------------------------------------------------------------ mini React

const Fragment = Symbol("Fragment");
let hooks = new Map(); // path -> hook slots
let cursor = { path: "", i: 0 };
let dirty = false;
let pendingEffects = [];

function el(type, props, key) {
  return { type, props: props ?? {}, key };
}
function createElement(type, props, ...children) {
  const p = { ...(props ?? {}) };
  if (children.length) p.children = children.length === 1 ? children[0] : children;
  return el(type, p, p.key);
}
function slot(init) {
  const list = hooks.get(cursor.path) ?? [];
  hooks.set(cursor.path, list);
  const i = cursor.i++;
  if (!(i in list)) list[i] = init();
  return list[i];
}
class Component {
  constructor(props) {
    this.props = props;
  }
  setState(update) {
    this.state = { ...this.state, ...(typeof update === "function" ? update(this.state) : update) };
    dirty = true;
  }
}
const React = {
  Component,
  createElement,
  Fragment,
  createContext: (value) => ({ Provider: ({ children }) => children, Consumer: ({ children }) => children(value) }),
  useState(initial) {
    const s = slot(() => ({ value: typeof initial === "function" ? initial() : initial }));
    s.set ??= (v) => {
      s.value = typeof v === "function" ? v(s.value) : v;
      dirty = true;
    };
    return [s.value, s.set];
  },
  useRef: (initial) => slot(() => ({ current: initial })),
  useEffect(fn, deps) {
    const s = slot(() => ({ deps: undefined, cleanup: undefined }));
    const changed = !deps || !s.deps || deps.some((d, i) => d !== s.deps[i]);
    if (changed) {
      s.deps = deps;
      pendingEffects.push(() => {
        s.cleanup?.();
        s.cleanup = fn();
      });
    }
  },
};

// Host components from @decky/ui are kept in the tree as named nodes.
const host = (name) => Object.assign(function () {}, { host: name });
const DFL = new Proxy(
  {
    staticClasses: { Title: "Title" },
    showModal: (node) => modals.push(node),
  },
  { get: (t, k) => (k in t ? t[k] : (t[k] = host(String(k)))) },
);

function render(node, path = "r") {
  if (node == null || node === false || node === true) return null;
  if (Array.isArray(node)) return node.map((n, i) => render(n, `${path}.${n?.key ?? i}`));
  if (typeof node !== "object") return node;
  const { type, props } = node;
  if (type === Fragment) return render(props.children, path);
  if (typeof type === "function" && type.host) {
    return { host: type.host, props, children: render(props.children, path + "/" + type.host) };
  }
  if (typeof type === "function" && type.prototype instanceof Component) {
    const p = `${path}/${type.name}`;
    const store = hooks.get(p + "#inst") ?? [new type(props)];
    hooks.set(p + "#inst", store);
    const c = store[0];
    c.props = props;
    try {
      return render(c.render(), p);
    } catch (e) {
      if (!type.getDerivedStateFromError) throw e;
      c.state = { ...c.state, ...type.getDerivedStateFromError(e) };
      c.componentDidCatch?.(e, {});
      caught.push(e);
      return render(c.render(), p);
    }
  }
  if (typeof type === "function") {
    const p = `${path}/${type.name || "anon"}`;
    const saved = cursor;
    cursor = { path: p, i: 0 };
    const out = type(props);
    cursor = saved;
    return render(out, p);
  }
  return { host: type, props, children: render(props.children, path + "/" + type) };
}

let rootNode;
const caught = [];
let tree;
async function flush() {
  for (let n = 0; n < 50; n++) {
    await new Promise((r) => setTimeout(r, 0));
    if (!dirty && !pendingEffects.length && tree) return;
    dirty = false;
    tree = render(rootNode);
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach((f) => f());
  }
  throw new Error("render did not settle");
}
function unmount() {
  for (const list of hooks.values()) for (const s of list) s?.cleanup?.();
  hooks = new Map();
}
async function remount() {
  unmount();
  tree = undefined;
  await flush();
}

function* walk(n) {
  if (!n) return;
  if (Array.isArray(n)) {
    for (const c of n) yield* walk(c);
    return;
  }
  if (typeof n !== "object") return;
  yield n;
  yield* walk(n.children);
}
const all = (hostName) => [...walk(tree)].filter((n) => n.host === hostName);
const byLabel = (hostName, label) => {
  const found = all(hostName).find((n) => n.props.label === label);
  assert.ok(found, `${hostName} "${label}" not rendered`);
  return found;
};
function text(n) {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(text).join("");
  return text(n.children);
}
const button = (label) => {
  const b = all("ButtonItem").find((n) => text(n.children) === label || n.props.children === label);
  assert.ok(b, `button "${label}" not rendered`);
  return b;
};

// ------------------------------------------------------------ fake backend

const RES = [[1280, 800], [1440, 900], [1680, 1050], [1920, 1200], [2560, 1600], [1280, 720], [1366, 768], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160]];
// Values from the game's shipped preset files (subset).
const PRESET_VALUES = {
  low: { "Display.iMultiSample": 1, "Display.iWaterMultisamples": 1, "Display.iMaxAnisotropy": 1, "Display.iMaxDecalsPerFrame": 2,
    "Display.iActorShadowCountInt": 2, "Display.iActorShadowCountExt": 2, "Display.bDrawShadows": 0, "Display.iShadowMapResolution": 256,
    "LOD.fLODFadeOutMultActors": 2.5, "LOD.fLODFadeOutMultObjects": 2.5, "LOD.fLODFadeOutMultItems": 3, "Grass.fGrassStartFadeDistance": 0,
    "Display.fSpecularLODStartFade": 200, "Display.fLightLODStartFade": 200, "Display.fShadowLODStartFade": 100,
    "TerrainManager.fTreeLoadDistance": 0, "TerrainManager.fBlockLoadDistanceLow": 25000, "TerrainManager.fSplitDistanceMult": 0.75,
    "Water.iWaterBlurAmount": 0, "BlurShaderHDR.bDoHighDynamicRange": 0 },
  medium: { "Display.iMultiSample": 1, "Display.iWaterMultisamples": 1, "Display.iMaxAnisotropy": 1, "Display.iMaxDecalsPerFrame": 5,
    "Display.iActorShadowCountInt": 4, "Display.iActorShadowCountExt": 2, "Display.bDrawShadows": 1, "Display.iShadowMapResolution": 256,
    "LOD.fLODFadeOutMultActors": 2.5, "LOD.fLODFadeOutMultObjects": 2.5, "LOD.fLODFadeOutMultItems": 3.5, "Grass.fGrassStartFadeDistance": 3000,
    "Display.fSpecularLODStartFade": 500, "Display.fLightLODStartFade": 1000, "Display.fShadowLODStartFade": 200,
    "TerrainManager.fTreeLoadDistance": 25000, "TerrainManager.fBlockLoadDistanceLow": 50000, "TerrainManager.fSplitDistanceMult": 1,
    "Water.iWaterBlurAmount": 0, "BlurShaderHDR.bDoHighDynamicRange": 1 },
  high: { "Display.iMultiSample": 4, "Display.iWaterMultisamples": 4, "Display.iMaxAnisotropy": 8, "Display.iMaxDecalsPerFrame": 10,
    "Display.iActorShadowCountInt": 4, "Display.iActorShadowCountExt": 2, "Display.bDrawShadows": 1, "Display.iShadowMapResolution": 512,
    "LOD.fLODFadeOutMultActors": 6, "LOD.fLODFadeOutMultObjects": 7.5, "LOD.fLODFadeOutMultItems": 4.5, "Grass.fGrassStartFadeDistance": 5000,
    "Display.fSpecularLODStartFade": 1000, "Display.fLightLODStartFade": 2500, "Display.fShadowLODStartFade": 460,
    "TerrainManager.fTreeLoadDistance": 26000, "TerrainManager.fBlockLoadDistanceLow": 50000, "TerrainManager.fSplitDistanceMult": 1,
    "Water.iWaterBlurAmount": 2, "BlurShaderHDR.bDoHighDynamicRange": 1 },
  veryhigh: { "Display.iMultiSample": 4, "Display.iWaterMultisamples": 4, "Display.iMaxAnisotropy": 15, "Display.iMaxDecalsPerFrame": 10,
    "Display.iActorShadowCountInt": 6, "Display.iActorShadowCountExt": 6, "Display.bDrawShadows": 1, "Display.iShadowMapResolution": 1024,
    "LOD.fLODFadeOutMultActors": 15, "LOD.fLODFadeOutMultObjects": 15, "LOD.fLODFadeOutMultItems": 15, "Grass.fGrassStartFadeDistance": 7000,
    "Display.fSpecularLODStartFade": 2000, "Display.fLightLODStartFade": 3500, "Display.fShadowLODStartFade": 1000,
    "TerrainManager.fTreeLoadDistance": 40000, "TerrainManager.fBlockLoadDistanceLow": 50000, "TerrainManager.fSplitDistanceMult": 1.5,
    "Water.iWaterBlurAmount": 4, "BlurShaderHDR.bDoHighDynamicRange": 1 },
};
const calls = [];
const toasts = [];
const modals = [];
let backend;

function freshBackend() {
  const values = {
    "Display.iSize W": 1280, "Display.iSize H": 800, "Display.iMultiSample": 4, "Display.iWaterMultisamples": 4,
    "Display.iMaxAnisotropy": 8, "Display.bFull Screen": 0, "Display.iPresentInterval": 0,
    "BlurShaderHDR.bDoHighDynamicRange": 1, "BlurShader.bUseBlurShader": 0, "Display.iTexMipMapSkip": 0,
    "Display.bTransparencyMultisampling": 1, "Imagespace.bDoDepthOfField": 1, "Imagespace.iRadialBlurLevel": 2,
    "Display.iMaxDecalsPerFrame": 10, "Grass.b30GrassVS": 1, "Display.bDrawShadows": 1,
    "Display.iShadowMapResolution": 1024, "Display.iShadowFilter": 2, "Display.iActorShadowCountInt": 4,
    "Display.iActorShadowCountExt": 2, "Water.bUseWaterRefractions": 1, "Water.bUseWaterReflections": 1,
    "Water.bUseWaterReflectionBlur": 1, "Water.bUseWaterDisplacements": 1, "Water.bUseWaterDepth": 1,
    "Water.bReflectExplosions": 0, "Water.bForceHighDetailReflections": 1, "Water.bAutoWaterSilhouetteReflections": 0,
    "Water.iWaterReflectWidth": 1024, "Water.iWaterReflectHeight": 1024, "Water.iWaterBlurAmount": 4,
    "LOD.fLODFadeOutMultActors": 15, "LOD.fLODFadeOutMultObjects": 7.5, "LOD.fLODFadeOutMultItems": 4.5,
    "Grass.fGrassStartFadeDistance": 5000, "Display.fSpecularLODStartFade": 1000, "Display.fLightLODStartFade": 2500,
    "Display.fShadowLODStartFade": 460, "TerrainManager.fTreeLoadDistance": 26000,
    "TerrainManager.fBlockLoadDistanceLow": 50000, "TerrainManager.fSplitDistanceMult": 1,
  };
  return {
    values,
    gameRunning: false,
    matching: "custom",
    fail: null,
    state() {
      return {
        ok: true, values: { ...this.values }, matching: this.matching, gameRunning: this.gameRunning, resolutions: RES,
        presets: [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["veryhigh", "Very High"], ["custom", "Custom (yours)"]]
          .map(([id, name]) => ({ id, name, values: PRESET_VALUES[id] ?? { ...this.values } })),
      };
    },
    call(name, args) {
      calls.push([name, args]);
      if (this.fail && name !== "get_state") return { ok: false, error: this.fail };
      if (name === "set_values") {
        for (const [k, v] of Object.entries(args[0])) this.values[k] = typeof v === "boolean" ? Number(v) : v;
        this.matching = null;
      } else if (name === "apply_preset") {
        Object.assign(this.values, PRESET_VALUES[args[0]] ?? {});
        this.matching = args[0];
      }
      return this.state();
    },
  };
}

globalThis.window = globalThis;
globalThis.SP_REACT = React;
globalThis.SP_JSX = { jsx: el, jsxs: el, Fragment };
globalThis.DFL = DFL;
let connectedAs;
window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit = {
  connect(version, name) {
    connectedAs = { version, name };
    return {
      _version: version,
      callable: (fn) => async (...args) => backend.call(fn, args),
      toaster: { toast: (t) => toasts.push(t) },
    };
  },
};

// ------------------------------------------------------------ tests

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function mountPlugin() {
  unmount();
  tree = undefined;
  calls.length = toasts.length = modals.length = 0;
  backend = freshBackend();
  const mod = await import(pathToFileURL(bundle).href);
  const plugin = mod.default();
  rootNode = plugin.content;
  await flush();
  return plugin;
}
const lastSet = () => calls.filter(([n]) => n === "set_values").at(-1)?.[1][0];

test("bundle passes node --check", () => {
  execFileSync(process.execPath, ["--check", bundle]);
});

test("plugin definition and API connection", async () => {
  const plugin = await mountPlugin();
  assert.equal(plugin.name, "FNV Settings");
  assert.ok(plugin.icon && plugin.titleView);
  assert.equal(connectedAs.name, "FNV Settings");
  assert.deepEqual(calls[0], ["get_state", []]);
  unmount();
});

test("uses only stock @decky/ui components", async () => {
  await mountPlugin();
  const used = new Set([...walk(tree)].filter((n) => typeof n.host === "string" && n.host[0] === n.host[0].toUpperCase()).map((n) => n.host));
  const allowed = ["PanelSection", "PanelSectionRow", "ButtonItem", "DropdownItem", "ToggleField", "SliderField", "ConfirmModal"];
  for (const u of used) assert.ok(allowed.includes(u), `unexpected component ${u}`);
  unmount();
});

test("all sections render, collapsed except Display", async () => {
  await mountPlugin();
  const titles = all("PanelSection").map((s) => s.props.title);
  assert.deepEqual(titles, ["Preset", "Display", "Detail", "Shadows", "Water", "Distance"]);
  byLabel("DropdownItem", "Resolution");
  assert.equal(all("ToggleField").find((n) => n.props.label === "Refractions"), undefined);
  for (const b of all("ButtonItem").filter((n) => n.props.children === "Show")) b.props.onClick();
  await flush();
  for (const label of ["Texture size", "Shadow quality", "Reflection size"]) byLabel("DropdownItem", label);
  for (const label of ["Refractions", "Shadows", "Depth of field"]) byLabel("ToggleField", label);
  for (const label of ["Actor fade", "Land quality", "Decals per frame"]) {
    assert.ok(all("SliderField").some((n) => n.props.label.startsWith(label + ": ")), label);
  }
  unmount();
});

test("current values are shown", async () => {
  await mountPlugin();
  const res = byLabel("DropdownItem", "Resolution");
  assert.equal(res.props.rgOptions[res.props.selectedOption].label, "1280×800 (16:10)");
  assert.equal(res.props.rgOptions.filter((o) => o.label.includes("16:9")).length, 6);
  const aa = byLabel("DropdownItem", "Anti-aliasing");
  assert.equal(aa.props.rgOptions[aa.props.selectedOption].label, "4x MSAA");
  const af = byLabel("DropdownItem", "Anisotropic filtering");
  assert.equal(af.props.rgOptions[af.props.selectedOption].label, "8x");
  assert.equal(byLabel("ToggleField", "Windowed").props.checked, true);
  assert.equal(byLabel("ToggleField", "VSync").props.checked, false);
  const fx = byLabel("DropdownItem", "Screen effect");
  assert.equal(fx.props.rgOptions[fx.props.selectedOption].label, "HDR");
  const preset = byLabel("DropdownItem", "Preset");
  assert.equal(preset.props.selectedOption, "custom");
  assert.equal(preset.props.rgOptions.at(-1).label, "Custom (yours)");
  unmount();
});

test("sample counts of 1 show as Off", async () => {
  await mountPlugin();
  backend.values["Display.iMultiSample"] = 1;
  backend.values["Display.iMaxAnisotropy"] = 1;
  await flush();
  await (async () => { const r = await backend.call("get_state", []); })();
  // Re-mount picks up the low-preset style values.
  await remount();
  for (const label of ["Anti-aliasing", "Anisotropic filtering"]) {
    const d = byLabel("DropdownItem", label);
    assert.equal(d.props.rgOptions[d.props.selectedOption].label, "Off");
  }
  unmount();
});

test("dropdowns write the right keys", async () => {
  await mountPlugin();
  const pick = async (label, optionLabel) => {
    const d = byLabel("DropdownItem", label);
    const opt = d.props.rgOptions.find((o) => o.label === optionLabel);
    assert.ok(opt, `${label} has no option ${optionLabel}`);
    d.props.onChange(opt);
    await flush();
    return lastSet();
  };
  assert.deepEqual(await pick("Resolution", "2560×1440 (16:9)"), { "Display.iSize W": 2560, "Display.iSize H": 1440 });
  assert.deepEqual(await pick("Anti-aliasing", "2x MSAA"), { "Display.iMultiSample": 2, "Display.iWaterMultisamples": 2 });
  assert.deepEqual(await pick("Anti-aliasing", "Off"), { "Display.iMultiSample": 0, "Display.iWaterMultisamples": 0 });
  assert.deepEqual(await pick("Anisotropic filtering", "15x"), { "Display.iMaxAnisotropy": 15 });
  assert.deepEqual(await pick("Screen effect", "Bloom"), { "BlurShaderHDR.bDoHighDynamicRange": 0, "BlurShader.bUseBlurShader": 1 });
  for (const b of all("ButtonItem").filter((n) => n.props.children === "Show")) b.props.onClick();
  await flush();
  assert.deepEqual(await pick("Texture size", "Small"), { "Display.iTexMipMapSkip": 2 });
  assert.deepEqual(await pick("Shadow quality", "Low (256)"), { "Display.iShadowMapResolution": 256 });
  assert.deepEqual(byLabel("DropdownItem", "Shadow quality").props.rgOptions.map((o) => o.label), ["Low (256)", "Medium (512)", "High (1024)"]);
  assert.deepEqual(await pick("Reflection size", "512"), { "Water.iWaterReflectWidth": 512, "Water.iWaterReflectHeight": 512 });
  // UI reflects the new values.
  const res = byLabel("DropdownItem", "Resolution");
  assert.equal(res.props.rgOptions[res.props.selectedOption].label, "2560×1440 (16:9)");
  assert.equal(byLabel("DropdownItem", "Preset").props.selectedOption, null);
  assert.equal(byLabel("DropdownItem", "Preset").props.strDefaultLabel, "Modified");
  assert.ok(toasts.some((t) => t.body === "Resolution: 2560×1440 (16:9)"));
  unmount();
});

test("toggles write booleans, Windowed is inverted", async () => {
  await mountPlugin();
  byLabel("ToggleField", "Windowed").props.onChange(false);
  await flush();
  assert.deepEqual(lastSet(), { "Display.bFull Screen": true });
  assert.equal(byLabel("ToggleField", "Windowed").props.checked, false);
  byLabel("ToggleField", "VSync").props.onChange(true);
  await flush();
  assert.deepEqual(lastSet(), { "Display.iPresentInterval": true });
  unmount();
});

test("preset dropdown applies preset", async () => {
  await mountPlugin();
  const d = byLabel("DropdownItem", "Preset");
  d.props.onChange(d.props.rgOptions.find((o) => o.label === "Very High"));
  await flush();
  assert.deepEqual(calls.at(-1), ["apply_preset", ["veryhigh"]]);
  assert.equal(byLabel("DropdownItem", "Preset").props.selectedOption, "veryhigh");
  assert.equal(toasts.at(-1).body, "Applied Very High");
  unmount();
});

test("save as Custom asks first", async () => {
  await mountPlugin();
  button("Save current as Custom").props.onClick();
  assert.equal(modals.length, 1);
  assert.equal(modals[0].type.host, "ConfirmModal");
  assert.ok(!calls.some(([n]) => n === "save_custom"));
  await modals[0].props.onOK();
  await flush();
  assert.deepEqual(calls.at(-1), ["save_custom", []]);
  assert.equal(toasts.at(-1).body, "Saved current settings as Custom");
  unmount();
});

test("game running disables everything", async () => {
  await mountPlugin();
  backend.gameRunning = true;
  await remount();
  assert.ok(text(tree).includes("Close New Vegas first"));
  for (const b of all("ButtonItem").filter((n) => n.props.children === "Show")) b.props.onClick();
  await flush();
  for (const host of ["DropdownItem", "ToggleField", "SliderField"]) {
    for (const n of all(host)) assert.equal(n.props.disabled, true, `${host} ${n.props.label} enabled`);
  }
  assert.equal(button("Save current as Custom").props.disabled, true);
  unmount();
});

test("backend errors become toasts and the panel reloads", async () => {
  await mountPlugin();
  backend.fail = "Close Fallout: New Vegas first.";
  byLabel("ToggleField", "VSync").props.onChange(true);
  await flush();
  assert.equal(toasts.at(-1).body, "Close Fallout: New Vegas first.");
  assert.equal(calls.at(-1)[0], "get_state");
  assert.equal(byLabel("ToggleField", "VSync").props.checked, false);
  unmount();
});

test("load error shows message and retry", async () => {
  unmount(); tree = undefined; calls.length = 0;
  backend = freshBackend();
  backend.call = function (name, args) {
    calls.push([name, args]);
    return { ok: false, error: "FalloutPrefs.ini not found. Launch New Vegas once through Steam first." };
  };
  const mod = await import(pathToFileURL(bundle).href);
  rootNode = mod.default().content;
  await flush();
  assert.ok(text(tree).includes("FalloutPrefs.ini not found"));
  button("Retry").props.onClick();
  await flush();
  assert.equal(calls.filter(([n]) => n === "get_state").length, 2);
  unmount();
});

test("no polling: idle panel makes no calls and sets no intervals", async () => {
  const realInterval = globalThis.setInterval;
  let intervals = 0;
  globalThis.setInterval = (...a) => (intervals++, realInterval(...a));
  try {
    await mountPlugin();
    const n = calls.length;
    assert.equal(n, 1); // the one get_state on open
    await new Promise((r) => setTimeout(r, 6000));
    await flush();
    assert.equal(calls.length, n);
    assert.equal(intervals, 0);
  } finally {
    globalThis.setInterval = realInterval;
    unmount();
  }
});

test("game started while open: next change is refused and the panel locks", async () => {
  await mountPlugin();
  backend.gameRunning = true;
  backend.fail = "Close Fallout: New Vegas first. It overwrites these settings when it exits.";
  byLabel("ToggleField", "VSync").props.onChange(true);
  await flush();
  assert.equal(toasts.at(-1).body, backend.fail);
  assert.ok(text(tree).includes("Close New Vegas first"));
  assert.equal(byLabel("ToggleField", "VSync").props.disabled, true);
  // After quitting, "Check again" unlocks.
  backend.gameRunning = false;
  backend.fail = null;
  button("Check again").props.onClick();
  await flush();
  assert.ok(!text(tree).includes("Close New Vegas first"));
  assert.equal(byLabel("ToggleField", "VSync").props.disabled, false);
  unmount();
});
test("rendering is wrapped in an error boundary", async () => {
  await mountPlugin();
  assert.equal(caught.length, 0);
  // A malformed preset entry makes the panel throw while rendering.
  backend.state = function () {
    const st = freshBackend().state();
    st.presets = [null];
    return st;
  };
  const errors = console.error;
  console.error = () => {};
  try {
    await remount();
  } finally {
    console.error = errors;
  }
  assert.equal(caught.length, 1);
  assert.ok(text(tree).includes("Something went wrong"));
  button("Reload");
  caught.length = 0;
  unmount();
});

test("backend exceptions and bad replies never throw", async () => {
  const errors = console.error;
  console.error = () => {};
  try {
    await mountPlugin();
    const good = freshBackend();
    backend.call = async (name) => { if (name === "get_state") return good.state(); throw new Error("socket closed"); };
    byLabel("ToggleField", "VSync").props.onChange(true);
    await flush();
    assert.equal(toasts.at(-1).body, "Plugin backend not responding. Try reloading Decky.");
    for (const reply of [undefined, null, 42, "x", { ok: true }, { ok: true, values: {} }, { ok: false }]) {
      backend.call = (name) => (name === "get_state" ? good.state() : reply);
      byLabel("ToggleField", "VSync").props.onChange(true);
      await flush();
      assert.equal(toasts.at(-1).body, "Unexpected reply from the plugin backend", JSON.stringify(reply));
    }
    // Initial load failing the same way shows the error page, not a crash.
    backend.call = async () => { throw new Error("down"); };
    await remount();
    assert.ok(text(tree).includes("Plugin backend not responding"));
    assert.equal(caught.length, 0);
  } finally {
    console.error = errors;
    unmount();
  }
});

test("bogus dropdown events are ignored", async () => {
  await mountPlugin();
  const before = calls.length;
  for (const o of [undefined, null, {}, { data: 99 }, { data: "x" }]) {
    byLabel("DropdownItem", "Resolution").props.onChange(o);
    byLabel("DropdownItem", "Preset").props.onChange(o === null ? null : { data: undefined });
  }
  await flush();
  assert.equal(calls.length, before);
  unmount();
});

test("no state updates after the panel closes", async () => {
  await mountPlugin();
  let release;
  backend.call = (name, args) => {
    calls.push([name, args]);
    return new Promise((r) => (release = () => r(freshBackend().state())));
  };
  byLabel("ToggleField", "VSync").props.onChange(true);
  unmount();
  dirty = false;
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(dirty, false);
  assert.equal(toasts.length, 0);
});

test("presets missing values do not break ranges", async () => {
  await mountPlugin();
  backend.state = function () {
    const st = freshBackend().state();
    st.presets = st.presets.map((p, i) => (i % 2 ? { id: p.id, name: p.name } : { ...p, values: null }));
    return st;
  };
  await remount();
  await showAll();
  assert.equal(caught.length, 0);
  const a = slider("Actor fade");
  assert.ok(a.props.max > a.props.min);
  unmount();
});

const showAll = async () => {
  for (const b of all("ButtonItem").filter((n) => n.props.children === "Show")) b.props.onClick();
  await flush();
};
const stopsOf = (sl) => sl.props.notchLabels.map((n) => n.label);
const slider = (prefix) => {
  const found = all("SliderField").find((n) => n.props.label.split(": ")[0] === prefix);
  assert.ok(found, `slider ${prefix} not rendered`);
  return found;
};

test("sliders stop at the real preset values, lowest to highest", async () => {
  await mountPlugin();
  await showAll();
  const expect = {
    "Actor fade": [["Low/Med", "High", "V.High"], "15"],
    "Object fade": [["Low/Med", "High", "V.High"], "7.5"],
    "Item fade": [["Low", "Med", "High", "V.High"], "4.5"],
    "Grass fade": [["Low", "Med", "High", "V.High"], "5000"],
    "Specular distance": [["Low", "Med", "High", "V.High"], "1000"],
    "Light fade": [["Low", "Med", "High", "V.High"], "2500"],
    "Shadow fade": [["Low", "Med", "High", "V.High"], "460"],
    "Tree LOD fade": [["Low", "Med", "High", "V.High"], "26000"],
    "Distant LOD": [["Low", "Med/High/V.High"], "50000"],
    "Land quality": [["Low", "Med/High", "V.High"], "1"],
    "Decals per frame": [["Low", "Med", "High/V.High"], "10"],
    "Interior actor shadows": [["Low", "Med/High", "V.High"], "4"],
    "Exterior actor shadows": [["Low/Med/High", "V.High"], "2"],
    "Reflection blur amount": [["Low/Med", "High", "V.High"], "4"],
  };
  for (const [label, [stops, value]] of Object.entries(expect)) {
    const sl = slider(label);
    assert.deepEqual(stopsOf(sl), stops, label);
    assert.deepEqual([sl.props.min, sl.props.max, sl.props.step, sl.props.notchCount], [0, stops.length - 1, 1, stops.length], label);
    assert.equal(sl.props.label.split(": ")[1], value, label);
    assert.equal(stopsOf(sl)[sl.props.value].length > 0, true);
  }
  assert.equal(slider("Actor fade").props.value, 2);
  assert.equal(slider("Object fade").props.value, 1);
  assert.equal(slider("Actor fade").props.description, "Low 2.5 · Med 2.5 · High 6 · V.High 15");
  assert.equal(byLabel("DropdownItem", "Anti-aliasing").props.description, "Low Off · Med Off · High 4x MSAA · V.High 4x MSAA");
  assert.equal(byLabel("ToggleField", "Shadows").props.description, "Low off · Med on · High on · V.High on");
  assert.equal(byLabel("DropdownItem", "Resolution").props.description, undefined);
  unmount();
});

test("a current value no preset uses gets its own stop", async () => {
  await mountPlugin();
  backend.values["TerrainManager.fBlockLoadDistanceLow"] = 80000;
  backend.values["LOD.fLODFadeOutMultActors"] = 3;
  await remount();
  await showAll();
  const d = slider("Distant LOD");
  assert.deepEqual(stopsOf(d), ["Low", "Med/High/V.High", "Yours"]);
  assert.equal(d.props.value, 2);
  const a = slider("Actor fade");
  assert.deepEqual(stopsOf(a), ["Low/Med", "Yours", "High", "V.High"]);
  assert.equal(a.props.value, 1);
  // Moving away from it and back to it writes the values.
  a.props.onChange(3);
  await new Promise((r) => setTimeout(r, 700));
  await flush();
  assert.deepEqual(lastSet(), { "LOD.fLODFadeOutMultActors": 15 });
  unmount();
});

test("sliders write the stop's value once after settling", async () => {
  await mountPlugin();
  await showAll();
  const before = calls.length;
  for (const i of [0, 1, 0.6]) {
    slider("Actor fade").props.onChange(i);
    await flush();
  }
  assert.equal(slider("Actor fade").props.value, 1);
  assert.equal(slider("Actor fade").props.label, "Actor fade: 6");
  assert.equal(calls.length, before);
  await new Promise((r) => setTimeout(r, 700));
  await flush();
  const writes = calls.slice(before).filter(([n]) => n === "set_values");
  assert.deepEqual(writes, [["set_values", [{ "LOD.fLODFadeOutMultActors": 6 }]]]);
  assert.equal(toasts.at(-1).body, "Actor fade: 6");
  // Out-of-range and current-value events write nothing.
  const n = calls.length;
  slider("Actor fade").props.onChange(1);
  slider("Actor fade").props.onChange(9);
  slider("Actor fade").props.onChange(-3);
  slider("Actor fade").props.onChange(NaN);
  await new Promise((r) => setTimeout(r, 700));
  await flush();
  assert.equal(calls.length, n);
  unmount();
});

test("without preset values, sliders fall back to the allowed range", async () => {
  await mountPlugin();
  backend.state = function () {
    const st = freshBackend().state();
    st.presets = st.presets.map((p) => ({ id: p.id, name: p.name }));
    return st;
  };
  await remount();
  await showAll();
  const lq = slider("Land quality");
  assert.deepEqual([lq.props.min, lq.props.max, lq.props.notchCount], [0.5, 2, undefined]);
  lq.props.onChange(0.8500000001);
  slider("Shadow fade").props.onChange(461.3);
  slider("Item fade").props.onChange(NaN);
  await new Promise((r) => setTimeout(r, 700));
  await flush();
  const writes = calls.filter(([n]) => n === "set_values").map(([, a]) => a[0]);
  assert.deepEqual(writes.sort((x, y) => Object.keys(x)[0].localeCompare(Object.keys(y)[0])), [
    { "Display.fShadowLODStartFade": 460 },
    { "TerrainManager.fSplitDistanceMult": 0.85 },
  ]);
  unmount();
});

test("applying a preset updates every control live, checkmarks included", async () => {
  await mountPlugin();
  await showAll();
  const pickPreset = async (name) => {
    const d = byLabel("DropdownItem", "Preset");
    d.props.onChange(d.props.rgOptions.find((o) => o.label === name));
    await flush();
  };
  await pickPreset("Low");
  assert.equal(byLabel("ToggleField", "Shadows").props.checked, false);
  assert.equal(slider("Actor fade").props.label, "Actor fade: 2.5");
  assert.equal(stopsOf(slider("Actor fade"))[slider("Actor fade").props.value], "Low/Med");
  assert.equal(stopsOf(slider("Grass fade"))[slider("Grass fade").props.value], "Low");
  let fx = byLabel("DropdownItem", "Screen effect");
  assert.equal(fx.props.rgOptions[fx.props.selectedOption].label, "None");
  await pickPreset("Medium");
  assert.equal(byLabel("ToggleField", "Shadows").props.checked, true);
  assert.equal(stopsOf(slider("Grass fade"))[slider("Grass fade").props.value], "Med");
  assert.equal(slider("Decals per frame").props.label, "Decals per frame: 5");
  const aa = byLabel("DropdownItem", "Anti-aliasing");
  assert.equal(aa.props.rgOptions[aa.props.selectedOption].label, "Off");
  const sq = byLabel("DropdownItem", "Shadow quality");
  assert.equal(sq.props.rgOptions[sq.props.selectedOption].label, "Low (256)");
  fx = byLabel("DropdownItem", "Screen effect");
  assert.equal(fx.props.rgOptions[fx.props.selectedOption].label, "HDR");
  assert.equal(byLabel("DropdownItem", "Preset").props.selectedOption, "medium");
  await pickPreset("Very High");
  assert.equal(stopsOf(slider("Actor fade"))[slider("Actor fade").props.value], "V.High");
  assert.equal(slider("Tree LOD fade").props.label, "Tree LOD fade: 40000");
  await pickPreset("Low");
  assert.equal(byLabel("ToggleField", "Shadows").props.checked, false);
  unmount();
});

test("slider pending when panel closes does not write after", async () => {
  await mountPlugin();
  await showAll();
  slider("Item fade").props.onChange(0);
  await flush();
  const n = calls.length;
  unmount();
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(calls.length, n);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.stack.split("\n").slice(0, 3).join("\n     ")}`);
    try { unmount(); } catch {}
  }
}
console.log(`\n${tests.length - failed}/${tests.length} frontend tests passed`);
process.exit(failed ? 1 : 0);
