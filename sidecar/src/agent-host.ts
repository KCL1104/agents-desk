/**
 * agent-host — the Claude Code executor.
 *
 * One process multiplexes every session. Each session owns an Agent SDK
 * `query()` whose underlying `claude` child process provides the real
 * isolation, so a single host process is enough.
 *
 * Deliberately absent: `settingSources`. Omitting it means the SDK loads
 * exactly what an interactive terminal session loads — user/project/local
 * settings.json, CLAUDE.md, .claude/ skills, agents, commands and hooks,
 * plus .mcp.json. Setting it to anything (even the full list) is a chance
 * to drift from that, so we don't.
 */

import { createInterface } from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  PermissionMode,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEvent,
  AskKind,
  HostFrame,
  PermissionReply,
  PermissionRequest,
  SidecarFrame,
  StartConfig,
} from './protocol.js';

/* ------------------------------------------------------------------ */
/* Wire                                                                */
/* ------------------------------------------------------------------ */

function out(frame: SidecarFrame): void {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

function log(msg: string, extra?: unknown): void {
  const suffix = extra === undefined ? '' : ' ' + safeStringify(extra);
  process.stderr.write(`[agent-host] ${msg}${suffix}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emit(id: string, ev: AgentEvent): void {
  out({ t: 'event', id, ev });
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

/** An async queue that doubles as the SDK's streaming-input source. */
class Inbox {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      // Stamp provenance: this really is a human typing into the app.
      origin: { kind: 'human' },
    } as SDKUserMessage);
    this.wake?.();
    this.wake = null;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  async *stream(first?: string): AsyncGenerator<SDKUserMessage> {
    if (first !== undefined) this.push(first);
    while (!this.closed) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        continue;
      }
      yield this.queue.shift()!;
    }
  }
}

interface Session {
  id: string;
  q: Query;
  inbox: Inbox;
  /** Permission requests awaiting a decision from the UI. */
  pending: Map<string, (result: PermissionReply) => void>;
}

const sessions = new Map<string, Session>();
let reqSeq = 0;

/* ------------------------------------------------------------------ */
/* Message normalization                                               */
/* ------------------------------------------------------------------ */

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function normalize(id: string, msg: SDKMessage): void {
  const m = msg as SDKMessage & Record<string, unknown>;

  switch (m.type) {
    case 'system': {
      if (m.subtype !== 'init') return;
      const s = m as unknown as Record<string, unknown>;
      emit(id, {
        kind: 'init',
        sessionId: String(s.session_id ?? ''),
        model: String(s.model ?? ''),
        cwd: String(s.cwd ?? ''),
        permissionMode: String(s.permissionMode ?? 'default'),
        tools: asStringArray(s.tools),
        mcpServers: asServerList(s.mcp_servers),
        slashCommands: asStringArray(s.slash_commands),
        skills: asStringArray(s.skills),
        plugins: asArray(s.plugins),
        pluginErrors: asArray(s.plugin_errors),
        mcpServerErrors: asArray(s.mcp_server_errors),
      });
      return;
    }

    case 'assistant': {
      const blocks = (m.message as { content?: ContentBlock[] } | undefined)?.content ?? [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          emit(id, { kind: 'text', text: b.text });
        } else if (b.type === 'thinking' && b.thinking) {
          emit(id, { kind: 'thinking', text: b.thinking });
        } else if (b.type === 'tool_use') {
          emit(id, {
            kind: 'tool_call',
            toolUseId: String(b.id ?? ''),
            name: String(b.name ?? ''),
            input: b.input,
          });
        }
      }
      return;
    }

    case 'user': {
      // Tool results arrive on the user turn.
      const blocks = (m.message as { content?: ContentBlock[] | string } | undefined)?.content;
      if (!Array.isArray(blocks)) return;
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue;
        emit(id, {
          kind: 'tool_result',
          toolUseId: String(b.tool_use_id ?? ''),
          content: b.content,
          isError: b.is_error === true,
        });
      }
      return;
    }

    case 'stream_event': {
      // Token-level deltas, enabled by includePartialMessages.
      const ev = m.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      const delta = ev?.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        emit(id, { kind: 'text_delta', text: delta.text });
      }
      return;
    }

    case 'result': {
      const r = m as unknown as Record<string, unknown>;
      emit(id, {
        kind: 'done',
        subtype: String(r.subtype ?? ''),
        isError: r.is_error === true,
        costUsd: numberOrUndefined(r.total_cost_usd),
        durationMs: numberOrUndefined(r.duration_ms),
        numTurns: numberOrUndefined(r.num_turns),
        result: typeof r.result === 'string' ? r.result : undefined,
        sessionId: typeof r.session_id === 'string' ? r.session_id : undefined,
      });
      return;
    }

    default:
      // The union is broad and grows; unknown kinds are simply not rendered.
      return;
  }
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asServerList(v: unknown): Array<{ name: string; status: string }> {
  if (!Array.isArray(v)) return [];
  return v.map((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return { name: String(o.name ?? ''), status: String(o.status ?? 'unknown') };
  });
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/* ------------------------------------------------------------------ */
/* Start a session                                                     */
/* ------------------------------------------------------------------ */

function start(id: string, cfg: StartConfig): void {
  if (sessions.has(id)) {
    log(`session ${id} already running, ignoring start`);
    return;
  }

  const inbox = new Inbox();
  const pending = new Map<string, (r: PermissionReply) => void>();

  const options: Options = {
    cwd: cfg.cwd,
    includePartialMessages: true,
    permissionMode: cfg.permissionMode ?? 'default',
    // settingSources intentionally omitted — see file header.
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.resume ? { resume: cfg.resume } : {}),
    ...(cfg.forkSession ? { forkSession: true } : {}),
    ...(cfg.env ? { env: cfg.env as Options['env'] } : {}),
    ...(cfg.claudePath ? { pathToClaudeCodeExecutable: cfg.claudePath } : {}),

    stderr: (data: string) => log(`[${id}] claude: ${data.trimEnd()}`),

    canUseTool: async (toolName, input, opts) => {
      const reqId = `p${++reqSeq}`;
      const req: PermissionRequest = {
        toolName,
        input,
        title: opts.title,
        displayName: opts.displayName,
        decisionReason: opts.decisionReason,
        blockedPath: opts.blockedPath,
        suggestions: opts.suggestions,
      };
      out({ t: 'permission_request', id, reqId, req });

      return new Promise((resolve) => {
        pending.set(reqId, (result) => {
          pending.delete(reqId);
          out({ t: 'permission_settled', id, reqId });
          resolve(result);
        });

        // If the turn is aborted while we're waiting, stop blocking it.
        opts.signal.addEventListener(
          'abort',
          () => {
            if (!pending.has(reqId)) return;
            pending.delete(reqId);
            out({ t: 'permission_settled', id, reqId });
            resolve({ behavior: 'deny', message: 'Interrupted before a decision was made.' });
          },
          { once: true },
        );
      });
    },
  };

  const q = query({ prompt: inbox.stream(cfg.prompt), options });
  sessions.set(id, { id, q, inbox, pending });

  void (async () => {
    try {
      for await (const msg of q) normalize(id, msg);
    } catch (err) {
      emit(id, { kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      sessions.delete(id);
      emit(id, { kind: 'closed' });
    }
  })();
}

/* ------------------------------------------------------------------ */
/* Introspection                                                       */
/* ------------------------------------------------------------------ */

async function ask(s: Session, reqId: string, what: AskKind): Promise<void> {
  try {
    let data: unknown;
    switch (what) {
      case 'context':
        data = await s.q.getContextUsage();
        break;
      case 'mcp_status':
        data = await s.q.mcpServerStatus();
        break;
      case 'commands':
        data = await s.q.supportedCommands();
        break;
      case 'models':
        data = await s.q.supportedModels();
        break;
    }
    out({ t: 'reply', reqId, ok: true, data });
  } catch (err) {
    out({ t: 'reply', reqId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/* ------------------------------------------------------------------ */
/* Frame dispatch                                                      */
/* ------------------------------------------------------------------ */

async function handle(frame: HostFrame): Promise<void> {
  if (frame.t === 'shutdown') {
    for (const s of sessions.values()) {
      s.inbox.close();
      s.q.close();
    }
    sessions.clear();
    process.exit(0);
  }

  if (frame.t === 'start') {
    start(frame.id, frame.cfg);
    return;
  }

  const s = sessions.get(frame.id);
  if (!s) {
    log(`no such session: ${frame.id} (frame ${frame.t})`);
    return;
  }

  switch (frame.t) {
    case 'send':
      s.inbox.push(frame.text);
      return;
    case 'interrupt':
      await s.q.interrupt().catch((e: unknown) => log('interrupt failed', String(e)));
      return;
    case 'set_mode':
      await s.q.setPermissionMode(frame.mode as PermissionMode).catch((e: unknown) =>
        log('setPermissionMode failed', String(e)),
      );
      return;
    case 'set_model':
      await s.q.setModel(frame.model).catch((e: unknown) => log('setModel failed', String(e)));
      return;
    case 'permission_reply': {
      const resolve = s.pending.get(frame.reqId);
      if (resolve) resolve(frame.result);
      else log(`stale permission reply ${frame.reqId}`);
      return;
    }
    case 'ask':
      await ask(s, frame.reqId, frame.what);
      return;
    case 'close':
      s.inbox.close();
      s.q.close();
      sessions.delete(frame.id);
      emit(frame.id, { kind: 'closed' });
      return;
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const rl = createInterface({ input: process.stdin });

rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let frame: HostFrame;
  try {
    frame = JSON.parse(trimmed) as HostFrame;
  } catch {
    log(`bad frame: ${trimmed.slice(0, 200)}`);
    return;
  }
  void handle(frame).catch((err: unknown) => log('handler threw', String(err)));
});

rl.on('close', () => {
  for (const s of sessions.values()) {
    s.inbox.close();
    s.q.close();
  }
  process.exit(0);
});

out({ t: 'ready', pid: process.pid });
log(`ready, node ${process.version}`);
