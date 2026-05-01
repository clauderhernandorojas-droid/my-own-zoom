const { createSequelize } = require('../config/database');
const defineUsuario = require('./usuario');
const defineReunion = require('./reunion');
const defineParticipa = require('./participa');
const defineMensaje = require('./mensaje');
const defineTablero = require('./tablero');

const sequelize = createSequelize();

const Usuario = defineUsuario(sequelize);
const Reunion = defineReunion(sequelize);
const Participa = defineParticipa(sequelize);
const Mensaje = defineMensaje(sequelize);
const Tablero = defineTablero(sequelize);

// Usuarios ↔ Reuniones N:M
Usuario.belongsToMany(Reunion, {
  through: Participa,
  foreignKey: 'usuarioId',
  otherKey: 'reunionId',
});
Reunion.belongsToMany(Usuario, {
  through: Participa,
  foreignKey: 'reunionId',
  otherKey: 'usuarioId',
});

Participa.belongsTo(Usuario, { foreignKey: 'usuarioId' });
Participa.belongsTo(Reunion, { foreignKey: 'reunionId' });
Usuario.hasMany(Participa, { foreignKey: 'usuarioId' });
Reunion.hasMany(Participa, { foreignKey: 'reunionId' });

// Reunion → Mensajes 1:N
Reunion.hasMany(Mensaje, { foreignKey: 'reunionId', as: 'mensajes' });
Mensaje.belongsTo(Reunion, { foreignKey: 'reunionId', as: 'reunion' });
Usuario.hasMany(Mensaje, { foreignKey: 'usuarioId', as: 'mensajes' });
Mensaje.belongsTo(Usuario, { foreignKey: 'usuarioId', as: 'autor' });
Mensaje.belongsTo(Usuario, {
  foreignKey: 'destinatarioUsuarioId',
  as: 'destinatario',
});

// Reunion ↔ Tablero 1:1
Reunion.hasOne(Tablero, { foreignKey: 'reunionId', as: 'tablero' });
Tablero.belongsTo(Reunion, { foreignKey: 'reunionId', as: 'reunion' });

// Dueño docente (creador) — relación explícita
Usuario.hasMany(Reunion, { foreignKey: 'docenteUsuarioId', as: 'reunionesCreadas' });
Reunion.belongsTo(Usuario, { foreignKey: 'docenteUsuarioId', as: 'docente' });

module.exports = {
  sequelize,
  Usuario,
  Reunion,
  Participa,
  Mensaje,
  Tablero,
};
