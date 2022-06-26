const source = require('../language/en.json')
const fs = require('fs')

async function translateObject(obj, result){
    if(Array.isArray(obj)){
        for(const v of obj){
            await translateObject(v, result)
        }
        return
    }
    if(typeof obj === 'object'){
        for(const k in obj){
            await translateObject(obj[k], result)
        }
        return
    }

    if(typeof obj != 'string') return

    result.push(obj)
}

async function main(){
    const result = []
    await translateObject(source, result)
    console.log([...new Set(result)].join("\n"))
}

main()