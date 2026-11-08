// First-party Files-panel creation operations. Names are validated before use.
// File contents never travel through shell arguments.
const INVALID = /[\x00-\x1f\x7f/\\]/;
const WIN_INVALID = /[<>:"|?*]/;
const WIN_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function windowsPath(path) {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\");
}

export function validateNewName(name, windows = false) {
  if (typeof name !== "string" || !name.trim()) return "Enter a name";
  if (name === "." || name === "..") return "Choose a different name";
  if (INVALID.test(name)) return "Names cannot contain separators or control characters";
  if (windows && (WIN_INVALID.test(name) || /[. ]$/.test(name) || WIN_DEVICE.test(name))) {
    return "That name is not valid on Windows";
  }
  return null;
}

export function childPath(folder, name) {
  if (typeof folder !== "string" || !folder.trim()) throw new Error("No folder selected");
  if (validateNewName(name)) throw new Error("Invalid name");
  return `${folder.replace(/[/\\]$/, "")}/${name}`;
}

const FILE_SH = 'umask 077; (set -C; : > "$1")';
const FOLDER_SH = 'mkdir -- "$1"';

function quotePs(value) {
  return `'${value.replace(/['‘’‚‛]/g, (ch) => ch + ch)}'`;
}

export function powershellCreate(kind, path) {
  const literal = quotePs(path);
  if (kind === "file") {
    return `$ErrorActionPreference='Stop'; $p=${literal}; $f=[System.IO.File]::Open($p,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write); $f.Dispose()`;
  }
  return `$ErrorActionPreference='Stop'; $p=${literal}; if (Test-Path -LiteralPath $p) { throw 'Already exists' }; [System.IO.Directory]::CreateDirectory($p) | Out-Null`;
}

export async function createEntry({ exec, on = null, parent, name, kind, windows = false }) {
  if (kind !== "file" && kind !== "folder") throw new Error("Expected file or folder");
  const win = windows || windowsPath(parent);
  const error = validateNewName(name, win);
  if (error) throw new Error(error);
  const path = childPath(parent, name);
  const usePowerShell = async () => {
    const result = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", powershellCreate(kind, path)], { on });
    if (result.code !== 0) throw new Error(result.stderr || `Could not create ${kind}`);
  };
  if (win) {
    await usePowerShell();
    return path;
  }
  try {
    const result = await exec("sh", ["-c", kind === "file" ? FILE_SH : FOLDER_SH, "herdr-files", path], { on });
    if (result.code !== 0) throw new Error(result.stderr || `Could not create ${kind}`);
  } catch (error) {
    if (!on || !String(error).includes("cannot start sh")) throw error;
    await usePowerShell();
  }
  return path;
}
