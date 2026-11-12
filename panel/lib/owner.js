// The owner's name, for "Last edited by" when they changed a file themselves: the name set in git
// (`git config --global user.name`) if there is one, else the account name with a capital first letter.
// Read once, in the background.
const { execFile } = require('child_process');
const os = require('os');

const fromAccount = (account) => (account ? account.charAt(0).toUpperCase() + account.slice(1) : 'You');

let known = null;
function name() {
  if (!known) {
    known = new Promise((resolve) => {
      execFile('git', ['config', '--global', 'user.name'], { timeout: 4000 }, (error, stdout) => {
        const set = error ? '' : String(stdout).trim().slice(0, 60);
        let account = '';
        try { account = os.userInfo().username; } catch { /* no account name */ }
        resolve(set || fromAccount(account));
      });
    });
  }
  return known;
}

module.exports = { name, fromAccount };
