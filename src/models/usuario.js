const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Usuario = sequelize.define(
    'Usuario',
    {
      usuarioId: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'usuario_id',
      },
      nombre: {
        type: DataTypes.STRING(200),
        allowNull: false,
        field: 'nombre',
      },
      rol: {
        type: DataTypes.ENUM('docente', 'estudiante', 'admin'),
        allowNull: false,
        defaultValue: 'estudiante',
        field: 'rol',
      },
      email: {
        type: DataTypes.STRING(320),
        allowNull: false,
        unique: true,
        validate: { isEmail: true },
        field: 'email',
      },
      contrasenaHasheada: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'contrasena_hasheada',
      },
      perfil: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
        field: 'perfil',
      },
    },
    {
      tableName: 'usuarios',
      indexes: [{ unique: true, fields: ['email'] }],
    }
  );

  Usuario.prototype.toJSON = function toJSON() {
    const values = { ...this.get() };
    delete values.contrasenaHasheada;
    return values;
  };

  return Usuario;
};
