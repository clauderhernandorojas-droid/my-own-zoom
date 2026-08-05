/**
 * Reintentos y bootstrap de esquema DB (Postgres/SQLite).
 * Errores de conexión recuperables no deben tumbar el proceso HTTP.
 */

function isRecoverableDbError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  const msg = String(err.message || err.parent?.message || '');
  const code = String(err.code || err.parent?.code || '');
  if (/SequelizeConnectionError|ConnectionError/i.test(name)) return true;
  if (/Connection terminated|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE/i.test(msg)) return true;
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE/i.test(code)) return true;
  return false;
}

/**
 * @param {() => Promise<any>} fn
 * @param {{ max?: number, delaysMs?: number[] }} [opts]
 */
async function withDbRetry(fn, opts = {}) {
  const max = opts.max ?? 5;
  const delaysMs = opts.delaysMs ?? [1000, 2000, 4000, 8000, 8000];
  let last;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isRecoverableDbError(e) || i >= max - 1) throw e;
      const delay = delaysMs[Math.min(i, delaysMs.length - 1)] ?? 1000;
      console.warn(`[db] retry ${i + 1}/${max}: ${e?.message || e}`);
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw last;
}

/**
 * @param {import('sequelize').Sequelize} sequelize
 * @param {{ name: string, run: () => Promise<any> }[]} steps
 * @param {{ max?: number, delaysMs?: number[] }} [retryOpts]
 * @returns {Promise<{ ok: boolean, failedSteps: string[] }>}
 */
async function runSchemaBootstrap(sequelize, steps, retryOpts) {
  const failedSteps = [];
  await withDbRetry(() => sequelize.authenticate(), retryOpts);

  for (const step of steps || []) {
    const name = step?.name || 'unknown';
    try {
      await withDbRetry(() => step.run(), retryOpts);
    } catch (err) {
      console.error('[db] bootstrap step failed:', name, err?.message || err);
      failedSteps.push(name);
    }
  }

  return { ok: failedSteps.length === 0, failedSteps };
}

module.exports = {
  isRecoverableDbError,
  withDbRetry,
  runSchemaBootstrap,
};
