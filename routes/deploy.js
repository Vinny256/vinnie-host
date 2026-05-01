const express = require('express');
const router = express.Router();
const axios = require('axios');
const Heroku = require('heroku-client');
const { User } = require('../models/User');

const heroku = new Heroku({ token: process.env.HEROKU_API_KEY });
const OFFICIAL_REPO = "https://github.com/Vinny256/COMRADES-MD-BOT";

const normalizeRepo = (repo) => {
    return (repo || "").trim().replace(/\/$/, "").toLowerCase();
};

const getPlanLimit = (plan) => {
    const limits = {
        free: 2,
        startup: 5,
        silver: 10,
        platinum: 50,
        gold: Infinity
    };

    return limits[plan] || 2;
};

// 1. DYNAMIC SCANNER: Detects app.json (Blueprints) OR Procfile
router.post('/scan', async (req, res) => {
    const { repoUrl } = req.body;
    const targetRepo = repoUrl && repoUrl.trim() !== "" ? repoUrl : OFFICIAL_REPO;
    
    try {
        const cleanUrl = targetRepo.replace(/\/$/, "");
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
    const user = await User.findByPk(req.user.id);

    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const finalRepo = repoUrl || OFFICIAL_REPO;
    const selectedRepo = normalizeRepo(finalRepo);
    const officialRepo = normalizeRepo(OFFICIAL_REPO);
    const isOfficialBot = selectedRepo === officialRepo;

    const deployedApps = Array.isArray(user.deployedApps) ? user.deployedApps : [];
    const plan = user.plan || 'free';
    const deployLimit = getPlanLimit(plan);
    const currentDeployments = deployedApps.length;

    if (plan !== 'gold') {
        const officialBotAlreadyDeployed = user.officialBotDeployed || deployedApps.some(app => normalizeRepo(app.repoUrl) === officialRepo);
        const reservedOfficialSlot = officialBotAlreadyDeployed ? 0 : 1;
        const customDeployments = deployedApps.filter(app => normalizeRepo(app.repoUrl) !== officialRepo).length;
        const customLimit = deployLimit - reservedOfficialSlot;

        if (!isOfficialBot && customDeployments >= customLimit) {
            return res.json({ 
                success: false, 
                message: `Your ${plan} plan allows ${deployLimit} backends, but 1 slot is reserved for COMRADES-MD-BOT. Deploy COMRADES-MD-BOT or upgrade your plan.` 
            });
        }

        if (currentDeployments >= deployLimit) {
            return res.json({ 
                success: false, 
                message: `Your ${plan} plan allows only ${deployLimit} backends. Upgrade to deploy more.` 
            });
        }
    }

    try {
        const unitName = configVars.APP_NAME || `vinnie-unit-${Math.random().toString(36).substring(2, 8)}`;

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

        await heroku.patch(`/apps/${app.name}/config-vars`, {
            body: finalConfig
        });

        const tarballUrl = `${finalRepo.replace(/\/$/, "")}/tarball/main`;
        await heroku.post(`/apps/${app.name}/builds`, {
            body: {
                source_blob: { url: tarballUrl }
            }
        });

        const newDeployment = {
            appName: app.name,
            repoUrl: finalRepo,
            isOfficialBot: isOfficialBot,
            createdAt: new Date().toISOString()
        };

        user.deployedApps = [...deployedApps, newDeployment];
        user.hasDeployed = true;
        user.activeUnit = app.name;

        if (isOfficialBot) {
            user.officialBotDeployed = true;
        }

        await user.save();

        res.json({ 
            success: true, 
            appName: app.name,
            appUrl: `https://${app.name}.herokuapp.com`,
            customUrl: `https://${app.name}.gathuo.app`
        });
    } catch (err) {
        console.error("Grid Launch Error:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. TERMINATE
router.post('/terminate', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false });

    const { appName } = req.body;
    const user = await User.findByPk(req.user.id);

    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const deployedApps = Array.isArray(user.deployedApps) ? user.deployedApps : [];
    const targetAppName = appName || user.activeUnit;

    if (!targetAppName) return res.json({ success: false, message: "No active unit found." });

    const targetApp = deployedApps.find(app => app.appName === targetAppName);

    try {
        await heroku.delete(`/apps/${targetAppName}`);

        const remainingApps = deployedApps.filter(app => app.appName !== targetAppName);

        user.deployedApps = remainingApps;
        user.hasDeployed = remainingApps.length > 0;
        user.activeUnit = remainingApps.length > 0 ? remainingApps[remainingApps.length - 1].appName : null;
        user.officialBotDeployed = remainingApps.some(app => normalizeRepo(app.repoUrl) === normalizeRepo(OFFICIAL_REPO));

        await user.save();

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "Termination failed." });
    }
});

// 4. HACKER LOGS
router.get('/logs/:appName', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send('Unauthorized');
    try {
        const logSession = await heroku.post(`/apps/${req.params.appName}/log-sessions`, {
            body: { lines: 100, tail: false }
        });
        const logData = await axios.get(logSession.logplex_url);
        
        if (!logData.data || logData.data.trim() === "") {
            return res.json({ logs: "No new logs yet..." });
        }

        let sanitizedLogs = logData.data
            .split('\n')
            .filter(line => {
                const lowerLine = line.toLowerCase();
                return !lowerLine.includes('log session') && 
                       !lowerLine.includes('logplex') && 
                       !lowerLine.includes('app[api]');
            })
            .join('\n')
            .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, req.user.displayName) 
            .replace(/app\[(web|worker|api)\.1\]:/g, `[${req.user.displayName}]:`) 
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|(\+|-)\d{2}:\d{2})/g, (match) => {
                const localTime = new Date(match).toLocaleString('en-GB', { 
                    timeZone: 'Africa/Nairobi',
                    hour: '2-digit', 
                    minute: '2-digit', 
                    second: '2-digit',
                    hour12: true 
                });
                return `[Nairobi Time | ${localTime}]`;
            });

        res.json({ logs: sanitizedLogs.trim() || "No new logs yet..." });
    } catch (err) {
        res.json({ logs: "SYSTEM: Handshaking with Unit Identity...\n" });
    }
});

module.exports = router;
