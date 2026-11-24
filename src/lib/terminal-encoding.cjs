'use strict';

const iconv = require('iconv-lite');

const SUPPORTED_TERMINAL_ENCODINGS = Object.freeze([
  'utf-8', 'cp949', 'euc-kr', 'shift_jis', 'gb18030', 'big5'
]);
const ALIASES = new Map([
  ['utf8', 'utf-8'],
  ['cp949', 'cp949'], ['windows949', 'cp949'], ['ms949', 'cp949'], ['uhc', 'cp949'],
  ['euckr', 'euc-kr'],
  ['shiftjis', 'shift_jis'], ['sjis', 'shift_jis'], ['cp932', 'shift_jis'], ['windows31j', 'shift_jis'],
  ['gb18030', 'gb18030'],
  ['big5', 'big5'], ['bigfive', 'big5']
]);

function normalizeTerminalEncoding(encoding = 'utf-8') {
  if (typeof encoding === 'string' && encoding.length <= 64) {
    const normalized = ALIASES.get(encoding.trim().toLowerCase().replace(/[-_]/g, ''));
    if (normalized) return normalized;
  }
  const error = new Error('지원하지 않는 터미널 문자 인코딩입니다.');
  error.code = 'ERR_VALIDATION';
  throw error;
}

// Keep decoder state for the entire transport stream. Do not decode individual
// packets, or split 2/3/4-byte characters (and split ANSI text) will be damaged.
// Preserve a leading BOM as terminal data rather than silently stripping it.
function createTerminalDecoder(encoding = 'utf-8') {
  encoding = normalizeTerminalEncoding(encoding);
  const makeDecoder = () => iconv.getDecoder(encoding, { stripBOM: false });
  let decoder = makeDecoder();
  if (encoding === 'utf-8') return decoder;
  return {
    write(bytes) {
      // iconv-lite 0.7.3's DBCS decoder allocates output from only the new
      // packet size. A buffered GB18030 or Big5 supplementary character can
      // require more UTF-16 output than a one-byte completing packet permits.
      // Replay its bounded unfinished sequence into a fresh decoder together
      // with the new packet, so allocation and malformed-byte recovery see
      // the full sequence. All supported non-UTF-8 codecs use prevBytes.
      if (decoder.prevBytes.length) {
        bytes = Buffer.concat([Buffer.from(decoder.prevBytes), bytes]);
        decoder = makeDecoder();
      }
      return decoder.write(bytes);
    },
    end() { return decoder.end(); }
  };
}

function encodeTerminalInput(text, encoding = 'utf-8') {
  encoding = normalizeTerminalEncoding(encoding);
  if (typeof text !== 'string') {
    const error = new TypeError('터미널 입력은 문자열이어야 합니다.');
    error.code = 'ERR_INVALID_INPUT';
    throw error;
  }
  const bytes = iconv.encode(text, encoding);
  // iconv-lite substitutes unsupported characters with '?' (or U+FFFD). An
  // exact roundtrip also catches lossy aliases and unpaired UTF-16 surrogates.
  // Reject the whole input before writing anything; never include input in the
  // error because it may be a password typed at a terminal prompt.
  if (iconv.decode(bytes, encoding, { stripBOM: false }) !== text) {
    const error = new Error(`입력을 ${encoding} 인코딩으로 손실 없이 보낼 수 없습니다. 세션 문자 인코딩을 확인하세요.`);
    error.code = 'ERR_ENCODING_UNREPRESENTABLE';
    throw error;
  }
  return bytes;
}

// Transport-facing API: wire bytes in, UTF-8 display bytes out. Encoding input
// is stateless, while decode/end belong to exactly one receive stream.
class TerminalEncoding {
  constructor(encoding = 'utf-8') {
    this.encoding = normalizeTerminalEncoding(encoding);
    this.decoder = createTerminalDecoder(this.encoding);
    this.ended = false;
  }

  decode(bytes) {
    if (this.ended) throw new Error('Terminal decoder has ended.');
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('Terminal data must be bytes.');
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return Buffer.from(this.decoder.write(buffer), 'utf8');
  }

  end() {
    if (this.ended) return Buffer.alloc(0);
    this.ended = true;
    return Buffer.from(this.decoder.end() || '', 'utf8');
  }

  encode(text) { return encodeTerminalInput(text, this.encoding); }
}

// Batch connections can infer UTF-8/CP949 after an ASCII login prompt. Retain
// an unfinished first multibyte character instead of publishing replacements.
// Arbitrary legacy encodings cannot be distinguished from bytes with certainty.
class AutomaticTerminalEncoding {
  constructor(){this.encoding='auto';this.pending=Buffer.alloc(0);this.selected=null;this.ended=false;}
  decode(bytes){if(this.ended)throw new Error('Terminal decoder has ended.');bytes=Buffer.from(bytes);if(this.selected)return this.selected.decode(bytes);
    const combined=Buffer.concat([this.pending,bytes]);this.pending=Buffer.alloc(0);let at=0;while(at<combined.length&&combined[at]<128)at++;
    const ascii=combined.subarray(0,at);if(at===combined.length)return Buffer.from(ascii);
    const rest=combined.subarray(at),first=rest[0],length=first>=0xc2&&first<=0xdf?2:first>=0xe0&&first<=0xef?3:first>=0xf0&&first<=0xf4?4:0;
    if(length&&rest.length<length){this.pending=Buffer.from(rest);return Buffer.from(ascii);}
    let encoding='cp949';if(length){try{new TextDecoder('utf-8',{fatal:true}).decode(rest.subarray(0,length));encoding='utf-8';}catch{}}
    this.encoding=encoding;this.selected=new TerminalEncoding(encoding);return Buffer.concat([Buffer.from(ascii),this.selected.decode(rest)]);
  }
  end(){if(this.ended)return Buffer.alloc(0);this.ended=true;if(this.selected)return this.selected.end();if(this.pending.length){this.encoding='utf-8';this.selected=new TerminalEncoding('utf-8');return Buffer.concat([this.selected.decode(this.pending),this.selected.end()]);}return Buffer.alloc(0);}
  encode(text){return encodeTerminalInput(text,this.selected?this.encoding:'utf-8');}
}

module.exports = {
  SUPPORTED_TERMINAL_ENCODINGS, normalizeTerminalEncoding,
  createTerminalDecoder, encodeTerminalInput, TerminalEncoding,AutomaticTerminalEncoding
};
