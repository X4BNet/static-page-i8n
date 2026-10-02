#!/usr/bin/env node
'use strict';

// Use the sibling generator's renderers, minifier, styles and scripts in an
// isolated snapshot. CAPTCHA/proof inputs are deterministic local fixtures.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.resolve(process.env.VISUAL_REVIEW_OUTPUT || path.join(ROOT, 'visual-review'));
const SOURCE = path.resolve(process.env.STATIC_PAGES_SOURCE || path.join(ROOT, '../static-pages'));
const SNAPSHOT = path.join(OUTPUT, 'generator');
const CAPTURE_VERSION = 2;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const write = (filename, value) => { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, value); };

function inventory(directory, base = directory) {
    const files = {};
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) Object.assign(files, inventory(filename, base));
        else if (entry.isFile()) files[path.relative(base, filename)] = hash(fs.readFileSync(filename));
    }
    return files;
}

function snapshot() {
    fs.mkdirSync(OUTPUT, { recursive: true });
    if (fs.existsSync(path.join(OUTPUT, 'generator-source.json'))) return;
    fs.mkdirSync(SNAPSHOT, { recursive: true });
    for (const name of ['src', 'resources', 'gulpfile.js', 'package.json', 'package-lock.json', 'tests/fixtures/recaptcha']) {
        fs.cpSync(path.join(SOURCE, name), path.join(SNAPSHOT, name), { recursive: true });
    }
    fs.symlinkSync(path.join(SOURCE, 'node_modules'), path.join(SNAPSHOT, 'node_modules'), 'dir');
    fs.mkdirSync(path.join(SNAPSHOT, 'language'));
    const metadata = {
        capturedAt: new Date().toISOString(), source: '../static-pages',
        commit: execFileSync('git', ['-C', SOURCE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        files: inventory(SNAPSHOT),
        note: 'Exact snapshot of the sibling working tree including concurrent uncommitted changes; shared installed dependencies, no sibling files edited.',
    };
    write(path.join(OUTPUT, 'generator-source.json'), JSON.stringify(metadata, null, 2) + '\n');
    execFileSync(process.execPath, [path.join(SNAPSHOT, 'node_modules/gulp/bin/gulp.js'), '--cwd', SNAPSHOT, 'build-styles', 'build-img'], { stdio: 'inherit' });
}

async function main() {
    snapshot();
    const ErrorPage = require(path.join(SNAPSHOT, 'src/ErrorPage'));
    const SensePage = require(path.join(SNAPSHOT, 'src/SensePage'));
    const minify = require(path.join(SNAPSHOT, 'src/HtmlMinification'));
    const SimpleTemplate = require(path.join(SNAPSHOT, 'src/SimpleTemplate'));
    const File = require(path.join(SNAPSHOT, 'node_modules/vinyl'));
    const escapeHtml = require(path.join(SNAPSHOT, 'node_modules/escape-html'));
    const { chromium } = require(path.join(SNAPSHOT, 'node_modules/@playwright/test'));
    const catalog = read(path.join(ROOT, 'languages.json'));
    const filter = process.argv.find(arg => arg.startsWith('--locales='))?.slice('--locales='.length).split(',');
    const planFile = process.argv.find(arg => arg.startsWith('--views-file='))?.slice('--views-file='.length);
    const viewPlan = planFile ? read(path.resolve(planFile)) : null;
    if (viewPlan && Object.keys(viewPlan).some(tag => !catalog.languages.some(locale => locale.tag === tag))) throw new Error('Unknown locale in --views-file');
    const languages = catalog.languages.filter(locale => (!filter || filter.includes(locale.tag)) && (!viewPlan || Object.hasOwn(viewPlan, locale.tag))).sort((a, b) => a.tag === 'en' ? -1 : b.tag === 'en' ? 1 : a.tag.localeCompare(b.tag));
    if (filter && languages.length !== new Set(filter).size) throw new Error('Unknown locale in --locales');
    const force = process.argv.includes('--force');
    const source = read(path.join(OUTPUT, 'generator-source.json'));
    const fontconfig = path.join(OUTPUT, 'fontconfig.xml');
    const fontFingerprint = fs.existsSync(fontconfig) ? hash(fs.readFileSync(fontconfig)) : null;
    const manifestPath = path.join(OUTPUT, 'manifest.json');
    const manifest = fs.existsSync(manifestPath) ? read(manifestPath) : {
        schemaVersion: 1, generator: source, viewport: { width: 1280, height: 720 },
        conditions: 'Chromium, desktop 1280×720, device scale 1, light scheme, local system fonts, external Google Fonts blocked, sibling CAPTCHA fixture. Proof-of-work input disabled for stable CAPTCHA; other challenge states expose the production CSS/translated DOM without completing a real proof. No production verification requests.',
        generation: 'Sibling ErrorPage/SensePage and HtmlMinification, same page roster and default-direction stripping as gulp. Styles/images built by sibling gulp. Protection JavaScript uses the sibling source and exact gulp translation-substitution rules, without Closure minification; this review tests rendered translations rather than compiler output.',
        locales: {},
    };
    const planFingerprint = viewPlan ? hash(JSON.stringify(viewPlan)) : null;
    if ((manifest.viewPlanSha256 || null) !== planFingerprint && Object.keys(manifest.locales).length) throw new Error('Use a new output directory for a different capture plan');
    manifest.viewPlanSha256 = planFingerprint;
    manifest.viewPlan = viewPlan;
    for (const tag of ['en', ...languages.map(locale => locale.tag)]) fs.copyFileSync(path.join(ROOT, 'language', `${tag}.json`), path.join(SNAPSHOT, 'language', `${tag}.json`));
    const errors = [...new Set(ErrorPage.Pages)];
    const pages = [...errors, 'challenge', 'antispam'];
    const defaultViews = pages.map(page => ({ page, state: 'default' }));
    for (const state of ['loading', 'complete', 'error', 'timeout']) defaultViews.push({ page: 'challenge', state });
    for (const page of ['challenge', 'antispam']) defaultViews.push({ page, state: 'nojs' });
    if (viewPlan) for (const [tag, views] of Object.entries(viewPlan)) {
        if (!Array.isArray(views) || !views.length || new Set(views.map(view => `${view.page}/${view.state}`)).size !== views.length
            || views.some(view => !defaultViews.some(valid => valid.page === view.page && valid.state === view.state))) throw new Error(`${tag}: invalid or duplicate capture view`);
    }
    const minified = html => new Promise((resolve, reject) => {
        const stream = minify();
        stream.on('error', reject);
        stream.on('data', file => resolve(minify.stripDefaultHtmlDirection(file.contents.toString('utf8'))));
        stream.end(new File({ path: 'page.html', contents: Buffer.from(html) }));
    });
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        let filename;
        if (url.pathname === '/cdn-bin/x4b/.pow.js') {
            response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
            return response.end('var P=0,E=0,D=1;(function(){var s=document.createElement("script");s.src="/cdn-bin/x4b/.static/protection."+document.documentElement.lang+".js";document.head.appendChild(s)})();');
        }
        if (url.pathname.startsWith('/cdn-bin/x4b/.static/')) filename = path.join(SNAPSHOT, 'dist/cdn', path.basename(url.pathname));
        else if (url.pathname.startsWith('/fixtures/recaptcha/')) filename = path.join(SNAPSHOT, 'tests/fixtures/recaptcha', path.basename(url.pathname));
        else filename = path.join(OUTPUT, 'html', url.pathname);
        if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) { response.writeHead(404); return response.end(); }
        const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.gif': 'image/gif', '.png': 'image/png' };
        response.writeHead(200, { 'Content-Type': `${types[path.extname(filename)] || 'application/octet-stream'}; charset=utf-8` });
        response.end(fs.readFileSync(filename));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.VISUAL_REVIEW_BROWSER || '/usr/bin/google-chrome', args: ['--no-sandbox'], env: { ...process.env, ...(fs.existsSync(fontconfig) ? { FONTCONFIG_FILE: fontconfig } : {}) } });
    manifest.browser = await browser.version();
    manifest.platform = process.platform;
    manifest.origin = origin;
    manifest.fonts = { taskLocalFontConfig: fontFingerprint, package: fs.existsSync(fontconfig) ? 'Debian fonts-noto-core 20201225-2, extracted into this artifact directory; system fonts also available' : 'System fonts only' };
    const queue = [...languages];
    try {
        async function worker() {
            const context = await browser.newContext({ viewport: manifest.viewport, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US' });
            const nojs = await browser.newContext({ viewport: manifest.viewport, deviceScaleFactor: 1, javaScriptEnabled: false });
            for (const ctx of [context, nojs]) {
                await ctx.route('**/*', route => {
                    const url = route.request().url();
                    if (url.startsWith(origin)) return route.continue();
                    if (url.startsWith('https://www.recaptcha.net/recaptcha/api.js')) return route.fulfill({ path: path.join(SNAPSHOT, 'tests/fixtures/recaptcha/api.js'), contentType: 'application/javascript' });
                    if (url.startsWith('https://www.recaptcha.net/recaptcha/api/fallback')) return route.fulfill({ body: '<!doctype html><html><body style="font:14px sans-serif;background:#fafafa">CAPTCHA test fixture</body></html>', contentType: 'text/html' });
                    return route.abort();
                });
            }
            const page = await context.newPage();
            const nojsPage = await nojs.newPage();
            while (queue.length) {
                const locale = queue.shift();
                const tag = locale.tag;
                const translationBytes = fs.readFileSync(path.join(ROOT, 'language', `${tag}.json`));
                const translationHash = hash(translationBytes);
                const views = viewPlan?.[tag] || defaultViews;
                const viewSelectionSha256 = viewPlan ? hash(JSON.stringify(views)) : null;
                if (!force && manifest.locales[tag]?.translationSha256 === translationHash && manifest.locales[tag]?.captureVersion === CAPTURE_VERSION && manifest.locales[tag]?.fontFingerprint === fontFingerprint && (manifest.locales[tag]?.viewSelectionSha256 || null) === viewSelectionSha256) continue;
                // Render exactly the bytes fingerprinted here, including edits made
                // after the initial snapshot copy while another locale was captured.
                write(path.join(SNAPSHOT, 'language', `${tag}.json`), translationBytes);
                const translation = JSON.parse(translationBytes);
                const vars = {};
                for (const [key, value] of Object.entries(translation.challenge)) {
                    vars[`"{{${key}}}"`] = JSON.stringify(escapeHtml(value));
                    vars[`"{{{${key}}}}"`] = JSON.stringify(value);
                }
                write(path.join(SNAPSHOT, 'dist/cdn', `protection.${tag}.js`), SimpleTemplate.template(fs.readFileSync(path.join(SNAPSHOT, 'resources/js/protection.js'), 'utf8'), vars));
                fs.copyFileSync(path.join(SNAPSHOT, 'resources/js/antispam.js'), path.join(SNAPSHOT, 'dist/cdn/antispam.js'));
                const record = { translationSha256: translationHash, script: locale.script, languageId: locale.languageId, origin, captureVersion: CAPTURE_VERSION, fontFingerprint, viewSelectionSha256, html: [], screenshots: [] };
                for (const name of pages) {
                    const html = errors.includes(name) ? await new ErrorPage(tag, name).render() : await new SensePage(tag, path.join(SNAPSHOT, 'resources/html', `${name}.html`), 'challenge').render();
                    let output = await minified(html);
                    if (errors.includes(name)) output = output.includes('</html>') ? output.replace('</html>', '<!-- X4B --></html>') : output + '<!-- X4B -->';
                    // Runtime POST fields are not translation text; empty form fixture.
                    if (name === 'antispam') output = output.replace('__POSTFIELDS__', '');
                    const relative = `html/${tag}/${name}.html`;
                    write(path.join(OUTPUT, relative), output);
                    record.html.push({ page: name, file: relative, sha256: hash(output) });
                }
                for (const view of views) {
                    const active = view.state === 'nojs' ? nojsPage : page;
                    const errorsSeen = [];
                    const onError = error => errorsSeen.push(error.message);
                    active.on('pageerror', onError);
                    const response = await active.goto(`${origin}/${tag}/${view.page}.html`, { waitUntil: 'load' });
                    if (response.status() !== 200) throw new Error(`${tag}/${view.page}: HTTP ${response.status()}`);
                    if (['challenge', 'antispam'].includes(view.page) && view.state !== 'nojs') await active.locator('iframe[title="reCAPTCHA"]').waitFor();
                    await active.evaluate(async state => {
                        await document.fonts.ready;
                        if (['loading', 'complete', 'error', 'timeout'].includes(state)) {
                            document.querySelector('section').className = 'hide';
                            document.body.className = { loading: 'l', complete: 'redirecting', error: 'error', timeout: 'tl' }[state];
                            if (state === 'loading') {
                                document.querySelector('h1').innerHTML = langLoading.replace('{http_host}', location.host);
                                document.querySelector('.n').style.display = '';
                            }
                        }
                    }, view.state);
                    const relative = `images/${tag}/${view.page}--${view.state}.png`;
                    fs.mkdirSync(path.dirname(path.join(OUTPUT, relative)), { recursive: true });
                    await active.screenshot({ path: path.join(OUTPUT, relative), fullPage: true, animations: 'disabled' });
                    const inspection = await active.evaluate(() => {
                        const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width && r.height && s.display !== 'none' && s.visibility !== 'hidden'; };
                        const panel = document.querySelector('body > div');
                        const bounds = panel?.getBoundingClientRect();
                        const textBoxes = [...document.querySelectorAll('h1,p,li,strong,section>span,input[type=submit]')].filter(visible).map(element => {
                            const r = element.getBoundingClientRect();
                            return { tag: element.tagName, text: element.value || element.innerText, x: r.x, y: r.y, width: r.width, height: r.height };
                        });
                        return {
                            title: document.title, direction: getComputedStyle(document.documentElement).direction,
                            visibleSubmitControls: [...document.querySelectorAll('input[type=submit],button[type=submit]')].filter(visible).length,
                            loadingMessageVisible: [...document.querySelectorAll('header .n')].some(visible),
                            horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
                            panelOverflow: !!bounds && textBoxes.some(r => r.y < bounds.top || r.y + r.height > bounds.bottom + 1),
                            textBoxes, text: document.body.innerText,
                            panel: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null,
                        };
                    });
                    active.off('pageerror', onError);
                    record.screenshots.push({ ...view, file: relative, sha256: hash(fs.readFileSync(path.join(OUTPUT, relative))), ...inspection, pageErrors: errorsSeen });
                }
                manifest.locales[tag] = record;
                write(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
                console.log(`${tag}: ${record.html.length} HTML pages, ${record.screenshots.length} screenshots`);
            }
            await context.close(); await nojs.close();
        }
        await Promise.all(Array.from({ length: Number(process.env.VISUAL_REVIEW_WORKERS || 4) }, worker));
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
    const links = Object.entries(manifest.locales).sort().map(([tag, record]) => `<section><h2>${tag}</h2>${record.screenshots.map(view => `<a href="${view.file}"><figure><img loading="lazy" width="320" src="${view.file}"><figcaption>${view.page} — ${view.state}</figcaption></figure></a>`).join('')}</section>`).join('\n');
    write(path.join(OUTPUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>All-language visual review</title><style>body{font:16px sans-serif}section{border-bottom:1px solid #ccc}figure{display:inline-block;width:320px;margin:8px}img{border:1px solid #ddd}</style><h1>Generated static pages</h1><p>English is the reference. CAPTCHA is a local test fixture; dynamic state controls are documented in manifest.json.</p>${links}`);
    console.log(`Artifacts: ${OUTPUT}`);
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
