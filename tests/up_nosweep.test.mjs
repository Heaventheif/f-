// tests/up_nosweep.test.mjs — task 8: أمر up يجب ألا يمسح جلسات gptx (ai_sessions_gptx)
// إثبات بدون تشغيل إطار الأوامر: تجهيز مجلد جلسات وهمي + تأكيدات على مصدر up.js
import{readFile,mkdir,writeFile,rm,stat}from"node:fs/promises";import path from"path";import os from"os";import{fileURLToPath}from"node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const src=await readFile(path.join(root,"src","cmds","up.js"),"utf8");
const cacheRoot=path.join(os.tmpdir(),`up_test_cache_${process.pid}`);
const gptxDir=path.join(cacheRoot,"ai_sessions_gptx");
await rm(cacheRoot,{recursive:true,force:true});await mkdir(gptxDir,{recursive:true});
const dummy=["session_a.json","session_b.json"];
for(const f of dummy)await writeFile(path.join(gptxDir,f),JSON.stringify({dummy:true,file:f}));
const failures=[];const check=(cond,msg)=>{if(!cond)failures.push(msg)};
check(!src.includes("clearDir"),'فشل: المصدر ما زال يحتوي clearDir');
check(!src.includes("clearDir(path.join(CACHE_ROOT,dir)"),'فشل: حلقة الحذف ما زالت موجودة');
check(!src.includes("totalDeleted")&&!src.includes("totalFreed"),'فشل: عدادات الحذف ما زالت موجودة');
check(src.includes("dirStats(path.join(CACHE_ROOT,dir))"),'فشل: حلقة الإحصاء dirStats(path.join(CACHE_ROOT,dir)) غير موجودة');
const occurrences=src.split("ai_sessions_gptx").length-1;
check(occurrences===1,`فشل: ai_sessions_gptx تكررت ${occurrences} مرة (المتوقع 1 — في AI_DIRS فقط)`);
check(!src.includes("تنظيف الكاش"),'فشل: سطر "تنظيف الكاش" القديم ما زال موجودًا');
check(src.includes("🗂️ جلسات الذكاء الاصطناعي:")&&src.includes("لا تنظيف تلقائي من هذا الأمر (الحفاظ على جلسات الحوار)"),'فشل: سطور التقرير الجديدة غير موجودة');
check(src.includes('description:"قياس استهلاك النظام الفعلي"')&&!src.includes("وتنظيف كاش الذكاء الاصطناعي"),'فشل: الوصف لم يُحدَّث');
let intact=true;try{for(const f of dummy)await stat(path.join(gptxDir,f))}catch{intact=false}
check(intact,'فشل: الملفات الوهمية اختفت من مجلد الجلسات');
await rm(cacheRoot,{recursive:true,force:true});
if(failures.length){console.error(failures.map(f=>"✖ "+f).join("\n"));process.exit(1)}
console.log(`PASS: up لا يمسح جلسات الذكاء الاصطناعي — لا clearDir، الإحصاء فقط (${occurrences}× ai_sessions_gptx)، ${dummy.length} ملفات وهمية بقيت في ${gptxDir}`);
