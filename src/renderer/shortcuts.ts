/**
 * Every keyboard shortcut, in one table: the key handler, the shortcuts dialog and the menu labels
 * all come from here, so they can't disagree. Letter keys match the physical key (e.code), so they
 * work with any keyboard layout and with ⌥ held on a Mac.
 */
import { engine } from './preview/engine';
import * as A from './state/actions';
import { store } from './state/store';

interface Keys {
  key?: string; // KeyboardEvent.key (named keys: ' ', 'ArrowLeft', 'Delete', …)
  code?: string; // KeyboardEvent.code (letters: 'KeyJ')
  mod?: boolean; // ⌘ on macOS, Ctrl elsewhere
  shift?: boolean;
  alt?: boolean;
  anyShift?: boolean; // for characters that need Shift on some layouts ('?', '+')
}

export interface Shortcut {
  group: 'Playback' | 'Navigate' | 'Edit' | 'Timeline' | 'File';
  label: string;
  keys: Keys[];
  run: () => void;
}

const L = (c: string) => `Key${c}`;
const zoomFit = () => A.zoomToFit(document.querySelector('.tl-scroll')?.clientWidth ?? 1000);

export const SHORTCUTS: Shortcut[] = [
  { group: 'Playback', label: 'Play / pause', keys: [{ key: ' ' }], run: () => engine.toggle() },
  { group: 'Playback', label: 'Play backward (again: 2×, 4×)', keys: [{ code: L('J') }], run: () => engine.shuttleBackward() },
  { group: 'Playback', label: 'Pause', keys: [{ code: L('K') }], run: () => engine.pause() },
  { group: 'Playback', label: 'Play forward (again: 2×, 4×)', keys: [{ code: L('L') }], run: () => engine.shuttleForward() },
  { group: 'Navigate', label: 'Previous / next frame', keys: [{ key: 'ArrowLeft' }, { key: 'ArrowRight' }], run: () => {} },
  { group: 'Navigate', label: '10 frames back / forward', keys: [{ key: 'ArrowLeft', shift: true }, { key: 'ArrowRight', shift: true }], run: () => {} },
  { group: 'Navigate', label: 'Previous cut or marker', keys: [{ key: 'ArrowUp' }], run: () => A.jumpToEdit(-1) },
  { group: 'Navigate', label: 'Next cut or marker', keys: [{ key: 'ArrowDown' }], run: () => A.jumpToEdit(1) },
  { group: 'Navigate', label: 'Go to start', keys: [{ key: 'Home' }], run: () => A.seekToStart() },
  { group: 'Navigate', label: 'Go to end', keys: [{ key: 'End' }], run: () => A.seekToEnd() },
  { group: 'Edit', label: 'Split at playhead', keys: [{ code: L('S') }, { code: L('B'), mod: true }, { code: L('K'), mod: true }], run: () => A.splitAtPlayhead() },
  { group: 'Edit', label: 'Trim clip start to playhead', keys: [{ code: L('Q') }], run: () => A.trimToPlayhead('start') },
  { group: 'Edit', label: 'Trim clip end to playhead', keys: [{ code: L('W') }], run: () => A.trimToPlayhead('end') },
  { group: 'Edit', label: 'Select clip under playhead', keys: [{ code: L('X') }], run: () => A.selectAtPlayhead() },
  { group: 'Edit', label: 'Delete (close the gap)', keys: [{ key: 'Delete' }, { key: 'Backspace' }], run: () => A.deleteSelected('close-gap') },
  { group: 'Edit', label: 'Delete, leave a gap', keys: [{ key: 'Delete', shift: true }, { key: 'Backspace', shift: true }], run: () => A.deleteSelected('leave-gap') },
  { group: 'Edit', label: 'Duplicate', keys: [{ code: L('D'), mod: true }], run: () => A.duplicateSelected() },
  { group: 'Edit', label: 'Copy / cut / paste clip (pastes at the playhead)', keys: [{ code: L('C'), mod: true }, { code: L('X'), mod: true }, { code: L('V'), mod: true }], run: () => {} },
  { group: 'Edit', label: 'Move clip earlier', keys: [{ key: 'ArrowLeft', alt: true }], run: () => A.moveSelected(-1) },
  { group: 'Edit', label: 'Move clip later', keys: [{ key: 'ArrowRight', alt: true }], run: () => A.moveSelected(1) },
  { group: 'Edit', label: 'Add a title at the playhead', keys: [{ code: L('T') }], run: () => A.addTitleAction() },
  { group: 'Edit', label: 'Undo / redo', keys: [{ code: L('Z'), mod: true }, { code: L('Z'), mod: true, shift: true }], run: () => {} },
  { group: 'Timeline', label: 'Add a marker at the playhead', keys: [{ code: L('M') }], run: () => A.addMarkerAction() },
  { group: 'Timeline', label: 'Mark range start (for export)', keys: [{ code: L('I') }], run: () => A.markIn() },
  { group: 'Timeline', label: 'Mark range end', keys: [{ code: L('O') }], run: () => A.markOut() },
  { group: 'Timeline', label: 'Clear the marked range', keys: [{ code: L('X'), alt: true }], run: () => A.clearMarks() },
  { group: 'Timeline', label: 'Snapping on / off (hold ⌥/Alt while dragging to bypass)', keys: [{ code: L('N') }], run: () => store.set({ snapping: !store.get().snapping }) },
  { group: 'Timeline', label: 'Zoom in', keys: [{ key: '=', anyShift: true }, { key: '+', anyShift: true }], run: () => A.zoomBy(1.25) },
  { group: 'Timeline', label: 'Zoom out', keys: [{ key: '-' }], run: () => A.zoomBy(0.8) },
  { group: 'Timeline', label: 'Fit the whole timeline', keys: [{ code: L('Z'), shift: true }], run: zoomFit },
  { group: 'Timeline', label: 'Deselect / back to the timeline preview', keys: [{ key: 'Escape' }], run: () => store.set({ selection: null, previewMediaId: null }) },
  { group: 'File', label: 'Import media', keys: [{ code: L('I'), mod: true }], run: () => {} },
  { group: 'File', label: 'Save / save as', keys: [{ code: L('S'), mod: true }, { code: L('S'), mod: true, shift: true }], run: () => {} },
  { group: 'File', label: 'Open project', keys: [{ code: L('O'), mod: true }], run: () => {} },
  { group: 'File', label: 'Export', keys: [{ code: L('E'), mod: true }], run: () => {} },
  { group: 'File', label: 'Show keyboard shortcuts', keys: [{ key: '?', anyShift: true }], run: () => store.set({ dialog: 'shortcuts' }) },
];

const isMac = () => window.cutroom.platform === 'darwin';

function matches(k: Keys, e: KeyboardEvent): boolean {
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  if (!!k.mod !== mod || !!k.alt !== e.altKey) return false;
  if (!k.anyShift && !!k.shift !== e.shiftKey) return false;
  if (k.code) return e.code === k.code;
  return e.key === k.key;
}

/** Handle a key press outside text fields. Returns true when a shortcut ran. */
export function runShortcut(e: KeyboardEvent): boolean {
  // Frame stepping is kept here (rather than in the table) because one entry covers two keys.
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !mod) {
    engine.step((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
    return true;
  }
  // Copy/cut/paste of clips (text fields keep their normal clipboard).
  if (mod && !e.altKey && !e.shiftKey && (e.code === 'KeyC' || e.code === 'KeyX' || e.code === 'KeyV')) return clipboardAction(e.code);
  for (const s of SHORTCUTS) if (s.keys.some((k) => matches(k, e))) {
    if (s.group === 'File' && s.label !== 'Show keyboard shortcuts') return false; // handled by the menu
    if (s.label === 'Undo / redo') return false; // handled by the menu
    s.run();
    return true;
  }
  return false;
}

// The Edit menu's Copy/Paste may also fire a DOM clipboard event for the same key press; handle once.
let lastClipboardAction = 0;
function clipboardAction(code: string): boolean {
  lastClipboardAction = performance.now();
  if (code === 'KeyC') return A.copySelection();
  if (code === 'KeyX') {
    A.cutSelection();
    return true;
  }
  return A.pasteAtPlayhead();
}

/** Edit menu Copy / Cut / Paste (mouse) outside text fields act on clips. */
let installed = false;
export function installClipboardHandlers() {
  if (installed) return;
  installed = true;
  const outsideText = () => {
    const el = document.activeElement as HTMLElement | null;
    return !(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
  };
  const handler = (code: string) => (e: Event) => {
    if (!outsideText() || store.get().dialog) return;
    if (performance.now() - lastClipboardAction < 300) {
      e.preventDefault();
      return;
    }
    if (clipboardAction(code)) e.preventDefault();
  };
  document.addEventListener('copy', handler('KeyC'));
  document.addEventListener('cut', handler('KeyX'));
  document.addEventListener('paste', handler('KeyV'));
}

/** How a key combination is written on this platform, e.g. "⌘⇧S" or "Ctrl+Shift+S". */
export function keyLabel(k: Keys): string {
  const mac = isMac();
  const names: Record<string, string> = {
    ' ': 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc',
    Delete: mac ? '⌦' : 'Delete', Backspace: mac ? '⌫' : 'Backspace', Home: 'Home', End: 'End',
  };
  const base = k.code ? k.code.replace('Key', '') : names[k.key!] ?? k.key!;
  if (mac) return `${k.mod ? '⌘' : ''}${k.alt ? '⌥' : ''}${k.shift ? '⇧' : ''}${base}`;
  return [k.mod && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', base].filter(Boolean).join('+');
}
