/**
 * Asistencia por reunión (entrada/salida, persistencia en BD).
 * Compatible con el calendario: fechaHora, inicioSesion, entradaAt, salidaAt, presente, asistio.
 */

const { Op } = require('sequelize');
const { ReunionAsistencia, Reunion, Participa, Usuario } = require('../models');
const copresencia = require('./copresencia');

function sessionDurationMs(reunion) {
  if (!reunion) return 60 * 60 * 1000;
  const a = reunion.fechaHora && new Date(reunion.fechaHora);
  const b = reunion.fechaHoraFin && new Date(reunion.fechaHoraFin);
  if (a && b && !Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime()) && b > a) {
    return Math.max(15 * 60 * 1000, b.getTime() - a.getTime());
  }
  return 60 * 60 * 1000;
}

/**
 * @param {Date|string} inicioSesion
 * @param {Date|null} entradaAt
 * @param {boolean} asistioFlag
 * @param {object|null} reunion
 * @param {Date} [now]
 * @returns {'futuro'|'asistio'|'ausente'}
 */
function computeEstado(inicioSesion, entradaAt, asistioFlag, reunion, now = new Date()) {
  const start = new Date(inicioSesion);
  if (Number.isNaN(start.getTime())) return 'ausente';
  const endMs = start.getTime() + sessionDurationMs(reunion);
  if (endMs > now.getTime()) return 'futuro';
  if (entradaAt || asistioFlag) return 'asistio';
  return 'ausente';
}

function buildInicioSesionWhere(opts) {
  const w = {};
  if (opts.desde) w[Op.gte] = new Date(opts.desde);
  if (opts.hasta) w[Op.lte] = new Date(opts.hasta);
  return Object.keys(w).length ? w : null;
}

function toApiRow(inst, reunion, now = new Date()) {
  const plain = inst.get ? inst.get({ plain: true }) : inst;
  const inicioSesion = plain.inicioSesion;
  const entradaAt = plain.entradaAt || null;
  const salidaAt = plain.salidaAt || null;
  const asistioDb = !!plain.asistio;
  const asistio = !!(asistioDb || entradaAt);
  const estado = computeEstado(inicioSesion, entradaAt, asistioDb, reunion, now);
  const row = {
    reunionAsistenciaId: plain.reunionAsistenciaId,
    reunionId: plain.reunionId,
    usuarioId: plain.usuarioId,
    fechaHora: inicioSesion,
    inicioSesion,
    entradaAt,
    salidaAt,
    presente: !!plain.presente,
    asistio,
    estado,
  };
  const u = plain.usuario || plain.Usuario;
  if (u) {
    row.usuario = {
      usuarioId: u.usuarioId,
      nombre: u.nombre,
      email: u.email,
      rol: u.rol,
    };
  }
  return row;
}

async function listarAsistenciaPorReunion(reunionId, opts = {}) {
  const reunion = await Reunion.findByPk(reunionId);
  if (!reunion) return [];
  const where = { reunionId };
  const range = buildInicioSesionWhere(opts);
  if (range) where.inicioSesion = range;
  const rows = await ReunionAsistencia.findAll({
    where,
    include: [{ model: Usuario, as: 'usuario', attributes: ['usuarioId', 'nombre', 'email', 'rol'] }],
    order: [['inicioSesion', 'ASC']],
  });
  const now = new Date();
  return rows.map((r) => toApiRow(r, reunion, now));
}

async function registrarEntradaStub(reunionId, usuarioId, meta = {}) {
  const reunion = await Reunion.findByPk(reunionId);
  if (!reunion) {
    const e = new Error('Reunión no encontrada');
    e.status = 404;
    throw e;
  }
  let rawInicio = null;
  if (meta && meta.inicioSesion) rawInicio = new Date(meta.inicioSesion);
  else if (meta && meta.fechaHora) rawInicio = new Date(meta.fechaHora);
  else if (reunion.fechaHora) rawInicio = new Date(reunion.fechaHora);
  if (!rawInicio || Number.isNaN(rawInicio.getTime())) {
    const e = new Error('Se requiere inicioSesion o fechaHora válidos en el cuerpo o reunión con fecha');
    e.status = 400;
    throw e;
  }
  const inicioSesion = copresencia.normalizeInicioSesion(rawInicio);
  const now = new Date();
  const [row, created] = await ReunionAsistencia.findOrCreate({
    where: { reunionId, usuarioId, inicioSesion },
    defaults: {
      reunionId,
      usuarioId,
      inicioSesion,
      entradaAt: now,
      salidaAt: null,
      presente: true,
      asistio: true,
    },
  });
  if (!created) {
    row.entradaAt = now;
    row.presente = true;
    row.asistio = true;
    await row.save();
  }
  const withUser = await ReunionAsistencia.findByPk(row.reunionAsistenciaId, {
    include: [{ model: Usuario, as: 'usuario', attributes: ['usuarioId', 'nombre', 'email', 'rol'] }],
  });
  const rolCp = await copresencia.resolveRolCopresencia(reunionId, usuarioId);
  copresencia.registrarEntrada(usuarioId, reunionId, inicioSesion, rolCp);
  return toApiRow(withUser, reunion, new Date());
}

async function registrarSalidaStub(reunionId, usuarioId, meta = {}) {
  const reunion = await Reunion.findByPk(reunionId);
  if (!reunion) {
    const e = new Error('Reunión no encontrada');
    e.status = 404;
    throw e;
  }
  const where = {
    reunionId,
    usuarioId,
    entradaAt: { [Op.ne]: null },
    salidaAt: null,
  };
  if (meta && meta.inicioSesion) {
    where.inicioSesion = copresencia.normalizeInicioSesion(new Date(meta.inicioSesion));
  } else if (meta && meta.fechaHora) {
    where.inicioSesion = copresencia.normalizeInicioSesion(new Date(meta.fechaHora));
  }
  const row = await ReunionAsistencia.findOne({
    where,
    order: [['entradaAt', 'DESC']],
    include: [{ model: Usuario, as: 'usuario', attributes: ['usuarioId', 'nombre', 'email', 'rol'] }],
  });
  if (!row) return null;
  row.salidaAt = new Date();
  await row.save();
  const inicioS = row.inicioSesion;
  copresencia.registrarSalida(usuarioId, reunionId, inicioS);
  await copresencia.calcularCopresencia(reunionId, inicioS, copresencia.getUmbralMs());
  const withUser = await ReunionAsistencia.findByPk(row.reunionAsistenciaId, {
    include: [{ model: Usuario, as: 'usuario', attributes: ['usuarioId', 'nombre', 'email', 'rol'] }],
  });
  return toApiRow(withUser, reunion, new Date());
}

async function resumenAsistenciaStub(reunionId, opts = {}) {
  const reunion = await Reunion.findByPk(reunionId);
  if (!reunion) {
    return { reunionId, total: 0, totalRegistros: 0, filas: [] };
  }
  const asistWhere = { reunionId };
  const range = buildInicioSesionWhere(opts);
  if (range) asistWhere.inicioSesion = range;

  const [participaciones, registrosRaw] = await Promise.all([
    Participa.findAll({
      where: { reunionId },
      include: [{ model: Usuario, attributes: ['usuarioId', 'nombre', 'email', 'rol'] }],
    }),
    ReunionAsistencia.findAll({
      where: asistWhere,
      include: [{ model: Usuario, as: 'usuario', attributes: ['usuarioId', 'nombre', 'email', 'rol'] }],
      order: [['inicioSesion', 'DESC']],
    }),
  ]);

  const iniciosUnicos = new Map();
  for (const r of registrosRaw) {
    const pl = r.get({ plain: true });
    const n = copresencia.normalizeInicioSesion(pl.inicioSesion);
    if (n) iniciosUnicos.set(n.toISOString(), n);
  }
  for (const inicio of iniciosUnicos.values()) {
    await copresencia.calcularCopresencia(reunionId, inicio, copresencia.getUmbralMs());
  }

  const registros = await ReunionAsistencia.findAll({
    where: asistWhere,
    include: [{ model: Usuario, as: 'usuario', attributes: ['usuarioId', 'nombre', 'email', 'rol'] }],
    order: [['inicioSesion', 'DESC']],
  });

  const now = new Date();
  const byUser = new Map();
  for (const r of registros) {
    const plain = r.get({ plain: true });
    const uid = String(plain.usuarioId);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(plain);
  }

  const filas = participaciones.map((p) => {
    const plainP = p.get({ plain: true });
    const u = plainP.Usuario || plainP.usuario;
    const uid = String(plainP.usuarioId);
    const userRows = byUser.get(uid) || [];
    if (!userRows.length) {
      return {
        usuarioId: plainP.usuarioId,
        nombre: u?.nombre || '',
        email: u?.email || '',
        rol: u?.rol,
        rolEnReunion: plainP.rolEnReunion,
        estado: 'sin_registro',
        fechaHora: null,
        inicioSesion: null,
        entradaAt: null,
        salidaAt: null,
        presente: false,
        asistio: false,
      };
    }
    const last = [...userRows].sort((a, b) => new Date(b.inicioSesion) - new Date(a.inicioSesion))[0];
    const inicioSesion = last.inicioSesion;
    const entradaAt = last.entradaAt;
    const salidaAt = last.salidaAt;
    const estado = computeEstado(last.inicioSesion, last.entradaAt, !!last.asistio, reunion, now);
    return {
      usuarioId: plainP.usuarioId,
      nombre: u?.nombre || '',
      email: u?.email || '',
      rol: u?.rol,
      rolEnReunion: plainP.rolEnReunion,
      estado,
      fechaHora: inicioSesion,
      inicioSesion,
      entradaAt,
      salidaAt,
      presente: !!last.presente,
      asistio: !!(last.asistio || last.entradaAt),
    };
  });

  return {
    reunionId,
    total: filas.length,
    totalRegistros: registros.length,
    filas,
  };
}

module.exports = {
  listarAsistenciaPorReunion,
  registrarEntradaStub,
  registrarSalidaStub,
  resumenAsistenciaStub,
};
