const { DataTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize) => {
  const Reunion = sequelize.define(
    'Reunion',
    {
      reunionId: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'reunion_id',
      },
      titulo: {
        type: DataTypes.STRING(500),
        allowNull: false,
        field: 'titulo',
      },
      fechaHora: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'fecha_hora',
      },
      roomId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'room_id',
      },
      estado: {
        type: DataTypes.ENUM('programada', 'activa', 'finalizada'),
        allowNull: false,
        defaultValue: 'programada',
        field: 'estado',
      },
      docenteUsuarioId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'docente_usuario_id',
        references: { model: 'usuarios', key: 'usuario_id' },
      },
      // Base Etapa 2 — agendador / calendario
      fechaHoraFin: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'fecha_hora_fin',
      },
      zonaHoraria: {
        type: DataTypes.STRING(80),
        allowNull: true,
        field: 'zona_horaria',
      },
      recurrencia: {
        type: DataTypes.STRING(500),
        allowNull: true,
        comment: 'RRULE u otra regla; Etapa 2',
        field: 'recurrencia',
      },
      serieId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'serie_id',
      },
      parentReunionId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'parent_reunion_id',
        references: { model: 'reuniones', key: 'reunion_id' },
      },
      esExcepcion: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'es_excepcion',
      },
      /** YYYY-MM-DD (día civil de la instancia sustituida); solo excepciones. */
      occurrenceDayKey: {
        type: DataTypes.STRING(12),
        allowNull: true,
        field: 'occurrence_day_key',
      },
      /** Marca baja explícita por el usuario (Eliminar); distinta de finalizada natural. */
      eliminadaEn: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'eliminada_en',
      },
    },
    {
      tableName: 'reuniones',
      timestamps: true,
      createdAt: 'creado_en',
      updatedAt: 'actualizado_en',
      hooks: {
        beforeValidate(reunion) {
          if (!reunion.roomId) {
            reunion.roomId = uuidv4();
          }
        },
      },
    }
  );

  return Reunion;
};
