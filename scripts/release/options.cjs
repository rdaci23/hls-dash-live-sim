const {parseArgs}=require('node:util');
function reviewOptions(args){
    const {values}=parseArgs({args,options:{output:{type:'string'},'extended-soak':{type:'boolean',default:false}},allowPositionals:false});
    if(!values.output)throw Error('Use npm run release:review -- --output NEW_DIRECTORY [--extended-soak]');
    return {output:values.output,extendedSoak:values['extended-soak']};
}
module.exports={reviewOptions};
