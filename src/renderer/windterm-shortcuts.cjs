'use strict';
// Supported application actions from WindTerm 2.7.0 global/wind.keymaps.
// Remote Ctrl+C/Ctrl+D/Ctrl+F remain terminal input, as in WindTerm remote mode.
function windtermShortcut(event, {terminal=false, editable=false}={}) {
  if(event.type!=='keydown'||event.isComposing||event.keyCode===229||event.metaKey||event.getModifierState?.('AltGraph'))return null;
  const {ctrlKey:c,altKey:a,shiftKey:s,code:k}=event;
  if(a&&!c&&!s){
    const keys={KeyD:'address',KeyN:'new-session',BracketLeft:'previous-tab',BracketRight:'next-tab',Digit7:'terminal',KeyW:'split-prefix',Enter:'focus-mode',F3:'find-next'};
    if(keys[k]&&(!editable||['address','new-session','terminal'].includes(keys[k])||terminal))return keys[k];
  }
  if(a&&!c&&s&&k==='F3'&&!editable)return 'find-previous';
  if(c&&!a){
    if(s){const keys={KeyD:'clone',KeyW:'close-tab',KeyQ:'exit'};if(keys[k])return keys[k];if(terminal&&k==='KeyC')return 'copy';if(terminal&&k==='KeyV')return 'paste';}
    if(!s&&terminal&&k==='Insert')return 'copy';
    if(terminal&&(k==='Equal'||(!s&&k==='Minus')))return k==='Equal'?'zoom-in':'zoom-out';
    if(!s&&!terminal&&!editable&&k==='KeyF')return 'find';
  }
  return null;
}
module.exports={windtermShortcut};
