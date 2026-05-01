const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    protocol: 'postgres',
    dialectOptions: {
        ssl: {
            require: true,
            rejectUnauthorized: false
        }
    },
    logging: false
});

const User = sequelize.define('User', {
    displayName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    googleId: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true
    },
    githubId: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true
    },
    avatar: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    activeUnit: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: null // Will store the Heroku App Name once deployed
    },
    hasDeployed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false // The "One Slot" lock
    }
});

module.exports = { User, sequelize };
