const { DataTypes } = require('sequelize');

/** Invitación registrada a una reunión (correo / enlace); uso futuro vía API. */
module.exports = (sequelize) => {
  const ReunionInvitado = sequelize.define(
    'ReunionInvitado',
    {
      reunionInvitadoId: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'reunion_invitado_id',
      },
      reunionId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'reunion_id',
        references: { model: 'reuniones', key: 'reunion_id' },
      },
      email: {
        type: DataTypes.STRING(320),
        allowNull: true,
        field: 'email',
      },
      tokenInvitacion: {
        type: DataTypes.STRING(128),
        allowNull: true,
        unique: true,
        field: 'token_invitacion',
      },
      invitadoPorUsuarioId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'invitado_por_usuario_id',
        references: { model: 'usuarios', key: 'usuario_id' },
      },
      estado: {
        type: DataTypes.ENUM('pendiente', 'aceptada', 'revocada', 'expirada'),
        allowNull: false,
        defaultValue: 'pendiente',
        field: 'estado',
      },
      creadoEn: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'creado_en',
      },
    },
    {
      tableName: 'reunion_invitados',
      indexes: [{ fields: ['reunion_id'] }, { fields: ['email'] }],
    }
  );

  return ReunionInvitado;
};
