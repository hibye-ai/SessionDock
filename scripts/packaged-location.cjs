'use strict';
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const { version } = require('../package.json');

// A running Windows review window can lock the normal output directory. Accept
// a separate release build while keeping the default verification commands useful.
function packagedDirectory() {
  if (process.env.SESSIONDOCK_PACKAGED_DIR) return path.resolve(process.env.SESSIONDOCK_PACKAGED_DIR);
  const project = path.resolve(__dirname, '..');
  const candidates = ['dist/win-unpacked', `dist/release-${version}/win-unpacked`].map(directory => path.join(project, directory));
  const matching = candidates.filter(directory => {
    const archive = path.join(directory, 'resources/app.asar');
    return fs.existsSync(archive) && JSON.parse(asar.extractFile(archive, 'package.json')).version === version;
  });
  matching.sort((a, b) => fs.statSync(path.join(b, 'resources/app.asar')).mtimeMs - fs.statSync(path.join(a, 'resources/app.asar')).mtimeMs);
  if (!matching.length) throw new Error(`SessionDock ${version} 배포본이 없습니다. npm.cmd run dist로 먼저 빌드해 주세요.`);
  return matching[0];
}
module.exports = { packagedDirectory };
