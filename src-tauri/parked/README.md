# Parked: Agent SDK path

These files implement sessions via the Claude Agent SDK instead of a PTY:
structured events, a `canUseTool` permission callback wired to a native
dialog, and a rule engine that could auto-allow or auto-deny before the user
was ever asked.

They are proven working (the integration test drove a real `claude` session
end to end) but are not part of the build, because sessions are now real
terminals and Claude Code's own TUI handles its own permission prompts.

Bring them back if Marol ever needs to intercept tool calls rather than
just host them — a headless/background mode, or a policy layer that must
decide without a human present.

The Node half still lives at `../../sidecar/` and builds independently.
