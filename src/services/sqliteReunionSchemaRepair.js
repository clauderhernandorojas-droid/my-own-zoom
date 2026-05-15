/**
 * Repara esquemas SQLite rotos tras renombrar reuniones → reuniones_old_roomuniq
 * y borrar la tabla antigua: las FKs pueden seguir apuntando al nombre fantasma.
 */

const GHOST_PARENT = 'reuniones_old_roomuniq';
const CANON_PARENT = 'reuniones';

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Sequelize puede devolver formas distintas para PRAGMA; siempre devolvemos un array. */
function rowsFromQueryResult(result) {
  if (!result || !Array.isArray(result)) return [];
  const first = result[0];
  return Array.isArray(first) ? first : [];
}

async function listUserTables(sequelize) {
  const result = await sequelize.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );
  const rows = rowsFromQueryResult(result);
  return rows.map((r) => r.name);
}

async function tableExists(sequelize, name) {
  const result = await sequelize.query(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`,
    { replacements: [name] }
  );
  return rowsFromQueryResult(result).length > 0;
}

function buildColumnDefsFromTableInfo(cols) {
  const pkCols = cols.filter((c) => Number(c.pk) > 0);
  const pkCount = pkCols.length;
  return cols.map((c) => {
    const ctype = String(c.type || 'TEXT').toUpperCase();
    let def = `${quoteIdent(c.name)} ${ctype}`;
    const isPk = Number(c.pk) > 0;
    if (Number(c.notnull) === 1 && !(pkCount === 1 && isPk)) def += ' NOT NULL';
    if (c.dflt_value != null && String(c.dflt_value) !== '') def += ` DEFAULT ${c.dflt_value}`;
    if (pkCount === 1 && Number(c.pk) === 1) def += ' PRIMARY KEY';
    return def;
  });
}

function buildForeignKeyClauses(fkRows) {
  const clauses = [];
  for (const fk of fkRows) {
    const parent = String(fk.table || '');
    const parentFixed = parent === GHOST_PARENT ? CANON_PARENT : parent;
    const fromCol = quoteIdent(fk.from);
    const toCol = quoteIdent(fk.to || 'reunion_id');
    clauses.push(`FOREIGN KEY (${fromCol}) REFERENCES ${quoteIdent(parentFixed)} (${toCol})`);
  }
  return clauses;
}

/** Extrae pares (fromCol, parentTable, toCol) del CREATE TABLE cuando PRAGMA foreign_key_list falla o está vacío. */
function parseForeignKeysFromCreateTableSql(ddl) {
  if (!ddl || typeof ddl !== 'string') return [];
  const out = [];
  /** Columnas con backticks (DDL típico Sequelize/SQLite). */
  const reBt =
    /`([^`]+)`\s+[^,]*?REFERENCES\s+[`"]?([^`"()\s]+)[`"]?\s*\(\s*[`"]?([^`")]+)[`"]?\s*\)/gi;
  let m;
  while ((m = reBt.exec(ddl)) !== null) {
    const from = String(m[1] || '').trim();
    const table = String(m[2] || '').trim();
    const to = String(m[3] || '').trim();
    if (from && table && to) {
      out.push({ from, table, to });
    }
  }
  if (out.length) return out;
  /** Identificadores entre comillas dobles (exportaciones SQLite alternativas). */
  const reDq =
    /"([^"]+)"\s+[^,]*?REFERENCES\s+[`"]?([^`"()\s]+)[`"]?\s*\(\s*[`"]?([^`")]+)[`"]?\s*\)/gi;
  while ((m = reDq.exec(ddl)) !== null) {
    const from = String(m[1] || '').trim();
    const table = String(m[2] || '').trim();
    const to = String(m[3] || '').trim();
    if (from && table && to) {
      out.push({ from, table, to });
    }
  }
  return out;
}

async function dropTriggersAndViewsReferencingGhost(sequelize) {
  const result = await sequelize.query(
    `SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL AND instr(sql, ?) > 0 AND type IN ('trigger', 'view')`,
    { replacements: [GHOST_PARENT] }
  );
  const rows = rowsFromQueryResult(result);
  for (const row of rows) {
    const typ = String(row.type || '');
    const nm = row.name;
    if (!nm) continue;
    const qn = quoteIdent(nm);
    try {
      if (typ === 'trigger') {
        await sequelize.query(`DROP TRIGGER IF EXISTS ${qn}`);
      } else if (typ === 'view') {
        await sequelize.query(`DROP VIEW IF EXISTS ${qn}`);
      }
      console.log(`[sqlite-repair] Eliminado ${typ} ${nm} (referencia a ${GHOST_PARENT}).`);
    } catch (e) {
      console.warn(`[sqlite-repair] No se pudo eliminar ${typ} ${nm}:`, e?.message || e);
    }
  }
}

async function getStoredCreateTableSql(sequelize, tableName) {
  const result = await sequelize.query(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    { replacements: [tableName] }
  );
  const rows = rowsFromQueryResult(result);
  const row = rows[0];
  return row && row.sql != null ? String(row.sql) : '';
}

async function rebuildChildTableWithFixedParents(sequelize, childTable) {
  const colResult = await sequelize.query(`PRAGMA table_info(${quoteIdent(childTable)})`);
  const cols = rowsFromQueryResult(colResult);
  if (!cols.length) return false;

  const ddl = await getStoredCreateTableSql(sequelize, childTable);
  const sqlReferencesGhost = ddl.includes(GHOST_PARENT);

  const fkResult = await sequelize.query(`PRAGMA foreign_key_list(${quoteIdent(childTable)})`);
  let fkRows = rowsFromQueryResult(fkResult);
  if (!fkRows || !Array.isArray(fkRows)) fkRows = [];

  if (!fkRows.length && ddl) {
    fkRows = parseForeignKeysFromCreateTableSql(ddl);
    if (fkRows.length) {
      console.log(
        `[sqlite-repair] ${childTable}: foreign_key_list vacío; FK inferidas del DDL almacenado (${fkRows.length}).`
      );
    }
  }

  const fkHasGhost = fkRows.some((fk) => String(fk.table) === GHOST_PARENT);
  const needsRebuild = fkHasGhost || sqlReferencesGhost;

  if (!needsRebuild) return false;
  if (!fkRows.length) {
    console.warn(
      `[sqlite-repair] ${childTable}: DDL o FK rotos (${GHOST_PARENT}) pero no se pudieron obtener FK; omito.`
    );
    return false;
  }

  const colDefs = buildColumnDefsFromTableInfo(cols);
  const fkClauses = buildForeignKeyClauses(fkRows);
  const colList = cols.map((c) => quoteIdent(c.name)).join(', ');
  const tmp = `${childTable}__fkfix_${Date.now()}`;
  const createSql = `CREATE TABLE ${quoteIdent(tmp)} (${colDefs.join(', ')}, ${fkClauses.join(', ')})`;

  await sequelize.query('PRAGMA foreign_keys=OFF');
  try {
    await sequelize.query(createSql);
    await sequelize.query(
      `INSERT INTO ${quoteIdent(tmp)} (${colList}) SELECT ${colList} FROM ${quoteIdent(childTable)}`
    );
    await sequelize.query(`DROP TABLE ${quoteIdent(childTable)}`);
    await sequelize.query(`ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(childTable)}`);
  } finally {
    await sequelize.query('PRAGMA foreign_keys=ON');
  }
  return true;
}

async function recoverOrphanGhostTable(sequelize) {
  const hasGhost = await tableExists(sequelize, GHOST_PARENT);
  const hasCanon = await tableExists(sequelize, CANON_PARENT);
  if (!hasGhost) return null;
  if (!hasCanon) {
    await sequelize.query(`ALTER TABLE ${quoteIdent(GHOST_PARENT)} RENAME TO ${quoteIdent(CANON_PARENT)}`);
    return 'renamed_ghost_to_reuniones';
  }
  const [[{ n: nGhost }]] = await sequelize.query(`SELECT COUNT(*) AS n FROM ${quoteIdent(GHOST_PARENT)}`);
  const [[{ n: nCanon }]] = await sequelize.query(`SELECT COUNT(*) AS n FROM ${quoteIdent(CANON_PARENT)}`);
  if (Number(nGhost) === 0) {
    await sequelize.query(`DROP TABLE ${quoteIdent(GHOST_PARENT)}`);
    return 'dropped_empty_ghost';
  }
  console.warn(
    `[sqlite-repair] Existen ${CANON_PARENT} (${nCanon} filas) y ${GHOST_PARENT} (${nGhost} filas). Revisa manualmente.`
  );
  return 'ghost_and_canon_both_nonempty';
}

async function masterReferencesGhost(sequelize) {
  const result = await sequelize.query(
    `SELECT name, type FROM sqlite_master WHERE sql IS NOT NULL AND instr(sql, ?) > 0`,
    { replacements: [GHOST_PARENT] }
  );
  const rows = rowsFromQueryResult(result);
  return Array.isArray(rows) ? rows : [];
}

async function logReunionOcurrenciaFkHealth(sequelize) {
  const tables = await listUserTables(sequelize);
  const ocTables = tables.filter(
    (t) => t === 'reunion_ocurrencia' || t === 'reunion_ocurrencias' || /^reunion_ocurrencia/i.test(t)
  );
  if (!ocTables.length) {
    console.log('[sqlite-repair] Sin tabla reunion_ocurrencia*; omito verificación FK.');
    return;
  }
  for (const t of ocTables) {
    const fkResult = await sequelize.query(`PRAGMA foreign_key_list(${quoteIdent(t)})`);
    const fks = rowsFromQueryResult(fkResult);
    if (!fks || !Array.isArray(fks)) continue;
    const bad = fks.filter((fk) => String(fk.table) === GHOST_PARENT);
    const good = fks.filter((fk) => String(fk.table) === CANON_PARENT);
    if (bad.length) {
      console.warn(`[sqlite-repair] Tabla ${t}: FK aún apunta a ${GHOST_PARENT}.`);
    } else if (good.length) {
      console.log(`[sqlite-repair] OK: ${t} enlazada a ${CANON_PARENT} (${good.length} FK). Arranque permitido.`);
    } else if (fks.length) {
      console.log(`[sqlite-repair] ${t}: FK a: ${fks.map((f) => f.table).join(', ')}`);
    } else {
      console.log(`[sqlite-repair] ${t}: sin FK en PRAGMA.`);
    }
  }
}

async function repairSqliteReunionGhostReferences(sequelize) {
  if (sequelize.getDialect() !== 'sqlite') return;

  const recovery = await recoverOrphanGhostTable(sequelize);
  if (recovery) console.log('[sqlite-repair] Recuperación tabla padre:', recovery);

  await dropTriggersAndViewsReferencingGhost(sequelize);

  const tables = await listUserTables(sequelize);
  const toRebuild = new Set();

  for (const t of tables) {
    const fkResult = await sequelize.query(`PRAGMA foreign_key_list(${quoteIdent(t)})`);
    const fks = rowsFromQueryResult(fkResult);
    if (fks && Array.isArray(fks) && fks.length && fks.some((fk) => String(fk.table) === GHOST_PARENT)) {
      toRebuild.add(t);
    }
  }

  const ddlGhostResult = await sequelize.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL AND instr(sql, ?) > 0 AND name != ?`,
    { replacements: [GHOST_PARENT, CANON_PARENT] }
  );
  for (const row of rowsFromQueryResult(ddlGhostResult)) {
    const n = row && row.name;
    if (n && String(n).indexOf('sqlite_') !== 0) toRebuild.add(String(n));
  }

  let rebuilt = 0;
  for (const t of toRebuild) {
    console.log(`[sqlite-repair] Reconstruyendo ${t} → FK ${CANON_PARENT}…`);
    if (await rebuildChildTableWithFixedParents(sequelize, t)) rebuilt += 1;
  }
  if (rebuilt) console.log(`[sqlite-repair] Tablas reconstruidas: ${rebuilt}`);

  await logReunionOcurrenciaFkHealth(sequelize);
}

module.exports = {
  repairSqliteReunionGhostReferences,
  logReunionOcurrenciaFkHealth,
  GHOST_PARENT,
  CANON_PARENT,
};
