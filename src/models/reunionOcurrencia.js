const { DataTypes } = require('sequelize');

/** Excepción de una ocurrencia de serie (reagendar una instancia sin cambiar la regla RRULE). */
module.exports = (sequelize) => {
  const ReunionOcurrencia = sequelize.define(
    'ReunionOcurrencia',
    {
      reunionOcurrenciaId: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'reunion_ocurrencia_id',
      },
      reunionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'reunion_id',
        references: { model: 'reuniones', key: 'reunion_id' },
      },
      /** Instante original de la ocurrencia según la serie (ancla + regla). */
      fechaOcurrenciaOriginal: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'fecha_ocurrencia_original',
      },
      /** Nuevo instante de inicio de esa ocurrencia. */
      fechaOcurrenciaOverride: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'fecha_ocurrencia_override',
      },
      /** Serie raíz (padre): `reunion.serie_id` si existe, si no la PK de la reunión plantilla. */
      serieId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'serie_id',
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
      tableName: 'reunion_ocurrencias',
      indexes: [
        { unique: true, fields: ['reunion_id', 'fecha_ocurrencia_original'] },
        { fields: ['serie_id'] },
      ],
      hooks: {
        beforeUpdate(row) {
          row.actualizadoEn = new Date();
        },
      },
    }
  );

  return ReunionOcurrencia;
};
