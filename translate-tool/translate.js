const translate = require('@iamtraction/google-translate');
const source = require('../language/en.json')
const fs = require('fs')
const toLanguage = process.argv[process.argv.length - 1]

async function translateObject(obj, result, key){
    if(Array.isArray(obj)){
        if(!result[key]) result[key] = []
        for(const v of obj){
            await translateObject(v, result[key], result[key].length)
        }
        return
    }
    if(typeof obj === 'object'){
        if(!result[key]) result[key] = {}
        for(const k in obj){
            await translateObject(obj[k], result[key], k)
        }
        return
    }

    const r = await translate(obj, {from: 'en', to: toLanguage})
    result[key] = r.text
}

async function main(){
    const result = {}
    await translateObject(source, {root: result}, 'root')
    fs.writeFileSync(`../language/${toLanguage}.json`, JSON.stringify(result), "utf8")
}

main()