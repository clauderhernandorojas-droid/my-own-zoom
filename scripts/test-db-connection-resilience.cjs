/**
 * Tests de resiliencia DB: cortes recuperables no tumban HTTP ni el proceso.
 * node scripts/test-db-connection-resilience.cjs
 */
const http = require('http');
const { withDbRetry, runSchemaBootstrap } = require('../src/services/dbBootstrap');

const FAST_RETRY = { max: 5, delaysMs: [0, 0, 0, 0, 0] };

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  OK ${msg}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${msg}`);
  }
}

function makeConnectionError(msg = 'Connection terminated unexpectedly') {
  const e = new Error(msg);
  e.name = 'SequelizeConnectionError';
  return e;
}

function createMockSequelize({ authFailsBeforeOk = 0, queryFailsBeforeOk = 0 } = {}) {
  let authAttempts = 0;
  let queryAttempts = 0;
  return {
    authenticate: async () => {
      authAttempts += 1;
      if (authAttempts <= authFailsBeforeOk) throw makeConnectionError();
    },
    query: async () => {
      queryAttempts += 1;
      if (queryAttempts <= queryFailsBeforeOk) throw makeConnectionError();
      return [[], {}];
    },
    getDialect: () => 'postgres',
    sync: async () => {},
    _stats: () => ({ authAttempts, queryAttempts }),
  };
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url?.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'my-own-zoom' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function fetchHealth(port) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/health`, (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, body });
        });
      })
      .on('error', reject);
  });
}

function withExitSpy(fn) {
  const calls = [];
  const original = process.exit;
  process.exit = (code) => {
    calls.push(code);
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.exit = original;
    })
    .then((result) => ({ result, calls }));
}

async function scenarioA() {
  console.log('\nEscenario A: DB lenta al arrancar (authenticate)');
  const sequelize = createMockSequelize({ authFailsBeforeOk: 2 });
  const { server, port } = await startHealthServer();

  const healthBefore = await fetchHealth(port);
  assert(healthBefore.status === 200, 'A: /health 200 mientras DB aún no autenticó');

  const { result, calls } = await withExitSpy(async () => {
    return runSchemaBootstrap(
      sequelize,
      [{ name: 'noop', run: async () => {} }],
      FAST_RETRY
    );
  });

  assert(result.ok === true, 'A: bootstrap OK tras reintentos de authenticate');
  assert(sequelize._stats().authAttempts === 3, 'A: authenticate OK tras 3 intentos');
  const healthAfter = await fetchHealth(port);
  assert(healthAfter.status === 200, 'A: /health 200 tras bootstrap');
  assert(calls.length === 0, 'A: process.exit no llamado');

  await new Promise((r) => server.close(r));
}

async function scenarioB() {
  console.log('\nEscenario B: ensureReunionExceptionColumns falla una vez, luego OK');
  const sequelize = createMockSequelize({ authFailsBeforeOk: 0 });
  let ensureAttempts = 0;
  const { server, port } = await startHealthServer();

  const { result, calls } = await withExitSpy(async () => {
    return runSchemaBootstrap(
      sequelize,
      [
        {
          name: 'ensureReunionExceptionColumns',
          run: async () => {
            ensureAttempts += 1;
            if (ensureAttempts === 1) throw makeConnectionError();
          },
        },
        { name: 'sync', run: async () => {} },
      ],
      FAST_RETRY
    );
  });

  assert(result.ok === true, 'B: bootstrap OK tras fallo temporal de ensure*');
  assert(ensureAttempts === 2, 'B: ensure* OK tras 1 fallo + 1 éxito');
  assert(result.failedSteps.length === 0, 'B: failedSteps vacío');

  // Continuidad: step no recuperable → no tumba; siguiente step corre
  const sequelizeCont = createMockSequelize();
  const bootCont = await runSchemaBootstrap(
    sequelizeCont,
    [
      {
        name: 'ensureReunionExceptionColumns',
        run: async () => {
          throw new Error('schema boom');
        },
      },
      { name: 'sync', run: async () => {} },
    ],
    FAST_RETRY
  );
  assert(bootCont.ok === false, 'B: bootstrap incompleto si un step falla sin recuperar');
  assert(
    bootCont.failedSteps.includes('ensureReunionExceptionColumns'),
    'B: failedSteps incluye ensureReunionExceptionColumns'
  );
  assert(!bootCont.failedSteps.includes('sync'), 'B: sync posterior se ejecutó');

  const health = await fetchHealth(port);
  assert(health.status === 200, 'B: /health 200');
  assert(calls.length === 0, 'B: process.exit no llamado');

  await new Promise((r) => server.close(r));
}

async function scenarioC() {
  console.log('\nEscenario C: corte a mitad de vida + withDbRetry en query');
  const sequelize = createMockSequelize({ queryFailsBeforeOk: 1 });
  const { server, port } = await startHealthServer();

  const { calls } = await withExitSpy(async () => {
    await withDbRetry(() => sequelize.query('SELECT 1'), FAST_RETRY);
  });

  assert(sequelize._stats().queryAttempts === 2, 'C: query OK tras 1 fallo + 1 éxito');
  const health = await fetchHealth(port);
  assert(health.status === 200, 'C: /health 200');
  assert(calls.length === 0, 'C: process.exit no llamado');

  await new Promise((r) => server.close(r));
}

async function main() {
  console.log('test-db-connection-resilience');
  await scenarioA();
  await scenarioB();
  await scenarioC();
  console.log(`\nResultado: ${passed} OK, ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
