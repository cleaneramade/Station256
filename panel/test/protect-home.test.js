// Checks for bin/protect-home.js, the guard Claude Code runs before every shell command.
// Run with: node panel/test/protect-home.test.js
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
require('os').userInfo = () => ({ username: 'alex' }); // a pretend user: the paths below are "your home"
const guard = path.join(__dirname, '..', '..', 'bin', 'protect-home.js');
const { check } = require(guard);

let passed = 0;
const stops = (command, cwd) => {
  assert.ok(check(command, cwd), `should be stopped: ${command}`);
  passed += 1;
};
const allows = (command, cwd) => {
  assert.strictEqual(check(command, cwd), null, `should be allowed: ${command}`);
  passed += 1;
};

// The command that wiped /home/alex on 2026-11-08, as it was sent.
stops('wsl.exe -d Ubuntu --cd /tmp -- bash -lc "export HOME=`$(mktemp -d); cd ~; touch a; rm -rf `"`$HOME`" /tmp/x"');
stops('wsl.exe -d Ubuntu -- bash -lc "rm -rf /tmp/scratch"');
stops('rm -rf //wsl.localhost/Ubuntu/var/tmp/pp');
stops('HOME=/tmp/fake rm -rf "$HOME/x"');

// Home, projects and Station 256, in Linux.
stops('rm -rf ~');
stops('rm -rf ~/');
stops('rm -rf "$HOME"');
stops('rm -rf ${HOME}/');
stops('rm -rf /home/alex');
stops('rm -fr /home/alex/*');
stops('sudo rm -r --no-preserve-root /');
stops('rm -rf ~/projects');
stops('rm -rf ~/projects/*');
stops('rm -rf "/home/alex/projects/Notes App"');
stops('rm -rf ~/house');
stops('rm -rf ~/.config/house');
stops('rm -rf ~/.ssh');
stops('cd ~ && rm -rf *');
stops('cd /home/alex/projects; rm -rf RustApp');
stops('rm -rf *', '/home/alex');
stops('rm -rf ../..', '/home/alex/projects/RustApp');
stops('find ~ -delete');
stops('find /home/alex/projects -mindepth 1 -exec rm -rf {} +');
stops('python3 -c "import shutil; shutil.rmtree(\'/home/alex\')"');
stops('rm -rf /workspace');
stops('rm -rf /workspace/*');

// Windows.
stops('Remove-Item -Recurse -Force C:\\Users\\Alex');
stops('Remove-Item -LiteralPath "$env:USERPROFILE\\Documents" -Recurse -Force');
stops('rm -r -fo C:\\Users\\Alex\\Documents\\*');
stops('cmd /c rd /s /q "C:\\Users\\Alex\\Documents\\Station Backup"');
stops('robocopy C:\\empty "C:\\Users\\Alex\\Documents\\Station Backup\\projects-backup" /MIR');
stops('Remove-Item -Recurse "C:\\Users\\Alex\\Documents\\Station Backup\\projects-backup\\RustApp"');
stops('Remove-Item "$env:LOCALAPPDATA\\Packages\\Canonical\\LocalState\\ext4.vhdx"');
stops('wsl.exe --unregister Ubuntu');
stops('rm -rf /c/Users/Alex');

// Docker's saved room records.
stops('docker volume prune -f');
stops('docker system prune -a --volumes');
stops('docker volume rm house-claude-RustApp');

// Everyday work goes ahead.
allows('rm -rf /tmp/build-123');
allows('rm -rf node_modules dist', '/home/alex/projects/RustApp/rustapp');
allows('rm -rf ~/projects/RustApp/rustapp/target');
allows('rm -rf "/home/alex/projects/Notes App/Notes 2.0/dist"');
allows('rm notes.txt', '/home/alex');
allows('rm -f ~/.cache/station-256/pastes/old.png');
allows('find . -name "*.tmp" -delete', '/home/alex/projects/RustApp');
allows('git status && ls -la ~');
allows('wsl.exe -d Ubuntu -e bash /var/tmp/x.sh');
allows('robocopy "\\\\wsl.localhost\\Ubuntu\\home\\alex\\house" "C:\\Users\\Alex\\Documents\\Station Backup\\house" /MIR /XD node_modules');
allows("cat > //wsl.localhost/Ubuntu/var/tmp/x.sh <<'EOF'\n#!/bin/bash\nd=$(mktemp -d)\nrm -rf -- \"$d\"\nEOF\necho written");
allows('Remove-Item -Recurse -Force "$env:TEMP\\claude\\scratch\\old"');
allows('docker volume ls');
allows('wsl.exe --unregister Rescue');
// The distro this runs in is protected too, whatever it is called.
process.env.WSL_DISTRO_NAME = 'Station256';
stops('wsl.exe --unregister Station256');
stops('wsl --unregister "station256"');
allows('wsl.exe --unregister Station256Test');
stops('wsl.exe --unregister Ubuntu');
delete process.env.WSL_DISTRO_NAME;
allows('npm install', '/home/alex/house/panel');

// A here-document fed to a shell is still checked.
stops("bash <<'EOF'\nrm -rf ~\nEOF");

// Through Claude Code: a stopped command gets a "deny" answer, an allowed one gets nothing.
const run = (input) => spawnSync(process.execPath, [guard], { input: JSON.stringify(input), encoding: 'utf8' }).stdout;
const denied = JSON.parse(run({ tool_name: 'Bash', tool_input: { command: 'rm -rf ~' }, cwd: '/tmp' }));
assert.strictEqual(denied.hookSpecificOutput.permissionDecision, 'deny');
assert.match(denied.hookSpecificOutput.permissionDecisionReason, /delete guard/);
assert.strictEqual(run({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp' }), '');
assert.strictEqual(run({ tool_name: 'Read', tool_input: { file_path: '/home/alex' } }), '');
assert.strictEqual(spawnSync(process.execPath, [guard], { input: 'not json', encoding: 'utf8' }).stdout, '');
passed += 4;

console.log(`${passed} checks passed`);
