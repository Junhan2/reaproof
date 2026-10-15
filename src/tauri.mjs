// A Tauri app keeps its screen code (HTML, JavaScript, CSS) inside its program, compressed by
// default, where nothing here reads it. The script that connects the screen to the program
// goes in as it is, and it names `__TAURI_INTERNALS__` in Tauri 2 (crates/tauri/scripts/core.js)
// and `__TAURI_IPC__` in Tauri 1 (core/tauri/scripts/core.js), whatever the system. Both are
// looked for in one pass, by what they start with.
const MARKER_START = Buffer.from('__TAURI_');
const MARKER_ENDS = ['INTERNALS__', 'IPC__'].map((end) => Buffer.from(end));

/** @param {Buffer} bytes a stretch of a program */
export function holdsTauriScreenCode(bytes) {
  for (let at = bytes.indexOf(MARKER_START); at !== -1; at = bytes.indexOf(MARKER_START, at + 1)) {
    const after = at + MARKER_START.length;
    if (MARKER_ENDS.some((end) => end.equals(bytes.subarray(after, after + end.length)))) return true;
  }
  return false;
}
