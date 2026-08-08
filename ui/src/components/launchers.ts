import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Launcher } from '../types';

/** The bare agents, as the dialogs show them before the backend answers —
    and as they stay if it never does. Mirrors core.rs BARE_AGENTS. */
export const BARE_LAUNCHERS: readonly Launcher[] = [
  { name: 'claude', agent: 'claude', profile: false },
  { name: 'codex', agent: 'codex', profile: false },
  { name: 'gemini', agent: 'gemini', profile: false },
  { name: 'aider', agent: 'aider', profile: false },
];

/**
 * The launch list both dialogs render: bare agents, then profiles, from the
 * backend. Starts with the bare agents so the dialog is usable on the very
 * first frame; the profiles arrive a beat later, appended rather than
 * replacing what the person may already be looking at.
 */
export function useLaunchers(): readonly Launcher[] {
  const [launchers, setLaunchers] = useState<readonly Launcher[]>(BARE_LAUNCHERS);
  useEffect(() => {
    let live = true;
    void api
      .listLaunchers()
      .then((list) => {
        if (live && list.length > 0) setLaunchers(list);
      })
      .catch(() => {
        /* the bare agents are already there */
      });
    return () => {
      live = false;
    };
  }, []);
  return launchers;
}
