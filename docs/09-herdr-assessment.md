# Should Herdr go in the Dev House?

Research only, 2026-11-06. Nothing installed. No decision made.

> Note: the shape in this file (Herdr in the house, reaching in with docker
> exec) was superseded. The agreed design is Herdr inside each room, with
> rooms added as SSH machines. See 10-herdr-design.md.

---

## What Herdr is

A terminal workspace built for running several coding agents at once. One Rust
binary, Apache-2.0, about 48k stars, under a year old, $6M seed.

Two things it gives you:

1. **A background server owns the terminals.** Close the window, work keeps
   running. Reopen, you are back where you were.
2. **It shows which agent is stuck** — working, blocked, or idle — for every
   pane, rolled up across tabs and projects.

People call it "tmux built for AI." That is fair. The agent status and the
cross-project sidebar are the parts tmux does not have.

## How it would meet our setup

Our rooms are sealed containers. Herdr wants one server owning many panes. So
the only shape that gives us the cross-project view is:

```
Station 256 terminal tab
  └─ herdr (TUI) running in the house
       ├─ pane -> docker exec into room-projecta -> claude
       ├─ pane -> docker exec into room-projectb -> claude
       └─ pane -> a house shell
```

Herdr runs **in the house**. The agents still run **in the rooms**. That keeps
our rule intact: AI never runs in the house.

## The problem that makes this real work

**Herdr finds an agent by looking at the front process of a pane.** When the
pane runs `docker exec`, the front process is the exec client, not the agent.
The agent is inside the container, so Herdr sees nothing.

No status. No sidebar. The main reason to want Herdr is gone.

### Why that is fixable for us

The known fix passes the pane id into the container, then watches from the
house side:

```bash
docker exec -it -e "HERDR_HOST_PANE_ID=$HERDR_PANE_ID" room-NAME bash
```

A house-side watcher reads `/proc/<pid>/environ` of the container processes,
spots the agent, and reports it back to Herdr.

That watcher needs to read those processes. It works when the container user
has the **same uid as the house user**. Ours does — our room `dev` user is
uid 1000, same as `your-user`. That is luck, not planning, but it means the
approach fits.

## Five things to know before deciding

**1. Container support is not built in.** It is all third-party plugins. The
request for native `docker exec` tracking is still an Idea with **no maintainer
reply**. One plugin author says plainly they have not audited their own code.

**2. Our rooms are not devcontainers.** Most of those plugins drive the Dev
Containers CLI. Ours are plain Docker containers from our own Dockerfile. So we
would either write our own connector or add a `devcontainer.json` we do not
otherwise need. Custom work either way.

**3. Mods and layouts are unsandboxed code, and Herdr does not review them.**
We would be running unaudited JavaScript in the house. Our whole model is built
on sandboxing. This is the sharpest edge.

**4. It would stop the house going to sleep.** Our keeper treats any `your-user`
background process as a light. A Herdr server is exactly that, so the house
would stay awake for ever. We just finished building and testing that sleep. We
would have to teach the keeper to ignore Herdr, or accept it never sleeps.

**5. "Custom design" is less than it sounds — for the part we would use.**
Herdr is two separate programs that do not share agents:

| | What you can design |
|---|---|
| **TUI** (what we would embed) | sidebar token rows, theme colours, keys. `config.toml`, 211 keys |
| **Desktop app** (we would not use) | real layouts, `layouts/*.json`, JS mods |

The rich layout system belongs to the desktop app — the one that competes with
Station 256. Embedding the TUI gets us a themed sidebar, not a designed screen.

## Pros

- Fixes the real gap: closing Station 256 would no longer kill agent work
- Agent status across every project, which Station 256 has nothing like
- Agents can spawn panes and prompt each other
- Works with Claude Code and about 22 other agent CLIs without wrapping them
- One static Linux binary, easy to remove
- Apache-2.0, so a public Station 256 stays possible
- Our uid 1000 room user already satisfies the watcher's requirement

## Cons

- Container support is third-party, unaudited, and officially unanswered
- Without a connector, agent status does not work at all through `docker exec`
- Mods are trusted, unsandboxed code in the house
- Breaks the house sleep we just finished
- Telemetry is on by default in app builds
- Three layers deep: Station 256 tab -> Herdr -> docker exec -> agent
- `tmux` inside a Herdr pane can hide agent detection, so we would pick one
- Herdr does not bring a container agent back after its own server restarts
- Under a year old; recent releases were hotfixes for input regressions
- Possible paid features later

## What we would have to configure

1. Install the Herdr Linux binary in the house
2. Change `room` to open panes through Herdr, forwarding `HERDR_PANE_ID`
3. Write or adopt the house-side watcher so agent status works
4. Teach `house-keeper` to ignore the Herdr server, or drop the sleep rule
5. Theme Herdr to sit nicely inside Station 256, and set the sidebar rows
6. Point Station 256's terminal tab at `herdr` instead of a plain shell
7. Decide tmux **or** Herdr, not both
8. Re-run `safety-test.sh` and `rules-test.sh` — this adds a new path between
   house and rooms

Rough size: a few evenings, and step 3 is the risky one.

## The smaller alternative, for comparison

Run `tmux` inside each room. Station 256's tab attaches to it.

- Fixes the same closing-the-app gap
- One line in the room Dockerfile
- No house-side watcher, no unsandboxed mods, no sleep conflict
- Decades old and boring
- **But:** no agent status, no cross-project view. None of Herdr's real value

## Honest read

Herdr has a place here, and the shape is clear: in the house, under Station 256,
holding panes that exec into rooms. Nothing about our setup rules it out, and
the uid match is a quiet piece of good luck.

What it is not is a drop-in. The one feature worth having — seeing which agent
is blocked — is exactly the feature that does not survive `docker exec` without
work nobody official has signed off on.

Two sensible routes:

- **If the goal is "do not lose my work":** tmux in the room. An evening, no new
  trust, no sleep conflict.
- **If the goal is "see all my agents at once":** Herdr, and accept writing the
  connector and re-testing the walls.

Worth also noting: the agent-status idea is the valuable part, and it is already
on our own roadmap as the right sidebar task manager in phase 3. We could build
it, scoped to our rooms, without taking on unsandboxed mods.

## Sources

- https://github.com/herdrdev/herdr
- https://herdr.dev/tui/docs/install/
- https://herdr.dev/tui/docs/config-reference/
- https://github.com/herdrdev/herdr/discussions/699 — native docker exec tracking, no maintainer reply
- https://github.com/herdrdev/herdr-core/issues/13 — reboot resume, closed not planned
- https://github.com/pglira/herdr-devcontainer-agents — the pane-id watcher
- https://github.com/aviv-baruch/herdr-containers — containers sidebar
- https://github.com/ahati/herdr-devcontainer-spaces — a space per container
- https://github.com/tmih06/herdr-worktree-devcontainer — containers as SSH machines
- https://www.eesel.ai/blog/herdr — herdr vs tmux, caveats
- https://flaviocopes.com/herdr/
