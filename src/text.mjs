// What a reader does not see, or what changes what is seen: controls (they can redraw a
// terminal), format characters such as direction marks, line and paragraph separators,
// private-use characters and everything Unicode calls ignorable by default, which takes in
// variation selectors and the invisible "tag" letters that only a machine reads.
const UNSEEN = '\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}';
const UNSEEN_CHARACTERS = new RegExp(`[${UNSEEN}]`, 'gu');
const UNSEEN_EXCEPT_LINE_BREAKS = new RegExp(`(?!\\n)[${UNSEEN}]`, 'gu');
const MAX_SHOWN_CHARACTERS = 300;

/**
 * Text copied out of a scanned file, made safe to show. File names and strings in a build
 * are written by whoever wrote the build, and a report is read by terminals and AI agents:
 * nothing unseen stays, no line break does, and a long text is cut.
 */
export function toShownText(text) {
  const plain = text.replace(UNSEEN_CHARACTERS, '');
  if (plain.length <= MAX_SHOWN_CHARACTERS) return plain;
  // Cut between characters, never through the two halves of one.
  return `${plain.slice(0, MAX_SHOWN_CHARACTERS).replace(/[\ud800-\udbff]$/, '')}…`;
}

/** A value with every string inside it made safe to show. */
export function toShown(value) {
  if (typeof value === 'string') return toShownText(value);
  if (Array.isArray(value)) return value.map(toShown);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toShown(item)]));
  }
  return value;
}

/**
 * Report text on its way out. Line breaks stay and nothing else unseen does, whatever path,
 * message or other program's output the text was put together from.
 */
export function toPrintable(text) {
  return text.replace(UNSEEN_EXCEPT_LINE_BREAKS, '');
}

/**
 * JSON in which every unseen character is written as an escape. Exact values such as file
 * paths come back unchanged when the JSON is parsed, and the text itself hides nothing from
 * whoever reads it as text.
 */
export function toVisibleJson(value) {
  return JSON.stringify(value, null, 2).replace(UNSEEN_EXCEPT_LINE_BREAKS, (character) =>
    Array.from(
      { length: character.length },
      (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`,
    ).join(''),
  );
}
