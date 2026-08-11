/**
 * Which agent CLIs this app knows the conventions of.
 *
 * Mirrors `src-tauri/src/agent.rs`, and exists for the same reason that file
 * does: the difference between a CLI Marol can drive and one it can only
 * host shows up in half a dozen places on screen — whether the permission
 * modes are offered, whether a review batch can be sent back through the
 * session's own input, whether a "tell the agent" button is honest — and
 * every one of those used to spell it `agent === 'claude'`.
 *
 * The backend is the authority: it decides what to pass a CLI and what to
 * refuse. This list only decides what to *offer*, so the worst a drift here
 * can do is show a control that then reports a plain refusal — never send
 * something a CLI would choke on.
 */
export const MEASURED_AGENTS = ['claude', 'codex'] as const;

export type MeasuredAgent = (typeof MEASURED_AGENTS)[number];

/**
 * Whether this CLI's conventions are measured — which is to say whether the
 * first prompt is sent for you, a follow-up can go in through the terminal,
 * and a permission mode means anything on its command line.
 */
export function isMeasured(agent: string | null | undefined): boolean {
  return MEASURED_AGENTS.includes(agent as MeasuredAgent);
}
