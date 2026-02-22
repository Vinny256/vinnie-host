require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const User = require('./models/User');
const path = require('path');
const Heroku = require('heroku-client');

const app = express();
// --- FIX 1: TRUST HEROKU PROXY ---
app.set('trust proxy', 1); 

const heroku = new Heroku({ token: process.env.HEROKU_API_KEY });

// --- CONFIGURATION ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- DATABASE ---
mongoose.connect(process.env.MONGO_URI)
    .then(async () => {
        console.log('Vinnie Grid: Database Connected');
        try {
            const collections = await mongoose.connection.db.listCollections({ name: 'users' }).toArray();
            if (collections.length > 0) {
                await mongoose.connection.collection('users').dropIndex('email_1');
                console.log('🛡️ Fixed: Broken email index removed.');
            }
        } catch (e) {
            console.log('🚀 Grid Status: Database schema is clean.');
        }
    })
    .catch(err => console.error('Database Connection Error:', err));

// --- SESSION & AUTH ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'vinnie_secret_key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } 
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    User.findById(id).then(user => done(null, user));
});

// --- STRATEGIES ---
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback",
    // --- FIX 2: ENABLE PROXY FOR GOOGLE ---
    proxy: true 
}, async (accessToken, refreshToken, profile, done) => {
    try {
        let user = await User.findOne({ googleId: profile.id });
        if (!user) {
            user = await User.create({ 
                googleId: profile.id, 
                displayName: profile.displayName,
                avatar: profile.photos[0].value 
            });
        }
        return done(null, user);
    } catch (err) { return done(err, null); }
}));

passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: "/auth/github/callback",
    // --- FIX 3: ENABLE PROXY FOR GITHUB ---
    proxy: true 
}, async (accessToken, refreshToken, profile, done) => {
    try {
        let user = await User.findOne({ githubId: profile.id });
        if (!user) {
            user = await User.create({ 
                githubId: profile.id, 
                displayName: profile.username || profile.displayName,
                avatar: profile.photos[0].value 
            });
        }
        return done(null, user);
    } catch (err) { return done(err, null); }
}));

// --- ROUTES ---

// Redirect root to dashboard so the blurred UI shows immediately
app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/github', passport.authenticate('github', { scope: ['user:email'] }));

app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));
app.get('/auth/github/callback', passport.authenticate('github', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

// UPDATED DASHBOARD: Now allows unauthenticated users (renders blurred background)
app.get('/dashboard', async (req, res) => {
    try {
        // Still fetch heroku app count for guests to see global status
        const herokuApps = await heroku.get(`/teams/${process.env.HEROKU_TEAM_NAME}/apps`);
        const totalDeployed = herokuApps.length;

        res.render('dashboard', { 
            user: req.user || null, // If not logged in, pass null
            totalDeployed: totalDeployed 
        });
    } catch (err) {
        console.log("Heroku Slot Fetch Error:", err.message);
        res.render('dashboard', { 
            user: req.user || null, 
            totalDeployed: 0 
        });
    }
});

// Link the Deploy Logic
const deployRoutes = require('./routes/deploy');
app.use('/deploy', deployRoutes);

app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/');
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vinnie Host running on port ${PORT}`));
