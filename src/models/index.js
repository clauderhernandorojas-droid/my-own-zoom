const { createSequelize } = require('../config/database');
const defineUsuario = require('./usuario');
const defineReunion = require('./reunion');
const defineParticipa = require('./participa');
const defineMensaje = require('./mensaje');
const defineMensajeReaccion = require('./mensajeReaccion');
const defineTablero = require('./tablero');
const defineReunionInvitado = require('./reunionInvitado');
const defineReunionSolicitudAcceso = require('./reunionSolicitudAcceso');
const defineReunionAsistencia = require('./reunionAsistencia');
const defineReunionOcurrencia = require('./reunionOcurrencia');

const sequelize = createSequelize();

const Usuario = defineUsuario(sequelize);
const Reunion = defineReunion(sequelize);
const Participa = defineParticipa(sequelize);
const Mensaje = defineMensaje(sequelize);
const MensajeReaccion = defineMensajeReaccion(sequelize);
const Tablero = defineTablero(sequelize);
const ReunionInvitado = defineReunionInvitado(sequelize);
const ReunionSolicitudAcceso = defineReunionSolicitudAcceso(sequelize);
const ReunionAsistencia = defineReunionAsistencia(sequelize);
const ReunionOcurrencia = defineReunionOcurrencia(sequelize);

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
Mensaje.hasMany(MensajeReaccion, { foreignKey: 'mensajeId', as: 'reacciones' });
MensajeReaccion.belongsTo(Mensaje, { foreignKey: 'mensajeId', as: 'mensaje' });
Usuario.hasMany(MensajeReaccion, { foreignKey: 'usuarioId', as: 'reaccionesMensaje' });
MensajeReaccion.belongsTo(Usuario, { foreignKey: 'usuarioId', as: 'reactor' });

// Reunion ↔ Tablero 1:1
Reunion.hasOne(Tablero, { foreignKey: 'reunionId', as: 'tablero' });
Tablero.belongsTo(Reunion, { foreignKey: 'reunionId', as: 'reunion' });

// Dueño docente (creador) — relación explícita
Usuario.hasMany(Reunion, { foreignKey: 'docenteUsuarioId', as: 'reunionesCreadas' });
Reunion.belongsTo(Usuario, { foreignKey: 'docenteUsuarioId', as: 'docente' });

Reunion.belongsTo(Reunion, { foreignKey: 'parentReunionId', as: 'reunionPadre' });
Reunion.hasMany(Reunion, { foreignKey: 'parentReunionId', as: 'reunionesExcepcion' });

// Invitaciones y solicitudes de acceso
Reunion.hasMany(ReunionInvitado, { foreignKey: 'reunionId', as: 'invitados' });
ReunionInvitado.belongsTo(Reunion, { foreignKey: 'reunionId', as: 'reunion' });
Usuario.hasMany(ReunionInvitado, { foreignKey: 'invitadoPorUsuarioId', as: 'invitacionesEnviadas' });
ReunionInvitado.belongsTo(Usuario, { foreignKey: 'invitadoPorUsuarioId', as: 'invitadoPor' });

Reunion.hasMany(ReunionSolicitudAcceso, { foreignKey: 'reunionId', as: 'solicitudesAcceso' });
ReunionSolicitudAcceso.belongsTo(Reunion, { foreignKey: 'reunionId', as: 'reunion' });
Usuario.hasMany(ReunionSolicitudAcceso, { foreignKey: 'usuarioId', as: 'solicitudesAccesoUsuario' });
ReunionSolicitudAcceso.belongsTo(Usuario, { foreignKey: 'usuarioId', as: 'solicitante' });
Usuario.hasMany(ReunionSolicitudAcceso, {
  foreignKey: 'respondidoPorUsuarioId',
  as: 'solicitudesAccesoRespondidas',
});
ReunionSolicitudAcceso.belongsTo(Usuario, {
  foreignKey: 'respondidoPorUsuarioId',
  as: 'respondidoPor',
});

Reunion.hasMany(ReunionAsistencia, { foreignKey: 'reunionId', as: 'asistencias' });
ReunionAsistencia.belongsTo(Reunion, { foreignKey: 'reunionId', as: 'reunion' });
Usuario.hasMany(ReunionAsistencia, { foreignKey: 'usuarioId', as: 'asistenciasReunion' });
ReunionAsistencia.belongsTo(Usuario, { foreignKey: 'usuarioId', as: 'usuario' });

Reunion.hasMany(ReunionOcurrencia, { foreignKey: 'reunionId', as: 'ocurrenciaExcepciones' });
ReunionOcurrencia.belongsTo(Reunion, { foreignKey: 'reunionId', as: 'reunion' });

module.exports = {
  sequelize,
  Usuario,
  Reunion,
  Participa,
  Mensaje,
  MensajeReaccion,
  Tablero,
  ReunionInvitado,
  ReunionSolicitudAcceso,
  ReunionAsistencia,
  ReunionOcurrencia,
};
