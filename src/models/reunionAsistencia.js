const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ReunionAsistencia = sequelize.define(
    'ReunionAsistencia',
    {
      reunionAsistenciaId: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'reunion_asistencia_id',
      },
      reunionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'reunion_id',
        references: { model: 'reuniones', key: 'reunion_id' },
      },
      usuarioId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'usuario_id',
        references: { model: 'usuarios', key: 'usuario_id' },
      },
      inicioSesion: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'inicio_sesion',
      },
      entradaAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'entrada_at',
      },
      salidaAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'salida_at',
      },
      presente: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'presente',
      },
      asistio: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'asistio',
      },
    },
    {
      tableName: 'reunion_asistencias',
      indexes: [
        { unique: true, fields: ['reunion_id', 'usuario_id', 'inicio_sesion'] },
        { fields: ['reunion_id'] },
        { fields: ['usuario_id'] },
      ],
    }
  );

  return ReunionAsistencia;
};
