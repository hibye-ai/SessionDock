'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { writeAtomicFileAsync } = require('./session-file.cjs');

function failure(message, code = 'ERR_EXPORT') { return Object.assign(new Error(message), { code }); }

// Run the CPU-heavy part of an export (worksheet/cell assembly plus deflate)
// on a bounded worker so the main process keeps answering IPC, authentication
// prompts and cancel timers while a 5,000-device workbook is being built.
function encodeInWorker(format, rows, { timeoutMs = 120000 } = {}) {
  if (!['txt', 'xlsx'].includes(format)) return Promise.reject(failure('TXT 또는 Excel 형식을 선택해 주세요.'));
  if (!Array.isArray(rows) || !rows.length) return Promise.reject(failure('저장할 결과가 없습니다.'));
  return new Promise((resolve, reject) => {
    let worker, settled = false, timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Always release the worker: a timed-out encode must not linger and hold
      // a copy of the whole transcript set.
      if (worker) void worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(value);
    };
    try {
      // Project before Worker construction: structured clone must never copy
      // command outputs or unrelated public metadata the encoder cannot use.
      const workerRows = rows.map(row => ({
        group: row.group, host: row.host, port: row.port, protocol: row.protocol,
        status: row.status, statusText: row.statusText, commandIndex: row.commandIndex,
        commandCount: row.commandCount, startedAt: row.startedAt, finishedAt: row.finishedAt,
        message: row.message, output: row.output
      }));
      worker = new Worker(path.join(__dirname, 'batch-export-worker.cjs'), {
        workerData: { format, rows: workerRows },
        resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 }
      });
    } catch {
      finish(failure('결과 파일을 만들지 못했습니다. 장비를 나눠 저장해 주세요.'));
      return;
    }
    timer = setTimeout(() => finish(failure('결과 파일 생성 시간이 초과되었습니다. 장비를 나눠 저장해 주세요.')), timeoutMs);
    worker.on('message', message => {
      if (message?.type === 'result') finish(null, Buffer.from(message.bytes));
      else if (message?.type === 'error') finish(failure(message.message || '결과 파일을 만들지 못했습니다.'));
      else finish(failure('결과 파일을 만들지 못했습니다.'));
    });
    worker.on('error', error => finish(failure(error?.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? '결과 파일을 만드는 데 필요한 메모리가 부족합니다. 장비를 나눠 저장해 주세요.'
      : '결과 파일을 만들지 못했습니다. 장비를 나눠 저장해 주세요.')));
    worker.once('exit', () => finish(failure('결과 파일을 만들지 못했습니다. 장비를 나눠 저장해 주세요.')));
  });
}

// Asynchronous counterpart of writeResult: encode off-thread, then commit with the
// same atomic/protected-path discipline. The commit is asynchronous too — a large
// export's open/write/fsync/rename must not block the main event loop, because that
// loop also serves SSH input, IPC and cancel timers (V7-M-07).
async function writeResultAsync(filename, format, rows, { protectedFiles = [] } = {}) {
  const bytes = await encodeInWorker(format, rows);
  const target = await writeAtomicFileAsync(filename, bytes, protectedFiles);
  return { path: target, devices: rows.length, bytes: bytes.length };
}

module.exports = { encodeInWorker, writeResultAsync };
