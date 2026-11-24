'use strict';

// A best-effort prompt hint, not a password classifier. The explicit sensitive
// input control covers custom prompts and secrets entered at ordinary prompts.
const AUTH_PROMPT = /(?:\b(?:password|passwd|passphrase|passcode|pin|otp|verification\s+code|authentication\s+code|one[- ]time(?:\s+password|\s+code)?)\b|비밀번호|암호|인증\s*코드)[^\r\n:：?]{0,160}[:：?]\s*$/i;

function createAuthenticationPromptTracker() {
  let decoder = new TextDecoder(), line = '', escape = '', sensitive = false;
  return {
    get sensitive() { return sensitive; },
    write(bytes) {
      const text = typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true });
      const inspect = () => { if (line.trim()) sensitive = AUTH_PROMPT.test(line); };
      if (!escape && !/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
        const lines = text.split(/\r\n|\r|\n/);
        for (let index = 0; index < lines.length; index++) {
          line = (line + lines[index].slice(-512)).slice(-512); inspect();
          if (index < lines.length - 1) line = '';
        }
        return sensitive;
      }
      for (const char of text) {
        if (escape === 'csi') { if (char >= '@' && char <= '~') escape = ''; continue; }
        if (escape === 'string' || escape === 'string-esc') {
          if (char === '\x07' || escape === 'string-esc' && char === '\\') escape = '';
          else escape = char === '\x1b' ? 'string-esc' : 'string';
          continue;
        }
        if (escape === 'esc') {
          escape = char === '[' ? 'csi' : [']', 'P', '^', '_'].includes(char) ? 'string' : '';
          continue;
        }
        if (char === '\x1b') escape = 'esc';
        else if (char === '\r' || char === '\n') { inspect(); line = ''; }
        else if (char === '\b' || char === '\x7f') line = line.slice(0, -1);
        else if (char >= ' ') line = (line + char).slice(-512);
      }
      // Inspect once per line/chunk, not once per character on bulk output.
      // A newline alone keeps protection; a new normal line releases it.
      inspect();
      return sensitive;
    },
    reset() { decoder = new TextDecoder(); line = ''; escape = ''; sensitive = false; }
  };
}

function isSensitiveConnection(record) {
  return !!(record?.commandPrivate || record?.authenticationPrompt?.sensitive);
}

module.exports = { createAuthenticationPromptTracker, isSensitiveConnection };
