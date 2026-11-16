// Ports a room listens on: real /proc/net/tcp lines, any port 1024-65535, tcp and tcp6, listening only.
const assert = require('assert');
const { listening } = require('../lib/ports');

const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const v4 = (addr, st) => `   0: ${addr} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 1 1 0\n`;
const v6 = (addr, st) => `   0: ${addr} 00000000000000000000000000000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 1 1 0\n`;
let n = 0;
const ok = (c, m) => { assert(c, m); console.log(`PASS ${m}`); n++; };

// 36795 = 0x8FBB
ok(listening(head + v4('0100007F:8FBB', '0A')).has(36795), '127.0.0.1:36795 listening (tcp)');
ok(listening(head + v6('00000000000000000000000001000000:8FBB', '0A')).has(36795), '[::1]:36795 listening (tcp6)');
ok(listening(head + v6('0000000000000000FFFF00000100007F:8FBB', '0A')).has(36795), '[::ffff:127.0.0.1]:36795 listening (tcp6)');
ok(listening(head + v4('00000000:FFFF', '0A')).has(65535), '0.0.0.0:65535 listening');
ok(listening(head + v4('0100007F:0400', '0A')).has(1024), '127.0.0.1:1024 listening');
ok(!listening(head + v4('0100007F:8FBB', '01')).has(36795), 'an established connection is not listening');
ok(!listening(head + v4('0B00000A:8FBB', '0A')).size, 'a listener on the room\'s own network address is skipped');
ok(!listening(head + v4('0100007F:0016', '0A')).size, 'ssh door (22) is skipped');
console.log(`${n} passed, 0 failed`);
