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
        defaultValue: null // Will store the latest Heroku App Name once deployed
    },
    hasDeployed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false // True when user has at least one deployment
    },
    plan: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'free' // free, startup, silver, platinum, gold
    },
    deployLimit: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 2 // Free tier gets 2 backends
    },
    deployedApps: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [] // Stores all deployed apps
    },
    officialBotDeployed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false // Tracks whether COMRADES-MD has been deployed
    }
});

module.exports = { User, sequelize };
