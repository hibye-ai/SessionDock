'use strict';
const { Server, utils } = require('ssh2');
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { colorFixture } = require('./color-fixture.cjs');
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

async function createFixture(root, { allowNone = false, port = 0 } = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'welcome.txt'), 'SessionDock SFTP fixture\n한글 파일 전송\n');
  fs.writeFileSync(path.join(root, 'denied.txt'), 'remote denied fixture');
  fs.writeFileSync(path.join(root, 'protected.txt'), 'KEEP_REMOTE_ORIGINAL');
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const clients = new Set(), sockets = new Set();
  const metrics = { shellCommands: [], shellChannels: [], inputBytes: [], windowChanges: [], ptys: [], authentications: 0, directoryDelay: 0, sftpChannels: [],
    sftpRequests: [], sftpDelay: {}, sftpHold: new Set(), pendingSftp: [], sftpFailures: new Map(),
    symbolicLinks: new Map(), beforeSftp: null };
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      if ((ctx.method === 'none' && allowNone === true)
        || (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'fixture-only-password')) { metrics.authentications++; ctx.accept(); }
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('pty', (acceptPty, reject, info) => { metrics.ptys.push(info); acceptPty?.(); });
        session.on('window-change', (acceptResize, _reject, info) => { metrics.windowChanges.push(info); acceptResize?.(); });
        session.on('shell', acceptShell => {
          const channel = acceptShell(); channel.on('error', () => {});
          metrics.shellChannels.push(channel);
          channel.write('\x1b[32mLocal SSH test server\x1b[0m\r\n\r\ntester@local:~$ ');
          let pending = '';
          channel.on('data', data => {
            metrics.inputBytes.push(Buffer.from(data));
            pending += data.toString('utf8');
            let position;
            while ((position = pending.search(/[\r\n]/)) >= 0) {
              const command = pending.slice(0, position); pending = pending.slice(position + 1).replace(/^\n/, '');
              metrics.shellCommands.push(command);
              if (command === 'exit') { channel.exit(0); channel.end(); return; }
              if (colorFixture(command, data => channel.write(data))) continue;
              const result = command.startsWith('echo ') ? command.slice(5) : command === 'whoami' ? 'tester' : command === 'pwd' ? '/home/tester' : `executed: ${command}`;
              channel.write(command + '\r\n' + result + '\r\ntester@local:~$ ');
            }
          });
        });
        session.on('sftp', acceptSftp => { const channel=acceptSftp();metrics.sftpChannels.push(channel);installSftp(channel, root, metrics); });
      });
      client.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1') { reject(); return; }
        const socket = net.connect(info.destPort, '127.0.0.1'); sockets.add(socket);
        socket.on('error', () => { try { reject(); } catch {} socket.destroy(); }); socket.on('close', () => sockets.delete(socket));
        socket.once('connect', () => { const channel = accept(); channel.on('error', () => socket.destroy()); channel.once('close', () => socket.destroy()); socket.pipe(channel).pipe(socket); });
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { host: '127.0.0.1', port: server.address().port, metrics, key, disconnectAll(){for(const client of clients)client.end();}, async close() { for (const socket of sockets) socket.destroy(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); } };
}
function installSftp(stream, root, metrics) {
  let next = 1; const handles = new Map(), timers = new Set();
  root = path.resolve(root);
  stream.on('error', () => {});
  const normalized = name => path.posix.resolve('/home/tester', name);
  const mapped = (name, follow = true) => {
    let remote = normalized(name);
    // Virtual links let Windows tests exercise lstat/unlink without requiring
    // symlink privileges. No fixture path may escape its temporary root.
    if (follow) for (let depth = 0; depth < 16; depth++) {
      const link = [...metrics.symbolicLinks].find(([source]) => remote === source || remote.startsWith(source + '/'));
      if (!link) break;
      remote = normalized(path.posix.join(link[1], remote.slice(link[0].length)));
      if (depth === 15) throw new Error('Too many fixture links');
    }
    const relative = remote.replace(/^\/home\/tester(?:\/|$)/, '').replace(/^\//, '');
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Outside fixture');
    return target;
  };
  const attrs = (name, follow = true) => {
    const link = metrics.symbolicLinks.get(normalized(name));
    if (link !== undefined && !follow) return { mode: 0o120777, uid: 0, gid: 0, size: Buffer.byteLength(link), atime: 100, mtime: 100 };
    const stat = follow ? fs.statSync(mapped(name)) : fs.lstatSync(mapped(name, false));
    return { mode: stat.mode, uid: 0, gid: 0, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) };
  };
  const fail = (id, error) => stream.status(id, error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE
    : ['EACCES', 'EPERM'].includes(error.code) ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE);
  const wrap = (operation, handler) => (id, ...args) => {
    metrics.sftpRequests.push({ operation, paths: args.filter(value => typeof value === 'string') });
    const run = () => {
      if (stream.destroyed) return;
      try {
        metrics.beforeSftp?.(operation, ...args);
        const failure = metrics.sftpFailures.get(`${operation}:${args[0]}`) ?? metrics.sftpFailures.get(operation);
        if (failure !== undefined) { stream.status(id, failure); return; }
        handler(id, ...args);
      } catch (error) { fail(id, error); }
    };
    if (metrics.sftpHold.has(operation) || metrics.sftpHold.has(`${operation}:${args[0]}`)) {
      metrics.pendingSftp.push({ operation, args, resume: run });
    } else if (metrics.sftpDelay[operation]) {
      const timer = setTimeout(() => { timers.delete(timer); run(); }, metrics.sftpDelay[operation]); timers.add(timer);
    } else run();
  };
  const add = value => { const handle = Buffer.alloc(4); handle.writeUInt32BE(next); handles.set(next++, value); return handle; };
  const get = handle => handles.get(handle.readUInt32BE(0));
  stream.on('REALPATH', wrap('REALPATH', (id, name) => { const filename = normalized(name); stream.name(id, [{ filename, longname: filename, attrs: attrs(filename) }]); }));
  stream.on('STAT', wrap('STAT', (id, name) => stream.attrs(id, attrs(name))));
  stream.on('LSTAT', wrap('LSTAT', (id, name) => stream.attrs(id, attrs(name, false))));
  stream.on('FSTAT', wrap('FSTAT', (id, handle) => { const value = get(handle); const stat = fs.fstatSync(value.fd); stream.attrs(id, { mode: stat.mode, uid: 0, gid: 0, size: stat.size, atime: 0, mtime: 0 }); }));
  stream.on('OPENDIR', wrap('OPENDIR', (id, name) => { const directory = mapped(name), value = { dir: directory, remote: normalized(name), read: false }; if (metrics.directoryDelay) setTimeout(() => { if (!stream.destroyed) { try { stream.handle(id, add(value)); } catch {} } }, metrics.directoryDelay); else stream.handle(id, add(value)); }));
  stream.on('READDIR', wrap('READDIR', (id, handle) => {
    const value = get(handle); if (value.read) { stream.status(id, STATUS_CODE.EOF); return; } value.read = true;
    const filenames = new Set(fs.readdirSync(value.dir));
    for (const link of metrics.symbolicLinks.keys()) if (path.posix.dirname(link) === value.remote) filenames.add(path.posix.basename(link));
    const names = [...filenames].map(filename => ({ filename, longname: filename, attrs: attrs(path.posix.join(value.remote, filename), false) }));
    if (names.length) stream.name(id, names); else stream.status(id, STATUS_CODE.EOF);
  }));
  stream.on('OPEN', wrap('OPEN', (id, name, flags) => { const writable = !!(flags & OPEN_MODE.WRITE); const filename = mapped(name); if(!writable && path.basename(filename)==='denied.txt'){stream.status(id,STATUS_CODE.PERMISSION_DENIED);return;}const mode = writable ? (flags & OPEN_MODE.EXCL ? 'wx' : flags & OPEN_MODE.TRUNC ? 'w' : 'r+') : 'r'; stream.handle(id, add({ fd: fs.openSync(filename, mode) })); }));
  stream.on('READ', wrap('READ', (id, handle, offset, length) => { const value = get(handle); const buffer = Buffer.alloc(Math.min(length, 1024 * 1024)); const read = fs.readSync(value.fd, buffer, 0, buffer.length, offset); if (read) stream.data(id, buffer.subarray(0, read)); else stream.status(id, STATUS_CODE.EOF); }));
  stream.on('WRITE', wrap('WRITE', (id, handle, offset, data) => { fs.writeSync(get(handle).fd, data, 0, data.length, offset); stream.status(id, STATUS_CODE.OK); }));
  stream.on('CLOSE', wrap('CLOSE', (id, handle) => { const value = get(handle); if (value?.fd !== undefined) fs.closeSync(value.fd); handles.delete(handle.readUInt32BE(0)); stream.status(id, STATUS_CODE.OK); }));
  const rename = (id, source, target, overwrite = false) => {
    if (path.basename(target) === 'protected.txt') { stream.status(id, STATUS_CODE.PERMISSION_DENIED); return; }
    if (!overwrite) {
      try { attrs(target, false); stream.status(id, STATUS_CODE.FAILURE); return; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (metrics.symbolicLinks.has(source)) {
      const link = metrics.symbolicLinks.get(source); metrics.symbolicLinks.delete(source); metrics.symbolicLinks.set(target, link);
    } else {
      fs.renameSync(mapped(source, false), mapped(target, false));
      for (const [link, destination] of [...metrics.symbolicLinks]) if (link.startsWith(source + '/')) {
        metrics.symbolicLinks.delete(link); metrics.symbolicLinks.set(target + link.slice(source.length), destination);
      }
    }
    stream.status(id, STATUS_CODE.OK);
  };
  stream.on('RENAME', wrap('RENAME', (id, source, target) => rename(id, source, target)));
  stream.on('EXTENDED', wrap('EXTENDED', (id, extension, data) => {
    if (extension !== 'posix-rename@openssh.com') { stream.status(id, STATUS_CODE.OP_UNSUPPORTED); return; }
    const sourceLength = data.readUInt32BE(0), source = data.toString('utf8', 4, 4 + sourceLength);
    const offset = 4 + sourceLength, targetLength = data.readUInt32BE(offset);
    rename(id, source, data.toString('utf8', offset + 4, offset + 4 + targetLength), true);
  }));
  stream.on('MKDIR', wrap('MKDIR', (id, name, attributes) => { if (metrics.symbolicLinks.has(name)) throw new Error('Entry exists'); fs.mkdirSync(mapped(name, false), { mode: attributes.mode ?? 0o755 }); stream.status(id, STATUS_CODE.OK); }));
  stream.on('RMDIR', wrap('RMDIR', (id, name) => { if (metrics.symbolicLinks.has(name) || [...metrics.symbolicLinks.keys()].some(link => link.startsWith(name + '/'))) throw new Error('Not an empty directory'); fs.rmdirSync(mapped(name, false)); stream.status(id, STATUS_CODE.OK); }));
  stream.on('REMOVE', wrap('REMOVE', (id, name) => { if (!metrics.symbolicLinks.delete(name)) fs.unlinkSync(mapped(name, false)); stream.status(id, STATUS_CODE.OK); }));
  stream.on('close', () => { for (const timer of timers) clearTimeout(timer); for (const value of handles.values()) if (value.fd !== undefined) { try { fs.closeSync(value.fd); } catch {} } handles.clear(); });
}
module.exports = { createFixture };
