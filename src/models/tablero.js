const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Tablero = sequelize.define(
    'Tablero',
    {
      tableroId: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'tablero_id',
      },
      reunionId: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
        field: 'reunion_id',
        references: { model: 'reuniones', key: 'reunion_id' },
      },
      contenido: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: { elementos: [] },
        field: 'contenido',
      },
      tipoElemento: {
        type: DataTypes.STRING(80),
        allowNull: true,
        defaultValue: 'canvas',
        field: 'tipo_elemento',
      },
      ultimaEdicion: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'ultima_edicion',
      },
    },
    {
      tableName: 'tableros',
    }
  );

  return Tablero;
};
