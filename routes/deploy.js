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
    const targetRepo = repoUrl && repoUrl.trim() !== "" ? repoUrl : OFFICIAL_REPO;
    
    try {
        const cleanUrl = targetRepo.replace(/\/$/, "");
        // We try 'main' first, then 'master' as a fallback for raw content
        const baseRaw = cleanUrl.replace('github.com', 'raw.githubusercontent.com') + '/main/';
        
        let requirements = [];
        let isBlueprint = false;

        try {
            const response = await axios.get(`${baseRaw}app.json`);
            const blueprint = response.data;
            isBlueprint = true;

            if (blueprint.env) {
                requirements = Object.keys(blueprint.env).map(key => ({
                    key: key,
                    value: blueprint.env[key].value || "", 
                    description: blueprint.env[key].description || ""
                }));
            }
        } catch (e) {
            try {
                const procResponse = await axios.get(`${baseRaw}Procfile`);
                requirements = [{ 
                    key: "PROCFILE_DETECTED", 
                    value: procResponse.data.substring(0, 50), 
                    description: "No blueprint found. Using Procfile startup logic." 
                }];
            } catch (pErr) {
                // Try one more time with 'master' branch instead of 'main'
                return res.json({ success: false, message: "No app.json or Procfile found. Ensure your repo is public and branch is named 'main'." });
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

// 2. DYNAMIC LAUNCHER: Injects user vars + Admin vars
router.post('/launch', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: 'Please login first' });
    
    const { configVars, repoUrl } = req.body;
    const user = await User.findById(req.user.id);

    if (user.hasDeployed) return res.json({ success: false, message: "Your slot is already occupied!" });

    try {
        const finalRepo = repoUrl || OFFICIAL_REPO;
        // Use the generated name from frontend if provided, else generate new
        const unitName = configVars.APP_NAME || `vinnie-unit-${Math.random().toString(36).substring(2, 8)}`;

        // Create the App in the Grid
        const app = await heroku.post('/teams/apps', {
            body: {
                name: unitName,
                team: process.env.HEROKU_TEAM_NAME,
                region: "us"
            }
        });

        const finalConfig = {
            ...configVars,
            "HEROKU_API_KEY": process.env.HEROKU_API_KEY, 
            "HEROKU_APP_NAME": unitName,
            "GITHUB_REPO": finalRepo
        };

        // Inject all variables
        await heroku.patch(`/apps/${app.name}/config-vars`, {
            body: finalConfig
        });

        // Trigger Build - Uses the GitHub Archive API for the tarball
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

// 3. TERMINATE
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

// 4. HACKER LOGS: Sanitized with Kenya Time
router.get('/logs/:appName', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send('Unauthorized');
    try {
        const logSession = await heroku.post(`/apps/${req.params.appName}/log-sessions`, {
            body: { lines: 100, tail: false }
        });
        const logData = await axios.get(logSession.logplex_url);
        
        let sanitizedLogs = logData.data
            .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, req.user.displayName) 
            .replace(/app\[web\.1\]:/g, `[${req.user.displayName}]:`) 
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, (match) => {
                const localTime = new Date(match).toLocaleString('en-GB', { 
                    timeZone: 'Africa/Nairobi',
                    hour: '2-digit', 
                    minute: '2-digit', 
                    second: '2-digit',
                    hour12: true 
                });
                return `[Nairobi, Kenya | ${localTime}]`;
            });

        res.json({ logs: sanitizedLogs });
    } catch (err) {
        res.json({ logs: "SYSTEM: Handshaking with Unit Identity...\n" });
    }
});

module.exports = router;
