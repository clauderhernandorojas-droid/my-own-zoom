const { DataTypes } = require('sequelize');

/** Solicitud de acceso a reunión persistida (complemento al flujo en tiempo real por socket). */
module.exports = (sequelize) => {
  const ReunionSolicitudAcceso = sequelize.define(
    'ReunionSolicitudAcceso',
    {
      solicitudId: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'solicitud_id',
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
      estado: {
        type: DataTypes.ENUM('pendiente', 'aprobada', 'rechazada'),
        allowNull: false,
        defaultValue: 'pendiente',
        field: 'estado',
      },
      respondidoPorUsuarioId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'respondido_por_usuario_id',
        references: { model: 'usuarios', key: 'usuario_id' },
      },
    },
    {
      tableName: 'reunion_solicitudes_acceso',
      timestamps: true,
      createdAt: 'creado_en',
      updatedAt: 'actualizado_en',
      indexes: [
        { fields: ['reunion_id'] },
        { fields: ['usuario_id'] },
        { fields: ['reunion_id', 'estado'] },
      ],
    }
  );

  return ReunionSolicitudAcceso;
};
