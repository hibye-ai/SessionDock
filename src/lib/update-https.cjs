'use strict';

const https = require('node:https');
const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const LATEST_URL = 'https://sessiondock.norahc.com/update/latest';
const ZIP_URL = 'https://sessiondock.norahc.com/SessionDock.zip';
const METADATA_LIMIT = 16 * 1024;
const ZIP_LIMIT = 2 * 1024 ** 3; // Same ceiling as the ZIP-only helper.

class UpdateResponseError extends Error {}
function invalidMetadata() { return new UpdateResponseError('업데이트 응답이 올바르지 않습니다.'); }
function invalidArtifact() { return new UpdateResponseError('다운로드한 업데이트 파일을 검증하지 못했습니다.'); }
const TLS_ERROR = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$)/;
const CONNECTION_ERROR = /^(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT)$/;

function getResponse(get, url, signal) {
  return new Promise((resolve, reject) => {
    const request = get(url, {
      agent: false, rejectUnauthorized: true, maxHeaderSize: 8 * 1024, signal,
      headers: { 'Accept-Encoding': 'identity' }
    }, resolve);
    request.once('error', reject);
  });
}

function createHttpsUpdateSource({ get = https.get, metadataTimeoutMs = 10000, downloadTimeoutMs = 180000 } = {}) {
  async function read(url, limit, exact, timeoutMs, signal, consume) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const badSize = exact === undefined ? invalidMetadata : invalidArtifact;
    let response;
    try {
      active.throwIfAborted();
      response = await getResponse(get, url, active);
      active.throwIfAborted();
      // node:https never follows redirects. Reject all non-200 responses before reading a body.
      const { statusCode, headers } = response;
      if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) throw new UpdateResponseError(`업데이트 서버 응답에 실패했습니다. (HTTP ${statusCode})`);
      if (statusCode !== 200 || (headers['content-encoding'] && headers['content-encoding'] !== 'identity')) throw invalidMetadata();
      const header = headers['content-length'];
      const length = header === undefined ? undefined : /^\d{1,10}$/.test(header) ? Number(header) : NaN;
      if (length !== undefined && (!Number.isSafeInteger(length) || length < 1 || length > limit || (exact !== undefined && length !== exact))) throw badSize();
      const result = await consume(response, exact ?? length, active);
      active.throwIfAborted();
      return result;
    } catch (error) {
      if (signal?.aborted) throw new Error('업데이트 작업이 취소되었습니다.');
      if (deadline.signal.aborted) throw new Error('sessiondock.norahc.com 응답 시간이 초과되었습니다.');
      if (error instanceof UpdateResponseError) throw error;
      if (TLS_ERROR.test(error?.code)) throw new Error('sessiondock.norahc.com 보안 연결(HTTPS)을 확인할 수 없습니다.');
      if (exact === undefined || CONNECTION_ERROR.test(error?.code)) throw new Error('sessiondock.norahc.com에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.');
      throw new Error('업데이트 파일을 다운로드하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      clearTimeout(timer);
      response?.destroy();
    }
  }

  return {
    latest(signal) {
      return read(LATEST_URL, METADATA_LIMIT, undefined, metadataTimeoutMs, signal, async (response, length) => {
        let size = 0;
        const chunks = [];
        for await (const chunk of response) {
          size += chunk.length;
          if (size > METADATA_LIMIT || (length !== undefined && size > length)) throw invalidMetadata();
          chunks.push(chunk);
        }
        if (length !== undefined && size !== length) throw invalidMetadata();
        let data, text;
        try { text = new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks, size)); data = JSON.parse(text); }
        catch { throw invalidMetadata(); }
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 4 ||
            typeof data.version !== 'string' || data.version.length > 64 || data.version.trim() !== data.version ||
            !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(data.version) ||
            data.url !== ZIP_URL || !Number.isSafeInteger(data.size) || data.size < 1 || data.size > ZIP_LIMIT ||
            typeof data.sha256 !== 'string' || data.sha256.length !== 64 || !/^[a-f0-9]{64}$/i.test(data.sha256)) throw invalidMetadata();
        // The four values are scalar. After JSON parsing, count unquoted
        // colons to catch repeated keys (including escaped spellings).
        let members = 0;
        for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|:/gs)) if (token === ':') members++;
        if (members !== 4) throw invalidMetadata();
        return {name:'SessionDock.zip', version:data.version, size:data.size, buildID:'sha256-'+data.sha256.toLowerCase()};
      });
    },
    download(candidate, destination, signal, onProgress) {
      // Only the canonical URL is ever requested. Nothing from the offer becomes a path or URL.
      return read(ZIP_URL, candidate.size, candidate.size, downloadTimeoutMs, signal, async (response, expected, active) => {
        const hash = createHash('sha256');
        let size = 0, lastProgress = 0;
        const progress = () => onProgress?.({type:'stage-progress',phase:'download',unit:'bytes',completed:size,total:expected});
        progress();
        const meter = new Transform({transform(chunk, _encoding, done) {
          size += chunk.length;
          if (size > expected) return done(invalidArtifact());
          hash.update(chunk);
          const now = Date.now();
          if (now - lastProgress >= 150) { lastProgress = now; progress(); }
          done(null, chunk);
        }});
        await pipeline(response, meter, createWriteStream(destination, {flags:'wx', mode:0o600}), {signal:active});
        if (size !== expected || 'sha256-'+hash.digest('hex') !== candidate.buildID) throw invalidArtifact();
        progress();
      });
    }
  };
}

module.exports = { createHttpsUpdateSource };
