# Blueprint for every project room.
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl git jq less nano nodejs npm \
      openssh-server python3 python3-pip python3-venv ripgrep unzip \
 && rm -rf /var/lib/apt/lists/*

# Ordinary user with the same ID as the house user, so files stay yours.
# No sudo is installed, so there is no way to become admin inside a room.
RUN old_user="$(getent passwd 1000 | cut -d: -f1)"; if [ -n "$old_user" ]; then userdel -r "$old_user" 2>/dev/null || true; fi \
 && old_group="$(getent group 1000 | cut -d: -f1)"; if [ -n "$old_group" ]; then groupdel "$old_group"; fi \
 && groupadd -g 1000 dev && useradd -m -u 1000 -g 1000 -s /bin/bash dev \
 && mkdir -p /workspace /home/dev/.claude /run/sshd \
 && chown -R dev:dev /workspace /home/dev /run/sshd

USER dev
ENV HOME=/home/dev
ENV PATH=/home/dev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV CLAUDE_CONFIG_DIR=/home/dev/.claude
ENV DISABLE_AUTOUPDATER=1

RUN curl -fsSL https://claude.ai/install.sh | bash \
 && rm -rf /home/dev/.claude /home/dev/.claude.json \
 && mkdir -p /home/dev/.claude

# Herdr, because the house reaches this room as a Herdr machine and Herdr
# needs its own program on this side.
RUN curl -fsSL https://herdr.dev/install.sh | sh
# The same light look as the house, for Herdr run from a room's own terminal.
COPY --chown=dev:dev herdr-config.toml /home/dev/.config/herdr/config.toml

# The other two agent programs, so panes can run them side by side. Pinned to
# the versions the house rules were checked against (panel/lib/ai-rules.js), so
# a rebuild never changes them by surprise. Move them up on purpose, then check
# the rules again.
RUN npm config set prefix /home/dev/.local \
 && npm install -g --no-fund --no-audit @openai/codex@0.167.0 @google/gemini-cli@0.67.0 \
 && npm cache clean --force
# Graphify (github.com/Graphify-Labs/graphify), the owner's pick: turns a project into a map of
# how its code fits together, so Claude finds things without reading file after file. Code is
# mapped on this PC, with no account and no AI calls. uv installs it in the room user's own
# folder; room-start gives Claude its /graphify skill and updates it in the background.
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_NO_MODIFY_PATH=1 sh \
 && /home/dev/.local/bin/uv tool install graphifyy==0.9.106 \
 && /home/dev/.local/bin/graphify --version
LABEL house.graphify="1"
# Gemini's light look, to match the white terminals. Rooms start fresh from this
# blueprint, so it is the starting point, not something kept over a choice.
RUN mkdir -p /home/dev/.gemini \
 && printf '{\n  "ui": { "theme": "GitHub Light" }\n}\n' > /home/dev/.gemini/settings.json

# Station 256's room terminal tabs: each is its own Herdr session, set up to look
# like a plain terminal. Its settings are that look plus herdr-tabs.toml, kept in
# their own folder so Agents is not changed. Checked here, so a broken file
# stops the build instead of a tab. After the agent programs, so changing these
# settings never installs those again.
COPY --chown=dev:dev herdr-tabs.toml /tmp/herdr-tabs.toml
COPY --chown=dev:dev station-tab-shell /home/dev/.local/bin/station-tab-shell
RUN chmod 755 /home/dev/.local/bin/station-tab-shell \
 && mkdir -p /home/dev/.config/station-tabs/herdr \
 && { sed '/^\[ui\]/,$d' /home/dev/.config/herdr/config.toml; cat /tmp/herdr-tabs.toml; } \
      > /home/dev/.config/station-tabs/herdr/config.toml \
 && rm /tmp/herdr-tabs.toml \
 && XDG_CONFIG_HOME=/home/dev/.config/station-tabs /home/dev/.local/bin/herdr config check
LABEL house.tabs="1"

# The ssh door. The house public key is handed in at build time, so no key is
# ever written into this file.
ARG HOUSE_PUBKEY=""
RUN mkdir -p /home/dev/.ssh && chmod 700 /home/dev/.ssh \
 && printf "%s\n" "$HOUSE_PUBKEY" > /home/dev/.ssh/authorized_keys \
 && chmod 600 /home/dev/.ssh/authorized_keys
COPY --chown=dev:dev sshd_config /home/dev/.ssh/sshd_config
COPY --chown=dev:dev room-start  /home/dev/room-start
RUN chmod 755 /home/dev/room-start
# Claude's Station Blue look. Each project's Claude folder is its own volume, which hides
# whatever the blueprint puts there, so the look is kept here and room-start copies it in.
COPY station-blue.json /usr/local/share/station-256/station-blue.json

# "Last edited by": Claude, Codex and Gemini each report the project files they
# change, and house-edit-log writes them down where the house can read them
# (/home/dev/.house-edits, mounted by the room script). Claude's hooks come with
# its house rules; Codex's and Gemini's are their system settings, owned by root
# so nothing in the room can change them. Gemini's settings also turn YOLO off
# and name your five folders (panel/lib/ai-rules.js makes that file). The house
# rules for Codex and Gemini are mounted by the room script: Codex's at
# /etc/codex/requirements.toml, Gemini's in /etc/gemini-cli/policies, a folder
# Gemini only reads when root owns it.
USER root
COPY house-edit-log /usr/local/bin/house-edit-log
COPY codex-config.toml /etc/codex/config.toml
COPY gemini-settings.json /etc/gemini-cli/settings.json
RUN mkdir -p /etc/gemini-cli/policies \
 && chmod 755 /usr/local/bin/house-edit-log /etc/codex /etc/gemini-cli /etc/gemini-cli/policies \
 && chmod 644 /etc/codex/config.toml /etc/gemini-cli/settings.json
# A full Claude sign-in made in a room (/login in Claude) is used instead of the shared chat-only
# key, so Remote Control works there. See station-signin.sh.
COPY station-signin.sh /etc/station-signin.sh
RUN chmod 644 /etc/station-signin.sh \
 && printf '\n# Station 256: use a full Claude sign-in made in this room.\n. /etc/station-signin.sh\n' >> /etc/bash.bashrc
USER dev
# Your folders, always there, so Gemini's list of them is never wrong. They stay
# empty unless the "Your folders" rule lets the room use the real ones.
RUN mkdir -p /home/dev/Documents /home/dev/Pictures /home/dev/Music /home/dev/Videos /home/dev/Downloads

WORKDIR /workspace
CMD ["/home/dev/room-start"]
