// Exact identities reviewed against retained native evidence. A recognized
// identity permits evaluation; it never supplies missing fault/clock/AV proof.
const PLAYERS=Object.freeze({hls:'1.7.3',dash:'5.2.1'});
const BROWSERS=Object.freeze({
 scenario:Object.freeze(['156.0.8078.79','156.0.8078.80','157.0.8103.38']),
 causality:Object.freeze(['156.0.8078.80','157.0.8103.38']),
 dvr:Object.freeze(['156.0.8078.76','156.0.8078.79','156.0.8078.80','157.0.8103.38']),
});
function reviewedIdentity(profile,input){
 return Object.hasOwn(BROWSERS,profile)&&Object.hasOwn(PLAYERS,input?.protocol)&&
  input.playerVersion===PLAYERS[input.protocol]&&BROWSERS[profile].includes(input.browserVersion);
}
const DVR_IDENTITIES=Object.freeze(Object.fromEntries(Object.entries(PLAYERS).map(([protocol,player])=>[protocol,Object.freeze({player,browsers:BROWSERS.dvr})])));
module.exports={reviewedIdentity,DVR_IDENTITIES};
