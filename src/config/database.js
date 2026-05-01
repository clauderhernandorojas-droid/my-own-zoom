const path = require('path');
const { Sequelize } = require('sequelize');

function createSequelize() {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    return new Sequelize(databaseUrl, {
      dialect: 'postgres',
      logging: process.env.NODE_ENV === 'development' ? console.log : false,
      define: {
        underscored: true,
        timestamps: true,
        createdAt: 'creado_en',
        updatedAt: 'actualizado_en',
      },
    });
  }

  const storage = path.join(__dirname, '..', '..', 'data', 'app.sqlite');
  return new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    define: {
      underscored: true,
      timestamps: true,
      createdAt: 'creado_en',
      updatedAt: 'actualizado_en',
    },
  });
}

module.exports = { createSequelize };
