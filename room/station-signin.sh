# Read by every interactive shell in a room (from /etc/bash.bashrc).
#
# A room signs in to Claude with the house's shared key (room login), which can only chat. A full
# Claude sign-in made inside a room (/login in Claude) is kept in that project's own Claude folder.
# When there is one, Claude is started with it instead, so things that need it work, such as
# Remote Control. The shared key wins over a full sign-in when both are set, which is why it is
# taken away here. Checked before every prompt, so it applies from the next command after /login,
# and the shared key comes back if that sign-in is removed (/logout).
__station_chat_key="${CLAUDE_CODE_OAUTH_TOKEN:-}"
__station_signin() {
  [ -n "$__station_chat_key" ] || return 0
  # A full sign-in has a refresh token under claudeAiOauth. Other sign-ins in that file (tools that
  # log in to their own services) don't count. -z reads the whole file as one piece.
  if grep -qszE '"claudeAiOauth"[[:space:]]*:[[:space:]]*\{[^}]*"refreshToken"[[:space:]]*:[[:space:]]*"[^"]' \
      "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"; then
    unset CLAUDE_CODE_OAUTH_TOKEN
  else
    export CLAUDE_CODE_OAUTH_TOKEN="$__station_chat_key"
  fi
}
case ";${PROMPT_COMMAND:-};" in
  *";__station_signin;"*) ;;
  *) PROMPT_COMMAND="__station_signin${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
__station_signin
