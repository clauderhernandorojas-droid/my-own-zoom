const path = require('path');
const { Sequelize } = require('sequelize');

function createSequelize() {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    return new Sequelize(databaseUrl, {
      dialect: 'postgres',
      logging: process.env.SQL_LOG === '1' ? console.log : false,
      dialectOptions: {
        ssl: { require: true, rejectUnauthorized: false },
      },
      pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
      retry: { max: 5 },
      define: {
        underscored: true,
        timestamps: true,
        createdAt: 'creado_en',
        updatedAt: 'actualizado_en',
      },
    });
  }

  const storage = process.env.SQLITE_STORAGE
    ? path.isAbsolute(process.env.SQLITE_STORAGE)
      ? process.env.SQLITE_STORAGE
      : path.join(__dirname, '..', '..', process.env.SQLITE_STORAGE)
    : path.join(__dirname, '..', '..', 'data', 'app.sqlite');
  return new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: process.env.SQL_LOG === '1' ? console.log : false,
    define: {
      underscored: true,
      timestamps: true,
      createdAt: 'creado_en',
      updatedAt: 'actualizado_en',
    },
  });
}

module.exports = { createSequelize };
