import assert from"node:assert/strict";import{setTimeout as sleep}from"node:timers/promises";import{_slotControl}from"../src/events/onMessage.js";
const{runLight,runHeavy,getStats}=_slotControl;let _passed=0;function ok(name){_passed++;console.log(`PASS: ${name}`)}
async function main(){
 // a) heavy exclusivity: slot واحد فقط — البقية تُرفض فوراً بدون طابور
 const first=runHeavy(()=>new Promise(r=>setTimeout(r,300)));
 assert.equal(getStats().heavyBusy,true,"a: heavyBusy=true right after #1 starts");
 const tA=Date.now();const rejects=[];
 const others=[...Array(4)].map(()=>runHeavy(()=>new Promise(r=>setTimeout(r,300))));
 for(const p of others)p.catch(e=>rejects.push({code:e?.code,at:Date.now()-tA}));
 const settledA=await Promise.allSettled([first,...others]);
 assert.equal(settledA[0].status,"fulfilled","a: #1 got the slot");
 assert.equal(rejects.length,4,"a: #2-#5 all rejected");
 for(const r of rejects){assert.equal(r.code,"HEAVY_BUSY","a: code=HEAVY_BUSY");assert.ok(r.at<100,`a: rejected immediately (${r.at}ms <100ms)`)}
 assert.equal(getStats().heavyBusy,false,"a: heavy slot freed after settle");
 ok(`a) heavy exclusivity — #1 فقط حصل على الخانة، #2-#5 → HEAVY_BUSY فوراً (avg ${Math.round(rejects.reduce((s,r)=>s+r.at,0)/4)}ms)`);
 // b) light unaffected أثناء انشغال الثقيلة
 const heavies=[runHeavy(()=>new Promise(r=>setTimeout(r,300))),runHeavy(()=>new Promise(r=>setTimeout(r,300)))];heavies.forEach(p=>p.catch(()=>{}));
 const tB=Date.now();const lightRes=await runLight(async()=>{await new Promise(r=>setTimeout(r,50));return"help-ok"});
 const lightDur=Date.now()-tB;
 assert.equal(lightRes,"help-ok","b: light returned help-ok");assert.ok(lightDur<3000,`b: light ran fast (${lightDur}ms <3000ms)`);
 await Promise.allSettled(heavies);
 ok(`b) light غير متأثرة أثناء الثقيلة — "help-ok" خلال ${lightDur}ms`);
 // c) انتهاء مهلة الـ light يحرّر الخانة + الإشارة تُلغى
 let sig=null;const hung=runLight(s=>{sig=s;return new Promise(()=>{})},{timeoutMs:60});hung.catch(()=>{});
 await sleep(150);
 assert.equal(getStats().lightActive,0,"c: lightActive=0 after timeout");
 assert.ok(sig&&sig.aborted===true,"c: signal aborted");
 ok("c) مهلة الـ light حُرّرت الخانة (active→0) والإشارة aborted");
 // d) حد تزامن الـ light = 4 + طابور FIFO
 const four=[...Array(4)].map(()=>runLight(()=>new Promise(r=>setTimeout(r,100))));
 assert.equal(getStats().lightActive,4,"d: lightActive=4");
 const fifth=runLight(()=>new Promise(r=>setTimeout(r,100)));
 assert.ok(getStats().lightQueued>=1,"d: 5th queued");
 await Promise.all([...four,fifth]);
 await sleep(10);
 assert.equal(getStats().lightActive,0,"d: active drained");assert.equal(getStats().lightQueued,0,"d: queue empty");
 ok("d) حد الـ light=4، الخامس طُابِر ثم صُرّف بالكامل");
 // e) تحرير idempotent — لا إنقاص مزدوج
 const late=runLight(signal=>new Promise(r=>{setTimeout(()=>r("late"),100)}),{timeoutMs:60});late.catch(()=>{});
 await sleep(180);
 assert.equal(getStats().lightActive,0,"e: no double-decrement (exactly 0)");
 const after=await runLight(async()=>"ok-after");
 assert.equal(after,"ok-after","e: system healthy after timeout+settle");
 await sleep(10);assert.equal(getStats().lightActive,0,"e: clean after follow-up");
 ok("e) تحرير idempotent — الإحصاءات ثابتة على 0 بعد مهلة+اكتمال");
}
main().then(()=>{console.log(`\n✅ ALL ${_passed} CONCURRENCY GROUPS PASSED`);process.exit(0)},e=>{console.error("FAIL:",e?.message??e);console.error(e?.stack??e);process.exit(1)});
