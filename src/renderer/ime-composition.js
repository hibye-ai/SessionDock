// IME composition ownership for a terminal pane.
//
// A cancelled hangul composition is still committed by xterm's composition
// helper, and Ctrl+C/Ctrl+Z are handled before xterm's own key path, so that
// commit can arrive at any later time — immediately, or hundreds of
// milliseconds after the ETX. A time window leaks a slow commit and then
// swallows the *next* legitimate syllable; "drop the first non-ASCII event"
// does the same. Ownership is therefore tracked per composition session:
//
//   start()   -> a new session id is issued, and any stale claim is dropped
//                because a new composition now owns the keyboard.
//   cancel()  -> claims the session that is open right now (id + its text).
//   intercept(data) -> consumes the claim exactly once, and only for a
//                non-ASCII chunk that matches the claimed text. Any later
//                composition is a different session and passes untouched.
const nonAscii = /[^\x00-\x7f]/;

export function createCompositionOwnership() {
  let nextId = 1;
  let currentId = 0;
  let claimedId = 0;
  let claimedText = '';
  const state = {
    active: false,
    pending: '',
    get cancelled() { return claimedId !== 0; },
  };

  state.start = () => {
    // A fresh composition takes ownership: anything still claimed belongs to a
    // session that can no longer deliver text.
    currentId = nextId++;
    claimedId = 0;
    claimedText = '';
    state.active = true;
    state.pending = '';
  };
  state.update = text => { state.pending = typeof text === 'string' ? text : ''; };
  state.end = () => {
    // Keep any claim: the claimed session's commit is emitted right after this
    // event, and `intercept()` still has to see it.
    state.active = false;
    state.pending = '';
    currentId = 0;
  };
  // Claim the composition session that currently owns half-typed text.
  state.cancel = () => {
    if (!state.active && !state.pending) return false;
    claimedId = currentId || -1;
    claimedText = state.pending;
    return true;
  };
  state.reset = () => {
    currentId = 0;
    claimedId = 0;
    claimedText = '';
    state.active = false;
    state.pending = '';
  };
  // True when this chunk is the cancelled composition's commit and must be
  // dropped. Consumes the claim so only one commit can be swallowed.
  state.intercept = data => {
    if (!claimedId || typeof data !== 'string' || !data) return false;
    // ASCII-only input is never an IME commit; ordinary Ctrl+C then typing must
    // reach the device even while a claim is outstanding.
    if (!nonAscii.test(data)) return false;
    const owns = !claimedText || data === claimedText
      || data.startsWith(claimedText) || claimedText.startsWith(data);
    if (!owns) return false;
    claimedId = 0;
    claimedText = '';
    return true;
  };

  return state;
}
