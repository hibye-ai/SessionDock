'use strict';
const { build, Platform, Arch } = require('electron-builder');
const pythonFiles = require('../analysis/python-runtime-manifest.json').files;

// electron-builder 26's signExts supports negative, literal path suffixes.
// Cover source assets and copied resources, on both native path separators.
// Preserve every pinned runtime file, while other executables remain signable.
const pythonSigningExclusions = pythonFiles.flatMap(({ name }) =>
  [`!/python-runtime/${name}`, `!\\python-runtime\\${name}`]);

function signingConfig(signed, env = process.env) {
  if (!signed) return { win: { signExecutable: false }, forceCodeSigning: false };
  const certificateSha1 = env.SESSIONDOCK_CERT_SHA1;
  if (!env.WIN_CSC_LINK && !env.CSC_LINK && !certificateSha1) {
    throw new Error('서명 배포에는 CSC_LINK / WIN_CSC_LINK 또는 SESSIONDOCK_CERT_SHA1을 설정해야 합니다. 인증서 없이 배포본을 서명된 것으로 만들 수 없습니다.');
  }
  if (certificateSha1 && !/^[a-f\d]{40}$/i.test(certificateSha1)) throw new Error('SESSIONDOCK_CERT_SHA1 형식이 올바르지 않습니다.');
  return { forceCodeSigning: true, win: { signExecutable: true, signExts: [...pythonSigningExclusions],
    ...(certificateSha1 ? { signtoolOptions: { certificateSha1 } } : {}) } };
}

function buildOptions(argv = process.argv.slice(2), env = process.env) {
  let signed = false, output, buildOnly = false, allowVersionReset = false;
  const outputFlag = '--config.directories.output';
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--build-only') {
      if (buildOnly) throw new Error('--build-only 인자는 한 번만 지정할 수 있습니다.');
      buildOnly = true;
    } else if (argument === '--signed') {
      if (signed) throw new Error('--signed 인자는 한 번만 지정할 수 있습니다.');
      signed = true;
    } else if (argument === '--allow-version-reset') {
      if (allowVersionReset) throw new Error('--allow-version-reset 인자는 한 번만 지정할 수 있습니다.');
      allowVersionReset = true;
    } else if (argument === outputFlag || argument.startsWith(outputFlag + '=')) {
      if (output !== undefined) throw new Error('빌드 출력 경로는 한 번만 지정할 수 있습니다.');
      const value = argument === outputFlag ? argv[++index] : argument.slice(outputFlag.length + 1);
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || /[\0\r\n]/.test(value)) {
        throw new Error(`${outputFlag}에 비어 있지 않은 출력 경로를 지정해야 합니다.`);
      }
      output = value;
    } else {
      // Report the option name, not an unrecognized option's possible secret.
      throw new Error(`지원하지 않는 빌드 인자: ${argument.split('=', 1)[0]}. 지원: --signed, --build-only, --allow-version-reset, ${outputFlag}=경로`);
    }
  }
  const config = signingConfig(signed, env);
  if (output !== undefined) config.directories = { output };
  return { targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64), config, publish: 'never', allowVersionReset };
}

async function main() {
  const options = buildOptions();
  const buildOnly = process.argv.includes('--build-only');
  const signed = options.config.forceCodeSigning;
  // Keep the reset flag out of the electron-builder configuration object.
  const { allowVersionReset, ...builderOptions } = options;
  console.log(signed ? '인증서 서명이 필수인 Windows 배포본을 빌드합니다.' : '로컬 검증용 Windows 배포본을 빌드합니다. Authenticode 서명 없음.');
  if (allowVersionReset) console.log('--allow-version-reset: 더 최신 버전이 있어도 이 빌드를 게시합니다.');
  await build(builderOptions);
  const path = require('node:path');
  const output = path.resolve(options.config.directories?.output || 'dist');
  const unpacked = path.join(output, 'win-unpacked');
  if (signed) await require('./verify-release-signature.cjs').verify(unpacked);
  const publisher = require('./publish-portable.cjs');
  publisher.prepareZip({ outputDirectory: output });
  await require('./release-manifest.cjs').writeManifest({ directory: unpacked, kinds: ['zip'] });
  if (!buildOnly) {
    const report = publisher.publishZip({ outputDirectory: output, allowVersionReset });
    console.log(JSON.stringify(report, null, 2));
    if (report.cleanupErrors.length) throw new Error('최신 ZIP을 게시했으나 이전 배포 파일 일부를 정리하지 못했습니다. release-publish.json을 확인해 주세요.');
  }
}
if (require.main === module) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
  // Builder cleanup listeners must not turn a later copy/cleanup failure into 0.
  process.on('exit', () => { process.exitCode = 1; });
});
module.exports = { signingConfig, buildOptions };
