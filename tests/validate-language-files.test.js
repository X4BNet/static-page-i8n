'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateTranslation, validateRepository, readJSON } = require('../scripts/validate-language-files');

const reference = {
    title: 'Error loading {host}',
    description: '<strong>Validation complete</strong>. Click <a href="https://www.x4b.net/support">here</a>.',
    causes: ['The server is busy', 'An error occurred in transit'],
    refresh_enable: false,
    protocol: 'Use HTTPS instead of HTTP; add https:// to your URL.',
};

function valid() {
    return {
        title: 'Fehler beim Laden von {host}',
        description: '<strong>Überprüfung abgeschlossen</strong>. Klicken Sie <a href="https://www.x4b.net/support">hier</a>.',
        causes: ['Der Server ist ausgelastet', 'Bei der Übertragung ist ein Fehler aufgetreten'],
        refresh_enable: false,
        protocol: 'Verwenden Sie HTTPS statt HTTP; ergänzen Sie https:// am Anfang Ihrer URL.',
    };
}

test('accepts translated text with unchanged structure and formatting', () => {
    assert.deepEqual(validateTranslation(valid(), reference), []);
});

test('accepts locale rendering metadata separately from English prose and settings', () => {
    assert.deepEqual(validateTranslation({ ...valid(), direction: 'rtl', fontClass: 'l' }, reference), []);
    assert.match(validateTranslation({ ...valid(), direction: 'sideways' }, reference).join('\n'), /direction: expected/u);
    assert.match(validateTranslation({ ...valid(), fontClass: 'tiny' }, reference).join('\n'), /fontClass: expected/u);
    assert.match(validateTranslation({ ...valid(), causes: [{ direction: 'rtl' }] }, reference).join('\n'), /expected a string/u);
});

test('requires every English key and rejects unknown keys', () => {
    const candidate = valid();
    delete candidate.title;
    candidate.typo = 'Fehler';
    assert.match(validateTranslation(candidate, reference).join('\n'), /title: missing key/);
    assert.match(validateTranslation(candidate, reference).join('\n'), /unexpected key typo/);
});

test('preserves array length and validates entries against their own source index', () => {
    const candidate = valid();
    candidate.causes.pop();
    assert.match(validateTranslation(candidate, reference).join('\n'), /expected 2 array entries/);
    assert.notDeepEqual(validateTranslation(['{two}', '{one}'], ['{one}', '{two}']), []);
});

test('rejects translated, stringified, or changed booleans', () => {
    for (const value of ['false', 'falsch', true, 0, null]) {
        assert.match(validateTranslation({ ...valid(), refresh_enable: value }, reference).join('\n'), /setting must remain false/);
    }
});

test('rejects missing, renamed, repeated, and double-braced template tokens', () => {
    for (const title of ['Fehler', 'Fehler {http_host}', 'Fehler {host} {host}', 'Fehler {{host}}']) {
        assert.match(validateTranslation({ ...valid(), title }, reference).join('\n'), /template placeholders/);
    }
});

test('rejects altered support URLs, attributes, and malformed tag nesting', () => {
    for (const description of [
        valid().description.replace('/support', '/'),
        valid().description.replace('<strong>', '<strong class="new">'),
        '<strong><a href="https://www.x4b.net/support">Fehler</strong></a>',
    ]) {
        assert.notDeepEqual(validateTranslation({ ...valid(), description }, reference), []);
    }
});

test('preserves protocol literals and technical identifiers', () => {
    for (const protocol of [
        valid().protocol.replace('https://', 'http://'),
        valid().protocol.replace('HTTPS', 'https'),
    ]) {
        assert.match(validateTranslation({ ...valid(), protocol }, reference).join('\n'), /technical identifiers/);
    }
});

test('rejects empty translations and wrong container types', () => {
    assert.notDeepEqual(validateTranslation({ ...valid(), title: ' ' }, reference), []);
    assert.notDeepEqual(validateTranslation({ ...valid(), causes: {} }, reference), []);
    assert.notDeepEqual(validateTranslation([], reference), []);
});

test('reads UTF-8 strictly instead of accepting replacement characters', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x4b-utf8-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'broken.json');
    fs.writeFileSync(filename, Buffer.from([0x22, 0xc3, 0x28, 0x22]));
    assert.throws(() => readJSON(filename), /encoded data/u);
});

test('requires the complete catalog and flags English filler and duplicate files', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x4b-catalog-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'language'));
    const catalog = readJSON(path.join(__dirname, '..', 'languages.json'));
    // An intentionally tiny schema makes the repository-level failures clear.
    catalog.nginxDocumentation = false;
    for (const language of catalog.languages) { delete language.script; delete language.aliasOf; }
    fs.writeFileSync(path.join(directory, 'languages.json'), JSON.stringify(catalog));
    const write = (tag, text) => fs.writeFileSync(path.join(directory, 'language', `${tag}.json`), JSON.stringify({ text }));
    for (const language of catalog.languages) write(language.tag, language.tag);
    assert.deepEqual(validateRepository(directory), []);
    fs.writeFileSync(path.join(directory, 'language', 'de.json'), JSON.stringify({ direction: 'sideways', text: 'de' }));
    assert.match(validateRepository(directory).join('\n'), /de: direction must be either ltr or rtl/u);
    fs.writeFileSync(path.join(directory, 'language', 'de.json'), JSON.stringify({ fontClass: 'tiny-font', text: 'de' }));
    assert.match(validateRepository(directory).join('\n'), /de: fontClass must be l when supplied/u);
    write('de', 'de');
    fs.unlinkSync(path.join(directory, 'language', 'vi.json'));
    write('vn', 'vi');
    write('de', 'en');
    write('fr', 'es');
    const failures = validateRepository(directory).join('\n');
    assert.match(failures, /Missing language\/vi.json/u);
    assert.match(failures, /Unexpected language\/vn.json/u);
    assert.match(failures, /de: text: unchanged English text needs review/u);
    assert.match(failures, /fr: identical to es/u);
    catalog.languages = catalog.languages.filter(language => language.tag !== 'vi');
    fs.writeFileSync(path.join(directory, 'languages.json'), JSON.stringify(catalog));
    assert.match(validateRepository(directory).join('\n'), /Missing original language: vi/u);
});

test('requires an explicit same-identity alias for identical locale files', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x4b-alias-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'language'));
    const catalog = readJSON(path.join(__dirname, '..', 'languages.json'));
    catalog.nginxDocumentation = false;
    for (const language of catalog.languages) {
        delete language.script;
        delete language.aliasOf;
        fs.writeFileSync(path.join(directory, 'language', `${language.tag}.json`), JSON.stringify({ text: language.tag }));
    }
    const variant = { tag: 'de-latn-de', languageId: 'de', aliasOf: 'de' };
    catalog.languages.push(variant);
    fs.writeFileSync(path.join(directory, 'language', `${variant.tag}.json`), JSON.stringify({ text: 'de' }));
    const check = () => {
        fs.writeFileSync(path.join(directory, 'languages.json'), JSON.stringify(catalog));
        return validateRepository(directory).join('\n');
    };
    assert.equal(check(), '');
    variant.scriptCode = 'Cyrl';
    assert.match(check(), /same language identity and script/u);
    delete variant.scriptCode;
    delete variant.aliasOf;
    assert.match(check(), /identical to de without a declared alias/u);
    variant.aliasOf = 'de'; variant.languageId = 'fr';
    assert.match(check(), /same language identity and script/u);
    variant.languageId = 'de'; variant.aliasOf = 'de-latn-de';
    assert.match(check(), /refer directly to a non-alias/u);
    variant.aliasOf = 'de';
    fs.writeFileSync(path.join(directory, 'language', `${variant.tag}.json`), JSON.stringify({ text: 'anderer Text' }));
    assert.match(check(), /alias content differs from de/u);
});
