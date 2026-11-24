'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NOTICES = Object.freeze([
  { source: 'LICENSE.electron.txt', target: 'LICENSE.electron.txt' },
  { source: 'LICENSES.chromium.html', target: 'LICENSES.chromium.html' }
]);

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
const directChild = (root, name) => {
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root || path.basename(target) !== name) {
    throw new Error(`패키지 경로가 허용 폴더를 벗어났습니다: ${name}`);
  }
  return target;
};
const lstatIfExists = file => {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
function regularFile(file, label) {
  const stat = lstatIfExists(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label}이 일반 파일이 아닙니다: ${file}`);
  }
  return stat;
}
function realDirectory(directory, label) {
  const stat = lstatIfExists(directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label}이 일반 폴더가 아닙니다: ${directory}`);
  }
  if (!samePath(fs.realpathSync(directory), directory)) {
    throw new Error(`${label} 경로가 다른 위치를 참조합니다: ${directory}`);
  }
}

function relocateElectronNotices(context) {
  if (!context || typeof context.appOutDir !== 'string' || !context.appOutDir) {
    throw new Error('afterPack에 appOutDir가 없습니다.');
  }

  const appOutDir = path.resolve(context.appOutDir);
  realDirectory(appOutDir, '패키지 폴더');
  const resources = directChild(appOutDir, 'resources');
  realDirectory(resources, 'resources 폴더');
  const licenses = directChild(resources, 'licenses');
  if (lstatIfExists(licenses)) {
    throw new Error(`resources/licenses가 이미 있어 고지 파일 이동을 중단합니다: ${licenses}`);
  }

  const plans = NOTICES.map(({ source, target }) => {
    const sourcePath = directChild(appOutDir, source);
    const targetPath = directChild(licenses, target);
    regularFile(sourcePath, 'Electron 고지 파일');
    if (lstatIfExists(targetPath)) {
      throw new Error(`이동 대상 고지 파일이 이미 있습니다: ${targetPath}`);
    }
    const bytes = fs.readFileSync(sourcePath);
    return { sourcePath, targetPath, bytes, sha256: hash(bytes) };
  });

  const moved = [];
  let createdLicensesDirectory = false;
  try {
    fs.mkdirSync(licenses);
    createdLicensesDirectory = true;
    realDirectory(licenses, 'licenses 폴더');
    for (const plan of plans) {
      if (lstatIfExists(plan.targetPath)) {
        throw new Error(`이동 대상 고지 파일이 이미 있습니다: ${plan.targetPath}`);
      }
      fs.renameSync(plan.sourcePath, plan.targetPath);
      moved.push(plan);
      regularFile(plan.targetPath, '이동한 Electron 고지 파일');
      if (hash(fs.readFileSync(plan.targetPath)) !== plan.sha256) {
        throw new Error(`이동 중 고지 파일 내용이 바뀌었습니다: ${plan.targetPath}`);
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const plan of moved.reverse()) {
      try {
        regularFile(plan.targetPath, '되돌릴 Electron 고지 파일');
        if (lstatIfExists(plan.sourcePath)) throw new Error(`되돌릴 원본 위치가 이미 사용 중입니다: ${plan.sourcePath}`);
        fs.renameSync(plan.targetPath, plan.sourcePath);
        if (hash(fs.readFileSync(plan.sourcePath)) !== plan.sha256) {
          throw new Error(`되돌린 고지 파일 내용이 다릅니다: ${plan.sourcePath}`);
        }
      } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    if (createdLicensesDirectory && lstatIfExists(licenses)) {
      try {
        const directory = lstatIfExists(licenses);
        if (directory.isDirectory() && !directory.isSymbolicLink() && fs.readdirSync(licenses).length === 0) {
          fs.rmdirSync(licenses);
        }
      } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    if (rollbackErrors.length) {
      throw new Error(`Electron 고지 이동 실패: ${error.message}; 되돌리기 실패: ${rollbackErrors.join('; ')}`, { cause: error });
    }
    throw error;
  }

  return {
    licensesDirectory: licenses,
    moved: plans.map(plan => ({ file: plan.targetPath, bytes: plan.bytes.length, sha256: plan.sha256 }))
  };
}

module.exports = relocateElectronNotices;
module.exports.relocateElectronNotices = relocateElectronNotices;
