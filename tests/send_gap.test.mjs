// tests/send_gap.test.mjs — المهمة 5: حد أدنى لفجوة الوسائط (≥1200ms رغم MEDIA_GAP_MS=0) + نوع خطأ SendStopped عند الحظر
// بدون شبكة: api وهمي فقط. env يُضبط قبل الاستيراد الديناميكي.
import assert from"node:assert";import fs from"node:fs";import os from"node:os";import path from"node:path";
process.env.MEDIA_GAP_MS="0";process.env.BANS_FILE="/tmp/nonexistent_bans.json";// غير مؤذن
const unhandled=[];process.on("unhandledRejection",e=>unhandled.push(String(e?.message??e)));
const{mediaSend,mediaSendFile,isSendStopped}=await import("../src/utils/send.js");
const{sendImageBatches}=await import("../src/utils/mangaDelivery.js");
let failed=0;
const run=async(name,fn)=>{try{await fn();console.log(`PASS: ${name}`)}catch(e){failed++;console.error(`✖ FAIL ${name}: ${e?.message??e}`)}};

await run("1) فجوة الوسائط ≥1200ms لنفس threadID رغم MEDIA_GAP_MS=0",async()=>{
  const sendTimes=[];let n=0;
  const api={__rawApi:{sendMessage:(body,tid,cb)=>{sendTimes.push(Date.now());setTimeout(()=>cb(null,{messageID:"m"+n++}),5)}}};
  await mediaSend(api,{body:"x"},"t_gap_floor");
  await mediaSend(api,{body:"y"},"t_gap_floor");
  assert.strictEqual(sendTimes.length,2,`المتوقع إرسالان، حصل ${sendTimes.length}`);
  const gap=sendTimes[1]-sendTimes[0];
  assert.ok(gap>=1150,`الفجوة ${gap}ms أقل من 1150ms (حد 1200ms مع سماحية دقة المؤقت)`);
});

await run("2) 429 وسط قائمة صور → sendImageBatches يرمي SendStopped فوراً دون محاولة ما بعده",async()=>{
  const files=[];for(let i=0;i<6;i++){const f=path.join(os.tmpdir(),`sg_img_${process.pid}_${i}.jpg`);fs.writeFileSync(f,`img${i}`);files.push(f)}
  let calls=0,n=0;
  const api={__rawApi:{sendMessage:(body,tid,cb)=>{calls++;if(calls===3)return setTimeout(()=>cb(new Error("429 rate limit exceeded")),5);setTimeout(()=>cb(null,{messageID:"m"+n++}),5)}}};
  let thrown=null;
  try{await sendImageBatches({files,batchSize:2,threadID:"t_rl_stop",send:(payload,tid,cb,mid)=>mediaSend(api,payload,tid,cb,mid).then(v=>cb(null,v),e=>cb(e)),buildBody:()=>""})}catch(e){thrown=e}
  assert.ok(thrown,"لم يرمِ sendImageBatches أي خطأ رغم 429");
  assert.ok(isSendStopped(thrown),`الخطأ المرمي ليس SendStopped: ${thrown?.name}/${thrown?.code}/${thrown?.message}`);
  assert.strictEqual(calls,3,`المتوقع 3 استدعاءات raw بالضبط (التوقف عند 429، الدفعات التالية غير محاولة)، حصل ${calls}`);
  for(const f of files)fs.rmSync(f,{force:true});
});

await run("3) mediaSendFile لا يعيد المحاولة عند SendStopped",async()=>{
  const f=path.join(os.tmpdir(),`sg_file_${process.pid}.jpg`);fs.writeFileSync(f,"data");
  let calls=0;
  const api={__rawApi:{sendMessage:(body,tid,cb)=>{calls++;setTimeout(()=>cb(new Error("429 too many requests")),5)}}};
  await assert.rejects(mediaSendFile(api,f,"t_file_stop"),e=>isSendStopped(e),"الرفض ليس SendStopped");
  assert.strictEqual(calls,1,`المتوقع استدعاء raw واحد بدون إعادة محاولة، حصل ${calls}`);
  fs.rmSync(f,{force:true});
});

assert.strictEqual(unhandled.length,0,`رفضات وعود غير معالجة: ${unhandled.join(" | ")}`);
if(failed)process.exit(1);
console.log("ALL PASS: send_gap — حد الفجوة 1200ms + SendStopped يوقف الدفعات + لا إعادة محاولة للوسائط المحظورة");
