#!/usr/bin/env node
'use strict';

// Capture headers generated from preferences, never from an injected HTTP header.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

async function capture(binary, engine, preferences) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'x4b-language-browser-'));
    const server = http.createServer();
    let timeout, child;
    try {
        const captured = new Promise((resolve, reject) => {
            server.on('request', (request, response) => {
                response.writeHead(200, { 'Content-Type': 'text/html' });
                response.end('<!doctype html><title>Local language capture</title><p>Header captured.</p>');
                if (request.url === '/capture') resolve(request.headers['accept-language'] || '');
            });
            timeout = setTimeout(() => reject(new Error(`No header from ${binary}`)), 30000);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}/capture`;
        let args;
        if (engine === 'chromium') {
            fs.mkdirSync(path.join(profile, 'Default'));
            fs.writeFileSync(path.join(profile, 'Default/Preferences'), JSON.stringify({ intl: { accept_languages: preferences, selected_languages: preferences } }));
            args = ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', `--user-data-dir=${profile}`, '--dump-dom', url];
        } else {
            fs.writeFileSync(path.join(profile, 'user.js'), `user_pref("intl.accept_languages", ${JSON.stringify(preferences)});\nuser_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);\n`);
            args = ['--headless', '--no-remote', '--profile', profile, '--screenshot', path.join(profile, 'capture.png'), url];
        }
        child = spawn(binary, args, { stdio: 'ignore' });
        child.on('error', error => console.error(error.message));
        const header = await captured;
        return { preferences, header };
    } finally {
        clearTimeout(timeout);
        child?.kill('SIGTERM');
        if (child && child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
        if (child && child.exitCode === null) child.kill('SIGKILL');
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

async function main() {
    const browsers = [
        { name: 'chrome', engine: 'chromium', binary: process.env.CHROME_BINARY || '/usr/bin/google-chrome' },
        { name: 'edge', engine: 'chromium', binary: process.env.EDGE_BINARY || '/usr/bin/microsoft-edge' },
        { name: 'firefox', engine: 'gecko', binary: process.env.FIREFOX_BINARY },
    ].filter(browser => browser.binary && fs.existsSync(browser.binary));
    const results = [];
    for (const browser of browsers) {
        const version = execFileSync(browser.binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const cases = [];
        for (const preferences of ['de-DE,de,en', 'zh-TW,zh,en', 'sr-Latn-RS,sr-Latn,sr,en', 'nb-NO,nb,no,en']) {
            cases.push(await capture(browser.binary, browser.engine, preferences));
        }
        results.push({ client: browser.name, version, platform: process.platform, method: 'Isolated local profile with real language preferences; captured incoming HTTP header on loopback. No header override.', cases });
        console.log(`${browser.name}: captured ${cases.length} profiles`);
    }
    fs.writeFileSync(path.join(root, 'coverage/browser-captures.json'), JSON.stringify({ capturedAt: new Date().toISOString(), limitations: 'These are Linux captures, not Windows OS measurements. Firefox may be the locally available Playwright build; the recorded version identifies it. Country cases derived from these algorithms are labelled separately.', browsers: results }, null, 2) + '\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
