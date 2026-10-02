const source = require('../language/en.json')
const fs = require('fs')
const path = require('path')
const catalog = require('../languages.json')
const { validateTranslation } = require('../scripts/validate-language-files')
const toLanguage = process.argv[process.argv.length - 1]

async function translateObject(obj, result, key){
    if(Array.isArray(obj)){
        if(!result[key]) result[key] = []
        for(const v of obj){
            await translateObject(v, result[key], result[key].length)
        }
        return
    }
    if(obj !== null && typeof obj === 'object'){
        if(!result[key]) result[key] = {}
        for(const k in obj){
            await translateObject(obj[k], result[key], k)
        }
        return
    }

    if(typeof obj !== 'string'){
        result[key] = obj
        return
    }

    const translate = require('@iamtraction/google-translate')
    const r = await translate(obj, {from: 'en', to: toLanguage})
    result[key] = r.text
}

async function main(){
    if(toLanguage === 'en' || !catalog.languages.some(language => language.tag === toLanguage)){
        throw new Error('Choose a non-English language tag from languages.json')
    }
    const result = {}
    await translateObject(source, {root: result}, 'root')
    const errors = validateTranslation(result, source)
    if(errors.length) throw new Error(errors.join('\n'))
    fs.writeFileSync(path.join(__dirname, '..', 'language', `${toLanguage}.json`), JSON.stringify(result, null, 4) + '\n', 'utf8')
}

main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
})
