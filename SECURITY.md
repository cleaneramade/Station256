# Security policy

## Reporting a vulnerability

Please report security problems privately. **Open a private security advisory on GitHub** from this repository's Security tab. Do not open a public issue or post details in a discussion.

Include what you found, the steps to reproduce it, what you expected, and which version you ran.

## What we care about most

Station 256 is built so that AI running in a room cannot reach your Windows files, other projects or your home network. Reports about any of these are the most useful:

- a way out of a room (to the house, to Windows, to the LAN, or to another project)
- a way to change or delete anything on C: while it is open for viewing
- a way around the House Rules (Allow / Ask / Block)
- a way for a web page, or the AI using the Web Browser, to reach Station's files, this PC or the home network
- a secret (key, token or link secret) written somewhere other people can read

## Known limits

These are documented and accepted, so they are not vulnerabilities: inside the house, `root` can mount `C:`, and anyone in the `docker` group is effectively root. See "Security and privacy" in the [README](README.md).

## Supported versions

Only the newest release gets fixes.
