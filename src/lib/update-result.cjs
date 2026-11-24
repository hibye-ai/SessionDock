'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createUpdateResults(userDataDir) {
  const filename = path.join(userDataDir, 'update-result.json');
  const acknowledged = path.join(userDataDir, 'update-result-ack.json');
  async function snapshot() {
    let file;
    try {
      file = await fs.open(filename, 'r');
      const info = await file.stat();
      if (info.size > 8192 || !info.isFile()) throw new Error('업데이트 결과가 올바르지 않습니다.');
      const raw = await file.readFile('utf8');
      const id = crypto.createHash('sha256').update(raw).update('\0' + info.ino + ':' + info.birthtimeMs + ':' + info.mtimeMs).digest('hex');
      return { id, value: JSON.parse(raw) };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await file?.close(); }
  }
  async function read() {
    const result = await snapshot();
    if (!result) return null;
    try { if (JSON.parse(await fs.readFile(acknowledged, 'utf8')).id === result.id) return null; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return { ...result.value, resultId: result.id };
  }
  async function ack(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) throw new Error('업데이트 결과 확인 정보가 올바르지 않습니다.');
    const current = await snapshot();
    if (!current || current.id !== id) return false;
    const temp = acknowledged + '.' + crypto.randomBytes(16).toString('hex') + '.tmp';
    try { await fs.writeFile(temp, JSON.stringify({id}), {flag:'wx'}); await fs.rename(temp, acknowledged); }
    finally { await fs.rm(temp, {force:true}).catch(() => {}); }
    return true;
  }
  return { read, ack };
}
module.exports = { createUpdateResults };
