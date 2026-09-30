// Routing policy behaviour: escalation, path detection, advisory text, modes, plan order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectFromPaths, route, routingTable, suggestFromText } from '../.claude/tools/route.mjs';
import { loadPolicy } from '../.claude/tools/lib.mjs';

test('LOW with no signals stays with the lead', () => {
  const r = route({ risk: 'LOW', paths: ['docs/guide.md'] });
  assert.equal(r.risk, 'LOW');
  assert.deepEqual(r.required, []);
  assert.equal(r.implementer, 'lead');
  assert.equal(r.ledger, false);
});

test('risk only escalates: a flag with a higher minimum raises it', () => {
  assert.equal(route({ risk: 'STANDARD', flags: ['security'] }).risk, 'HIGH');
  assert.equal(route({ risk: 'HIGH', flags: ['ci'] }).risk, 'HIGH');
  assert.equal(route({ risk: 'LOW', flags: ['api-change'] }).risk, 'STANDARD');
});

test('a LOW task that picks up a specialist becomes STANDARD with an implementer and verifier', () => {
  const r = route({ risk: 'LOW', uncertainty: ['root-cause-unknown'] });
  assert.equal(r.risk, 'STANDARD');
  assert.ok(r.required.includes('software-engineer') && r.required.includes('verifier'));
  assert.match(r.escalations.join(' '), /require at least STANDARD/);
});

test('paths are mandatory evidence across stacks', () => {
  const cases = {
    security: ['src/auth/session.ts', 'app/controllers/sessions_controller.rb', 'api/permissions.py', 'services/Payments/charge.cs'],
    'data-schema': ['migrations/001_init.sql', 'db/migrate/20260101_add_col.rb', 'prisma/schema.prisma', 'app/alembic/versions/x.py'],
    infrastructure: ['Dockerfile', 'infra/main.tf', 'charts/api/values.yaml', 'docker-compose.prod.yml'],
    ci: ['.github/workflows/ci.yml', '.gitlab-ci.yml', 'Jenkinsfile'],
    dependency: ['package.json', 'go.mod', 'Cargo.lock', 'requirements.txt', 'pom.xml', 'App.csproj'],
    'api-change': ['src/routes/users.ts', 'api/openapi.yaml', 'proto/user.proto'],
    ui: ['src/components/Button.tsx', 'web/styles/site.scss', 'Views/Home/Index.cshtml'],
  };
  for (const [flag, paths] of Object.entries(cases)) {
    for (const p of paths) assert.ok(detectFromPaths([p]).has(flag), `${p} should imply ${flag}`);
  }
  assert.equal(detectFromPaths(['AUTHORS.md']).has('security'), false, 'AUTHORS is not auth code');
  assert.equal(detectFromPaths(['src/utils/format.ts']).size, 0);
});

test('breadth implies multi-module', () => {
  assert.ok(detectFromPaths(['api/a.ts', 'web/b.ts', 'shared/c.ts']).has('multi-module'));
  assert.ok(detectFromPaths(Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`)).has('multi-module'));
  assert.equal(detectFromPaths(['src/a.ts', 'tests/a.test.ts']).has('multi-module'), false);
});

test('text only suggests, and never adds agents by itself', () => {
  const r = route({ risk: 'STANDARD', text: "Don't change the database schema or the auth flow" });
  assert.ok('data-schema' in r.suggested_flags && 'security' in r.suggested_flags);
  assert.ok(!r.required.includes('database-engineer') && !r.required.includes('security-engineer'));
  assert.equal(suggestFromText('').size, 0);
});

test('plan follows diagnose → design → implement → verify → review', () => {
  const r = route({ risk: 'STANDARD', flags: ['data-schema', 'security'], uncertainty: ['root-cause-unknown'] });
  const phases = r.plan.map((s) => s.phase);
  const order = loadPolicy().phases;
  assert.deepEqual(phases, [...phases].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  assert.equal(r.plan[0].agent, 'investigator');
  assert.equal(r.plan.at(-1).agent, 'senior-reviewer');
});

test('approvals come from flags; push and merge are always gated', () => {
  const r = route({ risk: 'STANDARD', flags: ['production', 'data-destructive'] });
  assert.deepEqual(r.approvals.map((a) => a.action).sort(), ['deploy-production', 'destructive-data']);
  assert.deepEqual(r.gated_actions.map((a) => a.action), ['push', 'merge']);
  assert.deepEqual(route({ risk: 'STANDARD', flags: ['security'] }).approvals, []);
});

test('modes: review and investigate change nothing', () => {
  const review = route({ risk: 'STANDARD', flags: ['security'], mode: 'review' });
  assert.deepEqual(review.required, ['security-engineer', 'senior-reviewer']);
  assert.equal(review.implementer, 'none');
  assert.equal(review.rollback_plan, false);
  const inv = route({ risk: 'LOW', mode: 'investigate' });
  assert.deepEqual(inv.required, ['investigator']);
  assert.equal(inv.risk, 'LOW', 'investigating does not escalate risk by itself');
});

test('HIGH implementation is upgraded to the stronger model', () => {
  assert.equal(route({ risk: 'HIGH' }).implementer_model, 'opus');
  assert.equal(route({ risk: 'STANDARD' }).implementer_model, null);
});

test('unknown inputs are errors, not silent defaults', () => {
  assert.ok(route({ risk: 'MEDIUM' }).errors);
  assert.ok(route({ flags: ['nope'] }).errors);
  assert.ok(route({ mode: 'deploy' }).errors);
});

test('routing table covers every signal', () => {
  const table = routingTable();
  const p = loadPolicy();
  for (const f of Object.keys(p.flags)) assert.match(table, new RegExp(`\`${f}\``));
  for (const u of Object.keys(p.uncertainty)) assert.match(table, new RegExp(`\`${u}\``));
});

test('one diagnostician per failure: platform-engineer replaces the investigator for CI/deploy failures', () => {
  const ci = route({ risk: 'STANDARD', flags: ['ci'], uncertainty: ['root-cause-unknown'] });
  assert.ok(ci.required.includes('platform-engineer') && !ci.required.includes('investigator'));
  assert.ok(ci.required.includes('senior-reviewer'), 'the unknown root cause still earns a senior review');
  const perf = route({ risk: 'STANDARD', flags: ['ci', 'performance'], uncertainty: ['root-cause-unknown'] });
  assert.ok(perf.required.includes('investigator'), 'performance still brings the investigator');
});
