require('dotenv').config();
const express = require('express');
const pg = require('pg');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const { User, sequelize } = require('./models/User');
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
sequelize.sync()
    .then(() => {
        console.log('Vinnie Grid: PostgreSQL Database Connected');
    })
    .catch(err => console.error('PostgreSQL Connection Error:', err));

// --- SESSION & AUTH ---
const pgPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

app.use(session({
    store: new PgSession({
        pool: pgPool,
        tableName: 'session',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'vinnie_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24
    } 
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findByPk(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
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
        let user = await User.findOne({ where: { googleId: profile.id } });
        if (!user) {
            user = await User.create({ 
                googleId: profile.id, 
                displayName: profile.displayName,
                avatar: profile.photos && profile.photos[0] ? profile.photos[0].value : null 
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
        let user = await User.findOne({ where: { githubId: profile.id } });
        if (!user) {
            user = await User.create({ 
                githubId: profile.id, 
                displayName: profile.username || profile.displayName,
                avatar: profile.photos && profile.photos[0] ? profile.photos[0].value : null 
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
