const { DataTypes, Op } = require('sequelize');

module.exports = (sequelize) => {
  const ReunionAsistenciaMs = sequelize.define(
    'ReunionAsistenciaMs',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      reunionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'reunion_id',
      },
      inicioSesion: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'inicio_sesion',
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'user_id',
      },
      teacherPresenceMs: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'teacher_presence_ms',
      },
      copresenceMs: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'copresence_ms',
      },
      umbralMs: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'umbral_ms',
      },
      fulfilled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'fulfilled',
      },
      creadoEn: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'creado_en',
      },
      actualizadoEn: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'actualizado_en',
      },
    },
    {
      tableName: 'reunion_asistencia_ms',
      timestamps: false,
      indexes: [
        {
          unique: true,
          fields: ['reunion_id', 'inicio_sesion', 'user_id'],
        },
        { fields: ['reunion_id', 'inicio_sesion'] },
        { fields: ['user_id'] },
      ],
    }
  );

  ReunionAsistenciaMs.upsertSessionMetrics = async function upsertSessionMetrics(row) {
    const now = new Date();
    const payload = {
      reunionId: String(row.reunionId),
      inicioSesion: row.inicioSesion,
      userId: String(row.userId),
      teacherPresenceMs: Number(row.teacherPresenceMs) || 0,
      copresenceMs: Number(row.copresenceMs) || 0,
      umbralMs: Number(row.umbralMs) || 0,
      fulfilled: !!row.fulfilled,
      actualizadoEn: now,
    };
    const existing = await ReunionAsistenciaMs.findOne({
      where: {
        reunionId: payload.reunionId,
        inicioSesion: payload.inicioSesion,
        userId: payload.userId,
      },
    });
    if (existing) {
      await existing.update(payload);
      return existing;
    }
    payload.creadoEn = now;
    return ReunionAsistenciaMs.create(payload);
  };

  ReunionAsistenciaMs.findAllForSession = async function findAllForSession(reunionId, inicioSesion) {
    return ReunionAsistenciaMs.findAll({
      where: {
        reunionId: String(reunionId),
        inicioSesion,
      },
      order: [['copresenceMs', 'DESC']],
    });
  };

  ReunionAsistenciaMs.findBySessionUser = async function findBySessionUser(
    reunionId,
    inicioSesion,
    userId
  ) {
    return ReunionAsistenciaMs.findOne({
      where: {
        reunionId: String(reunionId),
        inicioSesion,
        userId: String(userId),
      },
    });
  };

  return ReunionAsistenciaMs;
};
