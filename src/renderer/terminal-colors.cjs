'use strict';

// Independent rules inspired by WindTerm's semantic coloring; never rewrite terminal data.
const MAX_TEXT = 8192;
const PRESETS = require('./terminal-color-presets.cjs');
function colorMode(settings = {}) { return ['securecrt','classic'].includes(settings.terminalColorScheme) ? 'securecrt' : 'wind'; }
function colorPreset(settings = {}) { return PRESETS[colorMode(settings)][settings.theme === 'light' ? 'light' : 'dark']; }
function terminalTheme(settings = {}) { return { ...colorPreset(settings).theme }; }
function terminalContrast(settings = {}) { return settings.theme === 'light' ? 7 : 4.5; }
function luminance(color) {
  return color.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
}
function readableColor(color, background, minimum = 4.5) {
  const bg=luminance(background),ratio=c=>(Math.max(luminance(c),bg)+.05)/(Math.min(luminance(c),bg)+.05);
  if(ratio(color)>=minimum)return color;
  const rgb=color.slice(1).match(/../g).map(v=>parseInt(v,16)),target=bg>.18?0:255;
  for(let step=1;step<=100;step++){
    const c='#'+rgb.map(v=>Math.round(v+(target-v)*step/100).toString(16).padStart(2,'0')).join('');
    if(ratio(c)>=minimum)return c;
  }
  return target?'#ffffff':'#000000';
}
function semanticPalette(settings = {}) {
  const preset=colorPreset(settings),base=preset.theme.foreground;
  return Object.fromEntries(Object.entries({prompt:base,command:base,path:base,option:base,string:base,number:base,boolean:base,permissions:base,sign:base,...preset.semantic}).map(([kind,color])=>[kind,readableColor(color,preset.theme.background,terminalContrast(settings))]));
}

// Paint the background once, behind both the transparent xterm canvas and gutter.
// A CSS opacity on the terminal would also fade glyphs, selections and the cursor.
function terminalSurface(settings) {
  const theme = terminalTheme(settings);
  const transparency = Number.isInteger(settings.terminalTransparency) ? Math.max(0, Math.min(100, settings.terminalTransparency)) : 0;
  return { background: theme.background + Math.round(255 * (1 - transparency / 100)).toString(16).padStart(2, '0'), theme: { ...theme, background: theme.background + '00' } };
}

function semanticTokens(input, settings = {}) {
  const wind = colorMode(settings) === 'wind';
  const text = input.slice(0, MAX_TEXT), candidates = [];
  const add = (start, end, kind, priority) => { if (end > start) candidates.push({ start, end, kind, priority }); };
  const matches = (regex, kind, priority, valid) => {
    for (const match of text.matchAll(regex)) if (!valid || valid(match[0])) add(match.index, match.index + match[0].length, kind, priority);
  };
  // Recognize shell/network prompts conservatively, so prose containing $ or # remains prose.
  const prompt = /^\s*(?:\[[^\]\r\n]{1,160}\]|[\w.-]+@[\w.-]+(?::[^\r\n$#>]{0,256})?|(?:PS\s+)?[A-Za-z]:\\[^\r\n>]{0,256}|(?:~|\/[\w./~-]*)|[\w.-]+(?:\([\w./-]+\))?)[#$>%](?=\s|$)/.exec(text);
  if (wind && prompt) {
    add(0, prompt[0].length, 'prompt', 45);
    add(prompt[0].length - 1, prompt[0].length, 'sign', 80);
    const command = /^\s*([\w./~-]+)/.exec(text.slice(prompt[0].length));
    if (command) add(prompt[0].length + command[0].length - command[1].length, prompt[0].length + command[0].length, 'command', 75);
  }
  matches(/\b(?:ERROR|FAILED?|FAILURE|FATAL|PANIC|DENIED|REFUSED|UNREACHABLE|DOWN|OFFLINE|CRITICAL)\b/gi, 'error', 90);
  matches(/\b(?:WARNING|WARN|DEPRECATED|TIMEOUT|PENDING)\b/gi, 'warning', 85);
  matches(/\b(?:OK|SUCCESS(?:FUL)?|PASSED?|ENABLED|CONNECTED|ESTABLISHED|RUNNING|ONLINE|UP)\b/gi, 'success', 85);
  if(wind)matches(/\b(?:true|false|null|none|yes|no)\b/gi, 'boolean', 70);
  matches(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g, 'address', 65, value => { const [address, prefix] = value.split('/'); return address.split('.').every(part => Number(part) <= 255) && (prefix === undefined || Number(prefix) <= 32); });
  matches(/(?<![\w:])[a-f\d]{0,4}:[a-f\d:]{1,39}(?![\w:])/gi, 'address', 65, value => {
    const compressed = value.split('::');
    if (compressed.length > 2) return false;
    const groups = compressed.flatMap(part => part ? part.split(':') : []);
    return groups.every(part => /^[a-f\d]{1,4}$/i.test(part)) && (compressed.length === 2 ? groups.length < 8 : groups.length === 8);
  });
  matches(/\b(?:[a-f\d]{2}:){5}[a-f\d]{2}\b/gi, 'address', 66);
  if(wind){
  matches(/(?:https?|sftp|ssh):\/\/[^\s<>"']+|(?<![\w/])(?:~\/|\.{1,2}\/|\/)[^\s<>"'|;,\[\]{}()]+|\b[A-Za-z]:\\[^\s<>"'|;,\[\]{}()]+/g, 'path', 60);
  matches(/(?<!\S)--?[A-Za-z][\w-]*(?:=[^\s"']+)?/g, 'option', 55);
  matches(/"[^"\r\n]{0,1024}"|'[^'\r\n]{0,1024}'/g, 'string', 95);
  matches(/(?<!\S)[dlcbps-][rwxstST-]{9}(?!\S)/g, 'permissions', 50);
  matches(/(?<![\w.])(?:0x[a-f\d]+|\d+(?:\.\d+)?(?:%|[KMGT]i?B)?)(?![\w.])/gi, 'number', 20);
  }
  const colors = new Array(text.length), weights = new Uint8Array(text.length);
  for (const token of candidates) for (let i = token.start; i < token.end; i++) if (token.priority > weights[i]) { weights[i] = token.priority; colors[i] = token.kind; }
  const result = [];
  for (let i = 0; i < colors.length;) {
    const kind = colors[i], start = i++;
    while (i < colors.length && colors[i] === kind) i++;
    if (kind) result.push({ start, end: i, kind });
  }
  return result;
}

function semanticRuns(line, tokens, offset, cols) {
  const runs = [];
  let position = offset, tokenIndex = 0, reusable;
  for (let x = 0; x < Math.min(cols, line.length); x++) {
    const cell = line.getCell(x, reusable); if (!cell) break; reusable = cell;
    const width = cell.getWidth(); if (!width) continue;
    const end = position + (cell.getChars() || ' ').length;
    while (tokenIndex < tokens.length && tokens[tokenIndex].end <= position) tokenIndex++;
    const token = tokens[tokenIndex];
    // Devices often explicitly select black/gray/white for ordinary text. These
    // neutral palette slots can use semantic colors in either UI theme. Preserve
    // chromatic ANSI/truecolor, backgrounds, reverse video and invisible/italic.
    const neutral=cell.isFgDefault()||(cell.isFgPalette?.()&&[0,7,8,15].includes(cell.getFgColor()));
    if (token && token.start < end && token.end > position && neutral && cell.isBgDefault() && !cell.isItalic() && !cell.isInverse() && !cell.isInvisible()) {
      const previous = runs.at(-1);
      if (previous && previous.kind === token.kind && previous.x + previous.width === x) previous.width += width;
      else runs.push({ x, width, kind: token.kind });
    }
    position = end;
  }
  return runs;
}

module.exports = { MAX_TEXT, colorMode, terminalTheme, terminalSurface, terminalContrast, semanticPalette, semanticTokens, semanticRuns };
