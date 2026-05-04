const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Mensaje = sequelize.define(
    'Mensaje',
    {
      mensajeId: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'mensaje_id',
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
      tipo: {
        type: DataTypes.ENUM('general', 'privado'),
        allowNull: false,
        defaultValue: 'general',
        field: 'tipo',
      },
      contenido: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'contenido',
      },
      marcaTiempo: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'marca_tiempo',
      },
      visto: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'visto',
      },
      destinatarioUsuarioId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'destinatario_usuario_id',
        references: { model: 'usuarios', key: 'usuario_id' },
      },
      adjuntoRelPath: {
        type: DataTypes.STRING(1024),
        allowNull: true,
        field: 'adjunto_rel_path',
      },
      adjuntoNombreOriginal: {
        type: DataTypes.STRING(512),
        allowNull: true,
        field: 'adjunto_nombre_original',
      },
      adjuntoMime: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'adjunto_mime',
      },
      adjuntoBytes: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'adjunto_bytes',
      },
    },
    {
      tableName: 'mensajes',
      indexes: [{ fields: ['reunion_id', 'marca_tiempo'] }],
    }
  );

  return Mensaje;
};
