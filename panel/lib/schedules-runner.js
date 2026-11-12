// The scheduled-task runner: a small program of its own (plain node), started by the panel, that
// carries on after Station 256 closes. One runs at a time (a lock file, see lib/schedules.js). It
// ends by itself when no task is switched on, and it does nothing between runs, so it never keeps
// the house awake by itself: its name is house-schedules, which house-keeper.sh doesn't count as a
// job. Run by hand, for a check:  node schedules-runner.js [--home=/some/folder]
const os = require('os');
const path = require('path');
const fs = require('fs');
const schedules = require('./schedules');

const homeArg = process.argv.find((arg) => arg.startsWith('--home='));
const home = homeArg ? homeArg.slice('--home='.length) : os.homedir();
process.title = `house-schedules --home=${home}`; // the name the keeper ignores, and what the panel looks for
const logFile = path.join(home, '.local', 'state', 'house', 'schedules', 'runner.log');
const note = (text) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`); } catch { /* nowhere to say it */ } };

let runner = null;
let leaving = false;
function leave(code) {
  if (leaving) return;
  leaving = true;
  if (runner) runner.stop(); // ends any run going, and lets go of the lock
  setTimeout(() => process.exit(code), 200);
}

runner = schedules.createRunner({ ...schedules.testOptions(), home, local: true, onIdle: () => leave(0) });
process.on('SIGTERM', () => leave(0));
process.on('SIGINT', () => leave(0));
process.on('uncaughtException', (error) => { note(`stopped by an error: ${error.stack || error}`); leave(1); });
process.on('unhandledRejection', (error) => note(`a problem: ${error && error.stack ? error.stack : error}`));

runner.serve().then((took) => {
  if (!took) process.exit(0); // another runner has the lock
}).catch((error) => {
  note(`couldn't start: ${error.message}`);
  leave(1);
});
