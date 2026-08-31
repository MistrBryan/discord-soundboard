// Custom themes.
//
// A theme is a JSON map of colour tokens, NOT a stylesheet. That is a security
// decision, not a convenience one: themes get shared between users, and an
// uploaded .css file in Electron can phone home through `url()` — leaking the
// viewer's IP the moment it renders — and can restyle the app into
// impersonating a dialog it isn't. Neither is possible when the only thing a
// theme may contain is a colour string that has been matched against a pattern
// before it is ever applied.
//
// Every value is validated before use, unknown keys are ignored so old themes
// keep working, and missing keys fall back to the base palette, so a theme can
// override just an accent colour if that is all it wants to change.

export const TOKENS = [
  "bg",
  "panel",
  "panel-2",
  "line",
  "line-hover",
  "text",
  "muted",
  "accent",
  "on-accent",
  "danger",
  "danger-line",
  "danger-bg",
  "danger-glow",
  "ok",
  "ok-glow",
  "ok-line",
  "warn",
  "warn-bg",
  "warn-line",
  "meter-track",
  "wave",
  "wave-dim",
  "overlay",
  "backdrop",
  "shadow",
];

const TOKEN_SET = new Set(TOKENS);

// Deliberately strict. Anything with a function call other than rgb/hsl, any
// semicolon, any url(), any escape — rejected rather than sanitised, because
// sanitising is where these things go wrong.
const COLOUR = new RegExp(
  [
    "^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$",
    "^rgba?\\(\\s*[0-9.]+\\s*,\\s*[0-9.]+\\s*,\\s*[0-9.]+\\s*(?:,\\s*[0-9.]+\\s*)?\\)$",
    "^rgba?\\(\\s*[0-9.]+%?\\s+[0-9.]+%?\\s+[0-9.]+%?\\s*(?:/\\s*[0-9.]+%?\\s*)?\\)$",
    "^hsla?\\(\\s*[0-9.]+(?:deg)?\\s*,\\s*[0-9.]+%\\s*,\\s*[0-9.]+%\\s*(?:,\\s*[0-9.]+\\s*)?\\)$",
    "^transparent$",
  ].join("|"),
  "i"
);

const MAX_VALUE_LENGTH = 64;
const MAX_NAME_LENGTH = 40;

/**
 * @returns {{ ok: true, theme: {name, base, colors} } | { ok: false, errors: string[] }}
 */
export function validateTheme(input) {
  const errors = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["Not a theme file — expected a JSON object."] };
  }

  const name = String(input.name ?? "").trim().slice(0, MAX_NAME_LENGTH);
  if (!name) errors.push('Missing a "name".');

  const base = input.base === "light" ? "light" : "dark";

  const colors = {};
  const source = input.colors && typeof input.colors === "object" ? input.colors : null;
  if (!source) {
    errors.push('Missing a "colors" object.');
  } else {
    for (const [key, raw] of Object.entries(source)) {
      // Unknown keys are skipped rather than rejected, so a theme written for a
      // later version still loads here.
      if (!TOKEN_SET.has(key)) continue;
      const value = String(raw).trim();
      if (value.length > MAX_VALUE_LENGTH || !COLOUR.test(value)) {
        errors.push(`"${key}" is not a plain colour value.`);
        continue;
      }
      colors[key] = value;
    }
    if (Object.keys(colors).length === 0) errors.push("No usable colours found.");
  }

  return errors.length ? { ok: false, errors } : { ok: true, theme: { name, base, colors } };
}

/**
 * Apply a validated theme, or pass null to clear back to the built-in palettes.
 * Custom properties are set inline on the root element, which outranks the
 * stylesheet's :root block; `base` decides what any token the theme omits falls
 * back to.
 */
export function applyCustomTheme(theme) {
  const root = document.documentElement;
  for (const token of TOKENS) root.style.removeProperty(`--${token}`);

  if (!theme) return;
  root.setAttribute("data-theme", theme.base);
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${key}`, value);
  }
}

/** The palette currently in force, as a theme file the user can edit and re-import. */
export function exportCurrentTheme(name) {
  const computed = getComputedStyle(document.documentElement);
  const colors = {};
  for (const token of TOKENS) {
    const value = computed.getPropertyValue(`--${token}`).trim();
    if (value) colors[token] = value;
  }
  return {
    name: name || "My theme",
    base: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
    colors,
  };
}
