const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const MensajeReaccion = sequelize.define(
    'MensajeReaccion',
    {
      mensajeReaccionId: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'mensaje_reaccion_id',
      },
      mensajeId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'mensaje_id',
        references: { model: 'mensajes', key: 'mensaje_id' },
      },
      usuarioId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'usuario_id',
        references: { model: 'usuarios', key: 'usuario_id' },
      },
      emoji: {
        type: DataTypes.STRING(16),
        allowNull: false,
        field: 'emoji',
      },
    },
    {
      tableName: 'mensaje_reacciones',
      indexes: [
        { fields: ['mensaje_id'] },
        { fields: ['usuario_id'] },
        { unique: true, fields: ['mensaje_id', 'usuario_id', 'emoji'] },
      ],
    }
  );

  return MensajeReaccion;
};
