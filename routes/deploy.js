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

// 2. DYNAMIC LAUNCHER
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
                message: `Your ${plan} plan allows ${deployLimit} backends, but 1 slot is reserved for COMRADES-MD-BOT.` 
            });
        }

        if (currentDeployments >= deployLimit) {
            return res.json({ 
                success: false, 
                message: `Your ${plan} plan allows only ${deployLimit} backends.` 
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

        await heroku.patch(`/apps/${app.name}/config-vars`, { body: finalConfig });

        const tarballUrl = `${finalRepo.replace(/\/$/, "")}/tarball/main`;
        await heroku.post(`/apps/${app.name}/builds`, {
            body: { source_blob: { url: tarballUrl } }
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

        if (isOfficialBot) user.officialBotDeployed = true;

        await user.save();

        res.json({ 
            success: true, 
            appName: app.name,
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

    const deployedApps = Array.isArray(user.deployedApps) ? user.deployedApps : [];
    const targetAppName = appName || user.activeUnit;

    try {
        await heroku.delete(`/apps/${targetAppName}`);

        const remainingApps = deployedApps.filter(app => app.appName !== targetAppName);

        user.deployedApps = remainingApps;
        user.hasDeployed = remainingApps.length > 0;
        user.activeUnit = remainingApps.length ? remainingApps[remainingApps.length - 1].appName : null;
        user.officialBotDeployed = remainingApps.some(app => normalizeRepo(app.repoUrl) === normalizeRepo(OFFICIAL_REPO));

        await user.save();

        res.json({ success: true });
    } catch {
        res.status(500).json({ success: false });
    }
});

// 4. LOGS
router.get('/logs/:appName', async (req, res) => {
    const logSession = await heroku.post(`/apps/${req.params.appName}/log-sessions`, { body: { lines: 100 } });
    const logData = await axios.get(logSession.logplex_url);
    res.json({ logs: logData.data });
});

// 5. GET CONFIG VARS
router.get('/config/:appName', async (req, res) => {
    const config = await heroku.get(`/apps/${req.params.appName}/config-vars`);
    res.json({ config });
});

// 6. UPDATE CONFIG VARS
router.post('/config/:appName', async (req, res) => {
    const updated = await heroku.patch(`/apps/${req.params.appName}/config-vars`, { body: req.body });
    res.json({ updated });
});

module.exports = router;
