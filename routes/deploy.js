const express = require('express');
const router = express.Router();
const axios = require('axios');
const Heroku = require('heroku-client');
const User = require('../models/User');

const heroku = new Heroku({ token: process.env.HEROKU_API_KEY });
const OFFICIAL_REPO = "https://github.com/Vinny256/COMRADES-MD";

// 1. DYNAMIC SCANNER: Detects app.json (Blueprints) OR Procfile
router.post('/scan', async (req, res) => {
    const { repoUrl } = req.body;
    // UPDATED: Now prioritize the repoUrl from the search bar
    const targetRepo = repoUrl && repoUrl.trim() !== "" ? repoUrl : OFFICIAL_REPO;
    
    try {
        const cleanUrl = targetRepo.replace(/\/$/, "");
        const baseRaw = cleanUrl.replace('github.com', 'raw.githubusercontent.com') + '/main/';
        
        let requirements = [];
        let isBlueprint = false;

        try {
            // Check for app.json first
            const response = await axios.get(`${baseRaw}app.json`);
            const blueprint = response.data;
            isBlueprint = true;

            // Map keys with their pre-filled values/descriptions
            if (blueprint.env) {
                requirements = Object.keys(blueprint.env).map(key => ({
                    key: key,
                    value: blueprint.env[key].value || "", // Pre-fill if exists
                    description: blueprint.env[key].description || ""
                }));
            }
        } catch (e) {
            // FALLBACK: If no app.json, check for Procfile
            try {
                const procResponse = await axios.get(`${baseRaw}Procfile`);
                requirements = [{ 
                    key: "PROCFILE_DETECTED", 
                    value: procResponse.data, 
                    description: "No blueprint found. Using Procfile startup logic." 
                }];
            } catch (pErr) {
                return res.json({ success: false, message: "No app.json or Procfile found in this repo." });
            }
        }

        res.json({ 
            success: true, 
            requirements: requirements, 
            repo: targetRepo,
            isBlueprint: isBlueprint,
            name: isBlueprint ? "Blueprint Unit" : "Generic Unit"
        });
    } catch (error) {
        res.json({ success: false, message: "Could not scan repository." });
    }
});

// 2. DYNAMIC LAUNCHER: Injects user vars + Admin vars (API KEY/Random Name)
router.post('/launch', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: 'Please login first' });
    
    const { configVars, repoUrl } = req.body;
    const user = await User.findById(req.user.id);

    if (user.hasDeployed) return res.json({ success: false, message: "Your slot is already occupied!" });

    try {
        const finalRepo = repoUrl || OFFICIAL_REPO;
        // RANDOM APP NAME GENERATOR (Renamed to Unit Identity in UI)
        const unitName = `vinnie-unit-${Math.random().toString(36).substring(2, 8)}`;

        // Create the App in the Grid (Heroku Team)
        const app = await heroku.post('/teams/apps', {
            body: {
                name: unitName,
                team: process.env.HEROKU_TEAM_NAME,
                region: "us"
            }
        });

        // MERGE: User config + Admin Keys + Auto-Vars
        const finalConfig = {
            ...configVars,
            "HEROKU_API_KEY": process.env.HEROKU_API_KEY, // Use your admin key from .env
            "HEROKU_APP_NAME": unitName,
            "GITHUB_REPO": finalRepo
        };

        // Inject all variables
        await heroku.patch(`/apps/${app.name}/config-vars`, {
            body: finalConfig
        });

        // Trigger Build
        const tarballUrl = `${finalRepo.replace(/\/$/, "")}/tarball/main`;
        await heroku.post(`/apps/${app.name}/builds`, {
            body: {
                source_blob: { url: tarballUrl }
            }
        });

        // Update DB
        user.hasDeployed = true;
        user.activeUnit = app.name;
        await user.save();

        res.json({ success: true, appName: app.name });
    } catch (err) {
        console.error("Grid Launch Error:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. TERMINATE (NO CHANGES)
router.post('/terminate', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false });
    const user = await User.findById(req.user.id);
    if (!user.activeUnit) return res.json({ success: false, message: "No active unit found." });
    try {
        await heroku.delete(`/apps/${user.activeUnit}`);
        user.hasDeployed = false;
        user.activeUnit = null;
        await user.save();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "Termination failed." });
    }
});

// 4. HACKER LOGS: Now Sanitized to hide your info
router.get('/logs/:appName', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send('Unauthorized');
    try {
        const logSession = await heroku.post(`/apps/${req.params.appName}/log-sessions`, {
            body: { lines: 100, tail: false }
        });
        const logData = await axios.get(logSession.logplex_url);
        
        // LOG SANITIZER: Replace your Heroku email and system markers with the user's name
        let sanitizedLogs = logData.data
            .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, req.user.displayName) // Hide Admin Email
            .replace(/app\[web\.1\]:/g, `[${req.user.displayName}]:`) // Mask system process name
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, ""); // Clean up messy timestamps

        res.json({ logs: sanitizedLogs });
    } catch (err) {
        res.json({ logs: "SYSTEM: Initializing Unit Stream...\n" });
    }
});

module.exports = router;