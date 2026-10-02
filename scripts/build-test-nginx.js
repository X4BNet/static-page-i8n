#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

async function build() {
    const version = '1.26.3';
    const archiveSha256 = '69ee2b237744036e61d24b836668aad3040dda461fe6f570f1787eab570c75aa';
    const modulePath = path.resolve(process.env.NGINX_ACCEPT_LANGUAGE_MODULE || path.join(__dirname, '../../nginx_accept_language_module'));
    const buildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'x4b-language-nginx-build-'));
    const moduleCopy = path.join(buildDirectory, 'accept-language-module');
    fs.mkdirSync(moduleCopy);
    const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const sourceHashes = {};
    for (const name of ['config', 'ngx_http_accept_language_module.c']) {
        const bytes = fs.readFileSync(path.join(modulePath, name));
        fs.writeFileSync(path.join(moduleCopy, name), bytes);
        sourceHashes[name] = hash(bytes);
    }
    const url = `https://nginx.org/download/nginx-${version}.tar.gz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Could not download ${url}: ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (hash(archive) !== archiveSha256) throw new Error('nginx archive differs from the pinned source hash');
    fs.writeFileSync(path.join(buildDirectory, 'nginx.tar.gz'), archive);
    execFileSync('tar', ['-xzf', 'nginx.tar.gz'], { cwd: buildDirectory });
    const source = path.join(buildDirectory, `nginx-${version}`);
    const log = fs.openSync(path.join(buildDirectory, 'build.log'), 'w');
    try {
        execFileSync('./configure', ['--with-debug', `--add-module=${moduleCopy}`], { cwd: source, stdio: ['ignore', log, log] });
        execFileSync('make', ['-j2'], { cwd: source, stdio: ['ignore', log, log] });
    } finally { fs.closeSync(log); }
    const binary = path.join(source, 'objs/nginx');
    const metadata = {
        nginxVersion: version, nginxSource: url, archiveSha256: hash(archive),
        moduleRepository: 'X4BNet/nginx_accept_language_module',
        moduleCommit: execFileSync('git', ['-C', modulePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        moduleSourceHashes: sourceHashes, binarySha256: hash(fs.readFileSync(binary)),
        note: 'Built from an isolated snapshot of the sibling working tree; source hashes identify uncommitted module changes.',
    };
    fs.writeFileSync(`${binary}.build.json`, JSON.stringify(metadata, null, 2) + '\n');
    console.log(binary);
}

build().catch(error => { console.error(error.message); process.exitCode = 1; });
