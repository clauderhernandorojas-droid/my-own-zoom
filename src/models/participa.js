const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Participa = sequelize.define(
    'Participa',
    {
      participaId: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'participa_id',
      },
      usuarioId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'usuario_id',
        references: { model: 'usuarios', key: 'usuario_id' },
      },
      reunionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'reunion_id',
        references: { model: 'reuniones', key: 'reunion_id' },
      },
      rolEnReunion: {
        type: DataTypes.ENUM('docente', 'estudiante', 'asistente'),
        allowNull: true,
        field: 'rol_en_reunion',
      },
    },
    {
      tableName: 'participa',
      indexes: [
        { unique: true, fields: ['usuario_id', 'reunion_id'] },
        { fields: ['reunion_id'] },
      ],
    }
  );

  return Participa;
};
