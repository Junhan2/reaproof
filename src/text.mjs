// What can redraw a terminal or reorder what a reader sees: C0 and C1 controls, zero-width
// characters and bidirectional marks.
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
const MAX_SHOWN_CHARACTERS = 300;

/**
 * Text copied out of a scanned file, made safe to show. File names and strings in a build
 * are written by whoever wrote the build, and a report is read by terminals and AI agents.
 */
export function toShownText(text) {
  const plain = text.replace(UNSAFE_CHARACTERS, '');
  return plain.length > MAX_SHOWN_CHARACTERS ? `${plain.slice(0, MAX_SHOWN_CHARACTERS)}…` : plain;
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
