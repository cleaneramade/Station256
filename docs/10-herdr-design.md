# Herdr in the Dev House — the design

Draft, 2026-11-06. Nothing built. No third-party plugins, by decision. Every
bridge is ours, so a Herdr update can't break someone else's code.

This replaces an earlier draft that put Herdr in the house and reached into
rooms with `docker exec`. That shape needed a custom watcher and a request
slot. The shape below needs neither.

---

## Where Herdr sits

**Herdr runs inside each room. The house runs a Herdr client that adds each
room as a "machine", so you still get one sidebar across every project.**

```
Windows
  └─ Station 256
       ├─ tab: "Agents"  -> herdr client, in the house
       │      ├─ machine: house            (local shell)
       │      ├─ machine: room-sitea       -> ssh -> herdr in that room
       │      │                                 ├─ pane -> claude
       │      │                                 ├─ pane -> codex
       │      │                                 └─ pane -> gemini
       │      └─ machine: room-platformb   -> ssh -> herdr in that room
       └─ tab: plain house shell           (unchanged)
```

Herdr supports this natively. Combining local work and saved SSH machines in
one window, with one combined agent list, is a built-in feature — not a plugin
and not something we invent.

### Why this is better than the old shape

| | Old shape (house + docker exec) | This shape (room + SSH machine) |
|---|---|---|
| Agent status | broken; needed a custom watcher | works, it is a normal SSH session |
| Socket escape risk | real; needed a hard rule and a slot | gone; the socket is inside the cage |
| Agent opens its own panes | only through a request slot | normal Herdr, no bridge |
| One sidebar, all projects | yes | yes |
| Custom code | a watcher plus a slot plus a cap | about 15 lines |

The escape problem disappears because Herdr's socket now lives **inside** the
room. An agent reaching it can only ever act on its own room.

## Proven on this machine, 2026-11-06

Tried end to end on a throwaway room, then torn down. Herdr 0.9.5.

| Checked | Result |
|---|---|
| Herdr installs to your own folder, no admin | yes, checksum-verified, one file |
| A room can run an SSH door as the ordinary room user | yes, no cage change needed |
| The house can SSH into a room by name | yes |
| Herdr and Claude both work inside the room over SSH | yes |
| **Herdr detects the agent and reports its state** | **yes — reported "idle"** |
| Herdr saves the room as a machine and calls it reachable | yes |
| Room still cannot reach the house, another room, or the LAN | yes, all blocked |
| Room still has no admin and no Docker control | yes |
| Windows cannot reach the room's SSH door | yes, blocked |
| The house private key is nowhere in the backup | yes, confirmed |
| The Herdr server only runs while Herdr is open | yes |

That last row matters: the server is not a permanent background process, so
the sleep problem is smaller than first thought.

**Not proven yet:** that the sidebar visually shows the house and every room in
one combined list. The connection between them is live and each side reports
its own agents correctly, but the combined view is a screen, so it needs one
look from you. Nothing else is waiting on it.

## Built on 2026-11-06

| Piece | State |
|---|---|
| Herdr installed in the house | done |
| House key, kept outside `~/house` | done |
| Room blueprint: ssh door, Herdr, Codex, Gemini | done |
| A host key per room, kept in the house | done |
| A secrets folder per project, mounted read-only | done |
| `room open` names the room and adds it to Herdr | done |
| `room close` removes it again | done |
| House keeper ignores the Herdr server | done 2026-11-08 (see below) |
| Station 256: an **Agents** entry in the new-tab menu | done |
| `herdr-test.sh`, the wall tests | done |
| Theme | left for last, on purpose |
| The GitHub button | not started — needs your GitHub account |

**Keeper, finished 2026-11-08.** The first version only stopped Herdr counting
as *working*. It still counted as a *background job*, so a house Herdr left
running after a test (started 2026-11-07 16:44) kept the house awake all night.
Now `house_jobs` in `house-keeper.sh` leaves out Herdr itself and any shell
under it with nothing running in it. Anything running in a Herdr shell still
keeps the house awake. Tested by `keeper-test.sh`. Deployed with:

```
sudo install -m 755 ~/house/house-keeper.sh /usr/local/sbin/house-keeper && sudo systemctl restart house-keeper
```

## Does this break the cages?

No. Direction of travel is unchanged.

| | Before | After |
|---|---|---|
| Room -> Windows | blocked | blocked |
| Room -> house | blocked | blocked |
| Room -> other rooms | blocked | blocked |
| House -> room | allowed | allowed, plus SSH on the private room network |

The only new thing is an SSH service in the room, listening on the private
Docker network and nowhere else.

## Why no tunnel software

Cloudflare Tunnel and Twingate solve remote access — reaching a machine across
the internet. The house and the rooms are on the same machine, on a private
network Docker created. Nothing leaves the PC.

Routing that through a tunnel would send local traffic out to the internet and
back. That adds exposure, not safety.

Cloudflare earns its place only if we later want to reach the house from a
phone or another location. Out of scope here.

## The SSH setup

Nothing custom. OpenSSH is standard, decades old, and the most reviewed
software of its kind.

In the room image:

- `openssh-server` installed
- password login off, keyboard-interactive off — **keys only**
- the house public key in the room user's `authorized_keys`
- no forwarding of any kind: no TCP, no agent, no tunnels, no X11
- listening only on the room's `house-rooms` interface, never published to the
  host, so Windows and the LAN cannot reach it
- the `herdr` binary installed too, because Herdr needs it on the far side

**Tested:** the SSH service runs as the ordinary room user on port 22. The cage
keeps `--cap-drop ALL`, `--user 1000:1000` and `no-new-privileges` exactly as
they are. No capability had to be added.

An SSH session does not inherit the room's environment, so the room writes its
own `~/.ssh/environment` at start-up with the PATH and the Claude token. The
token therefore stays out of the image.

In the house:

- one key pair, made once at install time, at `~/.ssh/house_rooms`
- private key readable by the house user only
- **outside `~/house`**, which is what the backup mirrors, so it can never be
  copied into the backup or committed

No port is ever published. When a room opens, the house writes a small SSH
entry naming that room, so nothing depends on typing an address.

### Host keys — one per room

Each room gets its own host key, kept in the house and handed to the room
read-only at start-up. Kept in the house means a rebuilt room keeps its
identity, so Herdr never reports a changed key.

One shared key for all rooms would also work, since rooms cannot reach each
other, but per-room costs nothing and is cleanly better.

### Keys: who holds what

| | Where it lives | Secret |
|---|---|---|
| Private key | the house only | yes — never leaves |
| Public key | baked into every room | no — it is the lock, not the key |

A room holds **no private key at all**, so a room can be unlocked into but can
never unlock anything itself.

**One key for every room**, not one per room. Rooms already cannot reach each
other, so a per-room key buys almost nothing and adds a file to manage on every
new project.

**No passphrase.** The key never leaves the machine, and Herdr has to open
rooms without stopping to ask.

## Project secrets

Separate from the SSH key, and separate from each other. This is the part that
prevents one project ever using another project's credentials.

Everything secret sits **outside `~/house`**, because the backup mirrors
`~/house`. This was a real mistake in the first draft of this file, caught
before anything was built.

```
~/.ssh/                        <- the house key. Rooms never see it
~/.config/house/
  claude-token                 <- already there
  secrets/
    sitea/                     <- mounted into room "sitea" only
    platformb/                 <- mounted into room "platformb" only
```

Why a room cannot reach another project's keys: **the folder is not attached.**
When `room open sitea` runs, only that project's folder is mounted. The folder
for any other project does not exist inside that room. It is not a permission
that can be set wrong — the file is simply absent.

Rules:

- secrets live **outside** the project folder, so they can never be committed
- mounted **read-only**: a room can use a key, never change or add one
- **never backed up**
- each project gets its own credentials, never one shared set

### GitHub access: two layers

| Token | Where it lives | What it can reach |
|---|---|---|
| House | the house only | list your repos, read-only |
| Project | that one room only | that one repo, read or read+write |

The house token's only job is to list repos so you can pick one from a menu.
Keeping it read-only means it is not a single point of total loss.

**A universal token is never mounted into a room.** Even read-only, that room
could read every repo you own, and rooms are where AI runs.

**GitHub is never part of opening a project.** Plenty of projects are local
only, and a project that will have a repo might not have one yet. So this is
not a step in any flow.

**It is a button.** A GitHub icon in the Station 256 sidebar, sitting with the
lock and performance buttons. Clicking it starts the process; not clicking it
means the project stays local for ever and nothing asks about it again.

What the button does, by state:

| State | What clicking it does |
|---|---|
| Account not connected | connects it — browser opens, tick which repos to allow, done |
| Connected, project not linked | pick an existing repo, **or create a new one here** |
| Project linked | shows the repo and the rights, and can unlink |

**A GitHub App, not pasted tokens.** Station 256 mints the per-repo credential
itself and it **expires in an hour**. Nothing to copy, nothing stored
long-term, and a stolen key is close to worthless. More work on our side; none
on yours.

Creating a repo from the button needs one extra permission on the app. Worth
having, because "connect this project" and "this repo does not exist yet" are
the same moment in practice.

## What has to be built

Six pieces. Most of it is configuration, not code.

### 1. Room image — SSH and Herdr

Add to the room Dockerfile: `openssh-server`, a keys-only config, the house
public key, and the `herdr` binary. Also add the Codex and Gemini CLIs, since
the point is running agents side by side.

**Serves:** makes a room reachable and Herdr-ready.
**Risk:** low. It is a new service, so the safety tests have to cover it.

### 2. The house key

Generated once during install, into the house's `.ssh`, owner-only, no
passphrase, excluded from the backup.

**Serves:** the only way into a room.
**Risk:** low, but the exclusion from the backup must be tested, not assumed.

### 3. `room open` registers the room with Herdr

When a room starts, it signs itself up as a Herdr machine. When it stops, it is
removed.

**Serves:** the combined sidebar fills itself in. No manual step.
**Risk:** low. Today's `room open` behaviour stays available.

### 4. House keeper — ignore the Herdr client

The keeper counts any background process as a reason to stay awake. The Herdr
client in the house is one, so the house would never sleep.

Add it to the ignore list, as with WSL's hidden login shell. Sleep still
behaves correctly, because an open room is already a light.

**Serves:** keeps the 10-minute sleep.
**Risk:** small, one script, covered by the existing sleep test.

### 5. Station 256 — one tab runs Herdr

One tab points at the Herdr client instead of a plain shell. Other tabs are
unchanged.

**Serves:** Herdr lives inside Station 256, not as a rival window.
**Risk:** small, and reversible by pointing the tab back at a shell.

### 6. Looks — `config.toml`

Theme colours to match Station 256's Windows 11 light look, sidebar rows
showing project, agent and state, and keys that do not fight Station 256's own.

Worth being clear: this is theming and sidebar text, not free-form visual
design. Herdr's real layout system belongs to its desktop app, which we are not
using.

**Serves:** looks like part of the app.
**Risk:** none.

## Tests — prove the walls still stand

Added to the existing scripts:

- A room still cannot reach the house, the LAN, Windows, or another room
- **A room cannot SSH anywhere** — it holds no private key
- **A room's SSH service is not reachable from Windows or the LAN**
- **One room cannot see another room's secrets folder**
- **The house private key is not in the backup**
- Still no docker socket in a room, still no sudo
- Agent status shows up in the house sidebar for a room's panes
- The house still sleeps when nothing is working

**Serves:** this is how we know we did not open a hole.
**Risk:** skipping it is the risk.

## Order of work

1. `room new herdrtest` — a throwaway room, never a real project
2. Install Herdr in the house, bare, no plugins
3. Piece 2, the key
4. Piece 1, the room image
5. Piece 3, registering the machine — confirm the combined sidebar really fills
6. The tests, especially the SSH and secrets ones
7. Piece 4, the keeper
8. Piece 5, the Station 256 tab
9. Piece 6, the theme

Steps 1 to 6 cannot touch a real project. Steps 7 and 8 are the only shared
parts, and by then we know it works.

## If it goes wrong

Everything is on `main` with a verified backup. Rolling back is:

- Point the Station 256 tab at a plain shell
- Undo the keeper's ignore line
- Rebuild rooms from the old Dockerfile
- Remove one binary

`room open` never changed, so the normal way of working is always there.

## Answered during the trial

- **Can Herdr reach a room without SSH?** No. Machines are SSH only. There is
  no Docker transport, so SSH is required, not a preference.
- **Does the room need Herdr installed?** Yes. Herdr prepares a server on the
  far side, so the binary has to be in the room image.
- **Does agent detection survive the hop?** Yes. This is the question the old
  `docker exec` design failed, and SSH passes it.

## Still to decide

1. Whether the Herdr tab opens with Station 256, or only when asked for.
2. Whether `room new` should offer Herdr automatically for new projects.
3. How Codex and Gemini API keys are stored and capped — they bill per use.
