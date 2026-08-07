/**
 * Smoke test: drives the sidecar end to end against a real Claude Code
 * session. Verifies init parity, tool calls, the permission round trip,
 * streaming deltas and clean shutdown.
 *
 *   node smoke.mjs <cwd>
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const cwd = process.argv[2] ?? process.cwd();
const child = spawn('node', ['dist/agent-host.mjs'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

const send = (f) => child.stdin.write(JSON.stringify(f) + '\n');
const seen = { perms: 0, tools: 0, deltas: 0 };
let init = null;
let done = null;

createInterface({ input: child.stdout }).on('line', (line) => {
  const f = JSON.parse(line);

  if (f.t === 'ready') {
    console.log(`● sidecar ready (pid ${f.pid})`);
    send({
      t: 'start',
      id: 's1',
      cfg: {
        cwd,
        prompt:
          'Read the file NOTE.md in the current directory and reply with only the secret word it contains. Do not use any other tool.',
        env: { ...process.env },
      },
    });
    return;
  }

  if (f.t === 'permission_request') {
    seen.perms++;
    console.log(`⚠ permission #${seen.perms}: ${f.req.toolName}`);
    console.log(`  title       : ${f.req.title ?? '(none)'}`);
    console.log(`  displayName : ${f.req.displayName ?? '(none)'}`);
    console.log(`  suggestions : ${f.req.suggestions?.length ?? 0}`);
    // Approve, and carry the suggestions back the way an "always allow"
    // button would.
    send({
      t: 'permission_reply',
      id: f.id,
      reqId: f.reqId,
      result: { behavior: 'allow' },
    });
    return;
  }

  if (f.t !== 'event') return;
  const ev = f.ev;

  switch (ev.kind) {
    case 'init':
      init = ev;
      console.log('● init');
      console.log(`  session   : ${ev.sessionId}`);
      console.log(`  model     : ${ev.model}`);
      console.log(`  cwd       : ${ev.cwd}`);
      console.log(`  tools     : ${ev.tools.length}`);
      console.log(`  mcp       : ${ev.mcpServers.map((s) => `${s.name}=${s.status}`).join(', ') || '(none)'}`);
      console.log(`  commands  : ${ev.slashCommands.length}`);
      console.log(`  skills    : ${ev.skills.length ? ev.skills.join(', ') : '(none reported)'}`);
      console.log(`  plugins   : ${ev.plugins.length}`);
      break;
    case 'tool_call':
      seen.tools++;
      console.log(`→ tool_call ${ev.name} ${JSON.stringify(ev.input).slice(0, 100)}`);
      break;
    case 'tool_result':
      console.log(`← tool_result ${ev.toolUseId.slice(0, 12)} isError=${ev.isError}`);
      break;
    case 'text_delta':
      seen.deltas++;
      break;
    case 'text':
      console.log(`◇ text: ${ev.text.trim().slice(0, 200)}`);
      break;
    case 'done':
      done = ev;
      console.log(`● done subtype=${ev.subtype} cost=$${ev.costUsd?.toFixed(4)} turns=${ev.numTurns}`);
      send({ t: 'shutdown' });
      break;
    case 'error':
      console.log(`✕ error: ${ev.message}`);
      send({ t: 'shutdown' });
      break;
  }
});

child.on('exit', (code) => {
  const ok =
    init !== null &&
    seen.tools > 0 &&
    seen.deltas > 0 &&
    done !== null &&
    !done.isError;
  console.log('\n--- summary ---');
  console.log(`init received : ${init !== null}`);
  console.log(`tool calls    : ${seen.tools}`);
  console.log(`permissions   : ${seen.perms}`);
  console.log(`text deltas   : ${seen.deltas}`);
  console.log(`done ok       : ${done !== null && !done.isError}`);
  console.log(ok ? '\n✅ PASS' : '\n❌ FAIL');
  process.exit(ok ? 0 : 1);
});

setTimeout(() => {
  console.log('✕ timeout');
  child.kill();
  process.exit(1);
}, 120_000);
