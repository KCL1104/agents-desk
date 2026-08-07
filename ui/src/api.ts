import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { BootStatus, SessionMeta, Tab } from './types';

export const api = {
  bootStatus: () => invoke<BootStatus>('boot_status'),

  newSession: (cwd: string, agent: string, args: string[], cols: number, rows: number) =>
    invoke<string>('new_session', { cwd, agent, args, cols, rows }),

  reopenSession: (id: string, cols: number, rows: number) =>
    invoke<void>('reopen_session', { id, cols, rows }),

  termWrite: (id: string, data: string) => invoke<void>('term_write', { id, data }),
  termResize: (id: string, cols: number, rows: number) =>
    invoke<void>('term_resize', { id, cols, rows }),

  closeSession: (id: string) => invoke<void>('close_session', { id }),
  archiveSession: (id: string) => invoke<void>('archive_session', { id }),
  setCompleted: (id: string, completed: boolean) =>
    invoke<void>('set_completed', { id, completed }),
  listSessions: () => invoke<SessionMeta[]>('list_sessions'),

  listTabs: () => invoke<Tab[]>('list_tabs'),
  createTab: (name: string) => invoke<string>('create_tab', { name }),
  renameTab: (id: string, name: string) => invoke<void>('rename_tab', { id, name }),
  closeTab: (id: string) => invoke<void>('close_tab', { id }),
  updateTab: (id: string, layout: string, slots: Array<string | null>) =>
    invoke<void>('update_tab', { id, layout, slots }),

  /** Replay buffer for a pane mounting after its PTY already started. */
  termSnapshot: (id: string) => invoke<{ data: string; seq: number }>('term_snapshot', { id }),

  /** Subscribe to one session's terminal output. Data is base64 bytes. */
  onTermOutput: (id: string, cb: (data: string, seq: number) => void): Promise<UnlistenFn> =>
    listen<{ id: string; data: string; seq: number }>('term:output', (e) => {
      if (e.payload.id === id) cb(e.payload.data, e.payload.seq);
    }),
};

export interface Handlers {
  onSessions: (s: SessionMeta[]) => void;
  onExit: (id: string, status: string) => void;
  onTabs: (tabs: Tab[]) => void;
  onBadge: (count: number) => void;
  onCoreReady: () => void;
  onCoreFailed: (error: string) => void;
}

export async function subscribe(h: Handlers): Promise<UnlistenFn> {
  const offs: UnlistenFn[] = [];
  offs.push(await listen<SessionMeta[]>('sessions:changed', (e) => h.onSessions(e.payload)));
  offs.push(
    await listen<{ id: string; status: string }>('term:exit', (e) =>
      h.onExit(e.payload.id, e.payload.status),
    ),
  );
  offs.push(await listen<Tab[]>('tabs:changed', (e) => h.onTabs(e.payload)));
  offs.push(
    await listen<{ count: number }>('badge', (e) => h.onBadge(e.payload.count)),
  );
  offs.push(await listen('core:ready', () => h.onCoreReady()));
  offs.push(await listen<{ error: string }>('core:failed', (e) => h.onCoreFailed(e.payload.error)));
  return () => offs.forEach((off) => off());
}
