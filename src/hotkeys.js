// Turning a browser KeyboardEvent into an Electron accelerator string.
//
// Everything keys off event.code rather than event.key, because event.key is
// whatever the modifiers produced — Shift+2 reports "@" on a US layout and
// something else entirely elsewhere. event.code is the physical key, which is
// what a global shortcut is really binding.

const CODE_NAMES = {
  Space: "Space",
  Escape: "Escape",
  Enter: "Return",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
  NumpadEnter: "Return",
};

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

function keyNameFor(code) {
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return null;
}

// A bare letter registered globally would be stolen from every other
// application on the machine, so plain keys need a modifier. Function keys and
// the numpad are the traditional exceptions — nobody types with those.
function needsModifier(code) {
  return !/^F([1-9]|1[0-9]|2[0-4])$/.test(code) && !code.startsWith("Numpad");
}

/** @returns {{accelerator: string} | {error: string}} */
export function accelFromEvent(event) {
  if (MODIFIER_CODES.test(event.code)) return { error: "Hold a modifier and press a key" };

  const key = keyNameFor(event.code);
  if (!key) return { error: "That key can't be bound" };

  const parts = [];
  if (event.ctrlKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");

  if (parts.length === 0 && needsModifier(event.code)) {
    return { error: "Add Ctrl, Alt, or Shift — a bare key would be stolen from every app" };
  }

  parts.push(key);
  return { accelerator: parts.join("+") };
}

/** Human-readable form for buttons and labels. */
export function formatAccelerator(accelerator) {
  if (!accelerator) return "";
  return accelerator
    .split("+")
    .map((part) => {
      if (part === "CommandOrControl") return "Ctrl";
      if (part === "Super") return "Win";
      if (part.startsWith("num")) return part.replace("num", "Num ");
      return part;
    })
    .join(" + ");
}
