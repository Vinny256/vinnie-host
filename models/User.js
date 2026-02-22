const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    displayName: String,
    googleId: String,
    githubId: String,
    avatar: String,
    activeUnit: {
        type: String,
        default: null // Will store the Heroku App Name once deployed
    },
    hasDeployed: {
        type: Boolean,
        default: false // The "One Slot" lock
    }
});

module.exports = mongoose.model('User', UserSchema);