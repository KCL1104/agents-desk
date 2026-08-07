/**
 * Smoke test 2: the permission round trip, multi-turn input, and interrupt.
 *
 * Turn 1 asks for a Bash command that default mode will not auto-approve.
 * The first request is denied, the second (a follow-up turn) is allowed,
 * so both branches of canUseTool are exercised on a live session.
 *
 *   node smoke-perm.mjs <cwd>
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const cwd = process.argv[2] ?? process.cwd();
const child = spawn('node', ['dist/agent-host.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (f) => child.stdin.write(JSON.stringify(f) + '\n');

const log = [];
let denied = false;
let allowed = false;
let secondTurn = false;
let settled = 0;
let doneCount = 0;

createInterface({ input: child.stdout }).on('line', (line) => {
  const f = JSON.parse(line);

  if (f.t === 'ready') {
    send({
      t: 'start',
      id: 's1',
      cfg: {
        cwd,
        prompt:
          'Run exactly this shell command, nothing else: touch /tmp/agentdesk_perm_probe && echo touched',
        env: { ...process.env },
      },
    });
    return;
  }

  if (f.t === 'permission_request') {
    const { toolName, title, displayName, suggestions } = f.req;
    console.log(`⚠ permission: ${toolName} — ${title ?? displayName ?? '(no title)'}`);
    console.log(`  input       : ${JSON.stringify(f.req.input).slice(0, 120)}`);
    console.log(`  suggestions : ${suggestions?.length ?? 0}`);

    if (!denied) {
      denied = true;
      console.log('  → DENY (testing the deny branch)');
      send({
        t: 'permission_reply',
        id: f.id,
        reqId: f.reqId,
        result: { behavior: 'deny', message: 'Blocked by AgentDesk test policy.' },
      });
    } else {
      allowed = true;
      console.log('  → ALLOW');
      send({ t: 'permission_reply', id: f.id, reqId: f.reqId, result: { behavior: 'allow' } });
    }
    return;
  }

  if (f.t === 'permission_settled') {
    settled++;
    return;
  }

  if (f.t !== 'event') return;
  const ev = f.ev;

  if (ev.kind === 'tool_call') console.log(`→ ${ev.name} ${JSON.stringify(ev.input).slice(0, 80)}`);
  if (ev.kind === 'tool_result') console.log(`← result isError=${ev.isError}`);
  if (ev.kind === 'text') {
    console.log(`◇ ${ev.text.trim().slice(0, 160)}`);
    log.push(ev.text);
  }

  if (ev.kind === 'done') {
    doneCount++;
    console.log(`● turn ${doneCount} done (${ev.subtype})`);
    if (doneCount === 1) {
      // Multi-turn: push a follow-up into the same live session.
      secondTurn = true;
      console.log('\n--- follow-up turn on the same session ---');
      send({ t: 'send', id: 's1', text: 'Please try that exact command again.' });
    } else {
      send({ t: 'shutdown' });
    }
  }

  if (ev.kind === 'error') {
    console.log(`✕ ${ev.message}`);
    send({ t: 'shutdown' });
  }
});

child.on('exit', () => {
  const ok = denied && allowed && secondTurn && settled >= 2;
  console.log('\n--- summary ---');
  console.log(`deny branch exercised  : ${denied}`);
  console.log(`allow branch exercised : ${allowed}`);
  console.log(`follow-up turn sent    : ${secondTurn}`);
  console.log(`settled notifications  : ${settled}`);
  console.log(ok ? '\n✅ PASS' : '\n❌ FAIL');
  process.exit(ok ? 0 : 1);
});

setTimeout(() => {
  console.log('✕ timeout');
  child.kill();
  process.exit(1);
}, 180_000);
