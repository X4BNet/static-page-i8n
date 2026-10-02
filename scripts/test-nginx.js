#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { readmeStatement, checkReadme } = require('./language-catalog');
const { buildAudit, digest, renderGaps } = require('./audit-coverage');
const ROOT = path.resolve(__dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

function request(port, header) {
    return new Promise((resolve, reject) => {
        const headers = header == null ? {} : { 'Accept-Language': header };
        const req = http.get({ hostname: '127.0.0.1', port, path: '/', headers }, response => {
            const bytes = [];
            response.on('data', chunk => bytes.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, selectedLocale: response.headers['content-language'], body: Buffer.concat(bytes) }));
            response.on('error', reject);
        });
        req.setTimeout(5000, () => req.destroy(new Error('nginx request timed out')));
        req.on('error', reject);
    });
}

async function run() {
    const binary = process.env.TEST_NGINX_BINARY;
    if (!binary || !path.isAbsolute(binary)) throw new Error('Set TEST_NGINX_BINARY to the absolute binary path printed by npm run build:nginx.');
    const build = JSON.parse(fs.readFileSync(`${binary}.build.json`, 'utf8'));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), build.binarySha256, 'Binary differs from its recorded build');
    const catalog = read('languages.json');
    assert.deepEqual(checkReadme(catalog), []);
    const audit = buildAudit();
    assert.equal(digest(audit), digest(read('coverage/audit.json')), 'Audit is stale; run npm run audit:coverage');
    const statement = readmeStatement();
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'x4b-language-nginx-test-'));
    const port = await freePort();
    const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$') + '"';
    const config = `daemon off;\nmaster_process off;\npid ${quote(path.join(prefix, 'nginx.pid'))};\nerror_log ${quote(path.join(prefix, 'error.log'))} notice;\nevents { worker_connections 64; }\nhttp {\n${statement}\naccess_log off;\nserver {\nlisten 127.0.0.1:${port};\nlocation / {\nroot ${quote(path.join(ROOT, 'language'))};\ndefault_type application/json;\nadd_header Content-Language $lang always;\ntry_files /$lang.json =404;\n}\n}\n}\n`;
    fs.writeFileSync(path.join(prefix, 'nginx.conf'), config);
    const args = ['-p', `${prefix}/`, '-c', path.join(prefix, 'nginx.conf')];
    let child, closed, exited = false, childError;
    const stderr = [];
    const expectedBodies = new Map(catalog.languages.map(locale => [locale.tag, fs.readFileSync(path.join(ROOT, 'language', `${locale.tag}.json`))]));
    const results = {
        schemaVersion: 1, testedAt: new Date().toISOString(), build,
        auditSha256: digest(audit), catalogSha256: digest(catalog),
        statementSha256: crypto.createHash('sha256').update(statement).digest('hex'),
        translationSha256: Object.fromEntries([...expectedBodies].map(([tag, body]) => [tag, crypto.createHash('sha256').update(body).digest('hex')])),
        nginxConfigTest: null, startup: false, localeRequests: 0,
        supportedLocales: [], focusedCases: [], cases: [],
    };
    try {
        const check = spawn(binary, [...args, '-t'], { stdio: ['ignore', 'pipe', 'pipe'] });
        const output = [];
        check.stdout.on('data', data => output.push(data)); check.stderr.on('data', data => output.push(data));
        const code = await new Promise((resolve, reject) => { check.on('error', reject); check.on('exit', resolve); });
        results.nginxConfigTest = { exitCode: code, output: Buffer.concat(output).toString().replaceAll(prefix, '<temporary-prefix>') };
        assert.equal(code, 0, results.nginxConfigTest.output);
        child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        closed = new Promise(resolve => child.once('close', resolve));
        child.stderr.on('data', chunk => stderr.push(chunk));
        child.on('error', error => { childError = error; });
        child.on('exit', () => { exited = true; });
        for (let attempt = 0; attempt < 100; attempt++) {
            if (childError) throw childError;
            if (exited) throw new Error('Test nginx exited during startup');
            try { await request(port, null); results.startup = true; break; }
            catch { await sleep(25); }
        }
        assert.equal(results.startup, true, 'Test nginx did not become ready');
        async function verify(id, header, expectedLocale) {
            const response = await request(port, header);
            assert.equal(response.status, 200, `${id}: HTTP status`);
            assert.equal(response.selectedLocale, expectedLocale, `${id}: locale for ${JSON.stringify(header)} (module lookup support may be missing)`);
            assert.deepEqual(response.body, expectedBodies.get(expectedLocale), `${id}: JSON response must equal language/${expectedLocale}.json`);
            JSON.parse(response.body.toString('utf8'));
            return { id, header: header ?? null, expectedLocale, selectedLocale: response.selectedLocale, status: response.status, matchesFile: true };
        }
        for (const { tag } of catalog.languages) {
            for (const header of [tag, tag.toUpperCase()]) {
                results.supportedLocales.push(await verify(`${tag}/${header === tag ? 'exact' : 'mixed-case'}`, header, tag));
                results.localeRequests++;
            }
        }
        const focus = [
            ['german-browser-example', 'de-DE,de;q=0.9,en;q=0.8', 'de'],
            ['german-region-alone', 'de-DE', 'de'],
            ['script-region-truncation', 'sr-Latn-RS', 'sr-latn'],
            ['exact-variant-precedence', 'fa-AF,fa;q=0.9', 'fa-af'],
            ['three-letter-language', 'bho-IN', 'bho'],
            ['ordered-preferences', 'zz-ZZ,fr-CA;q=0.9,de;q=0.8', 'fr'],
            ['first-preference-truncation', 'de-DE,es;q=0.9', 'de'],
            ['unsupported-language', 'zz-ZZ', 'en'],
            ['missing-header', null, 'en'],
            ['empty-header', '', 'en'],
            ['wildcard-default', '*', 'en'],
            ['extension-truncation', 'de-DE-u-co-phonebk', 'de'],
            ['taiwan-traditional', 'zh-TW', 'zh-tw'],
            ['hong-kong-traditional', 'zh-HK', 'zh-hk'],
            ['macao-traditional', 'zh-MO', 'zh-mo'],
            ['traditional-script-region', 'zh-Hant-TW', 'zh-hant-tw'],
            ['explicit-simplified-script', 'zh-Hans-TW', 'zh'],
            ['explicit-traditional-script', 'zh-Hant-CN', 'zh-hant'],
            ['windows-sorani', 'ku-ARAB-IQ', 'ku-arab'],
            ['windows-dari', 'prs-AF', 'prs'],
            ['nynorsk-specific', 'nn-NO,no;q=0.9', 'nn'],
            ['quality-ignored-known-limitation', 'de;q=0,fr;q=1', 'de'],
            ['unsorted-quality-known-limitation', 'de;q=0.1,fr;q=1', 'de'],
            ['repeated-header-fields', ['zz-ZZ', 'de-DE'], 'de'],
        ];
        for (const [id, header, selected] of focus) results.focusedCases.push(await verify(id, header, selected));
        for (const profile of audit.cases) results.cases.push(await verify(profile.id, profile.header, profile.expectedLocale));
        fs.writeFileSync(path.join(ROOT, 'coverage/nginx-results.json'), JSON.stringify(results, null, 2) + '\n');
        fs.writeFileSync(path.join(ROOT, 'GAPS.md'), renderGaps(audit, results));
        console.log(`nginx ${build.nginxVersion}: configuration/startup passed; ${results.localeRequests} supported-locale requests, ${focus.length} focused cases, ${results.cases.length} country/client requests passed.`);
    } catch (error) {
        const log = path.join(prefix, 'error.log');
        console.error(Buffer.concat(stderr).toString());
        if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8'));
        throw error;
    } finally {
        if (child?.pid && !exited) {
            child.kill('SIGQUIT');
            for (let i = 0; i < 100 && !exited; i++) await sleep(25);
            if (!exited) child.kill('SIGKILL');
        }
        if (closed) await closed;
        fs.rmSync(prefix, { recursive: true, force: true });
    }
}

run().catch(error => { console.error(error.stack); process.exitCode = 1; });
