import http from"../../utils/fetchHttp.js";import{createReadStream}from"node:fs";import{unlink}from"node:fs/promises";import{splitFile,cleanupParts,NEEDS_SPLIT}from"../../utils/mediaSplitter.js";import{downloadToTemp}from"../../utils/mediaStream.js";import{downloadYYMedia}from"../../utils/yyApi.js";import{recentlySet as _recentlySent,hydrateRecentlySent,rememberSent}from"../../utils/recentlySent.js";const TUMBLR_API_KEY=process.env.TUMBLR_API_KEY||"";export function chooseRandomUnseen(items,keyOf,seen=new Set){const valid=(Array.isArray(items)?items:[]).filter(item=>item&&String(keyOf(item)||"").trim());if(!valid.length)return null;const fresh=valid.filter(item=>!seen.has(String(keyOf(item))));const pool=fresh.length?fresh:valid;return pool[Math.floor(Math.random()*pool.length)]}function shuffled(items){const result=[...items];for(let index=result.length-1;index>0;index--){const swap=Math.floor(Math.random()*(index+1));[result[index],result[swap]]=[result[swap],result[index]]}return result}const VIDEO_BLOGS=["videohall","gifak-net","sizvideos","pleatedjeans","tastefullyoffensive","humortrain","videogifs","funnyordie","motionaddicts","catasters","kittens","there-is-always-hope","awesome-picz","thefrogman"];
const TUMBLR_API_BASE=process.env.TUMBLR_API_BASE||"https://api.tumblr.com";
const TUMBLR_PAGE=20;
const POOL_MAX=120;
const POOL_TTL_MS=45*60*1e3;
const DEAD_BLOG_MS=6*60*60*1e3;
const SOFT_BLOCK_MS=5*60*1e3;
const PARALLEL_BLOGS=3;
const TUMBLR_BUDGET_MS=25e3;
const MAX_ATTEMPTS=5;
let httpGet=(url,config)=>http.get(url,config);
export function _setHttpForTests(fn){httpGet=fn}
const _blogPools=new Map;
const _blogBlockedUntil=new Map;
const _badKeys=new Set;
function blogBlocked(blog){return(_blogBlockedUntil.get(blog)||0)>Date.now()}
function blockBlog(blog,ms){_blogBlockedUntil.set(blog,Date.now()+ms)}
export function extractTumblrVideoUrl(post){
const direct=post?.video_url;
if(typeof direct==="string"&&/^https?:\/\//i.test(direct))return direct;
for(const player of post?.player||[]){
const match=String(player?.embed_code||"").match(/<source[^>]+src=["']([^"']+)["']/i);
if(match&&/^https?:\/\//i.test(match[1]))return match[1]}
return null}
async function refreshBlog(blog){
let pool=_blogPools.get(blog);
if(!pool||Date.now()-pool.at>POOL_TTL_MS){pool={at:Date.now(),total:null,items:new Map};_blogPools.set(blog,pool)}
const offset=pool.total?Math.floor(Math.random()*(Math.max(0,pool.total-TUMBLR_PAGE)+1)):0;
try{
const response=await httpGet(`${TUMBLR_API_BASE}/v2/blog/${blog}/posts/video`,{params:{api_key:TUMBLR_API_KEY,limit:TUMBLR_PAGE,offset},timeout:8e3});
const body=response.data?.response;
pool.total=Number(body?.total_posts)||pool.total||TUMBLR_PAGE;
for(const post of body?.posts||[]){
const url=extractTumblrVideoUrl(post);
const key=`tumblr:${post.post_url||post.id_string||url}`;
if(url&&key)pool.items.set(key,{source:"tumblr",videoUrl:url,sentKey:key})}
while(pool.items.size>POOL_MAX)pool.items.delete(pool.items.keys().next().value);
if(!pool.items.size)blockBlog(blog,SOFT_BLOCK_MS)}
catch(e){
const status=Number(e?.response?.status);
blockBlog(blog,[401,403,404,410].includes(status)?DEAD_BLOG_MS:SOFT_BLOCK_MS);
console.warn(`[RANDOM] tumblr ${blog}: ${String(e?.message||e).slice(0,80)}`)}}
function pickFromPools(blogs,excluded,allowSeen){
const candidates=[];
for(const blog of blogs){
const pool=_blogPools.get(blog);
if(!pool)continue;
for(const item of pool.items.values()){
if(excluded.has(item.sentKey)||_badKeys.has(item.sentKey))continue;
if(!allowSeen&&_recentlySent.has(item.sentKey))continue;
candidates.push(item)}}
return candidates.length?candidates[Math.floor(Math.random()*candidates.length)]:null}
async function tryTumblr(excluded=new Set){
if(!TUMBLR_API_KEY)return null;
const blogs=shuffled(VIDEO_BLOGS).filter(b=>!blogBlocked(b));
if(!blogs.length)return null;
let picked=pickFromPools(blogs,excluded,false);
if(picked)return picked;
const deadline=Date.now()+TUMBLR_BUDGET_MS;
for(let i=0;i<blogs.length&&Date.now()<deadline;i+=PARALLEL_BLOGS){
const batch=blogs.slice(i,i+PARALLEL_BLOGS);
await Promise.all(batch.map(refreshBlog));
picked=pickFromPools(batch,excluded,false);
if(picked)return picked}
return pickFromPools(blogs,excluded,true)}
const REDDIT_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";const REDDIT_VIDEO_HOSTS=["youtube.com","youtu.be","v.redd.it","streamable.com"];function isRedditVideoUrl(value){try{const host=new URL(value).hostname.toLowerCase().replace(/^www\./,"");return REDDIT_VIDEO_HOSTS.some(d=>host===d||host.endsWith("."+d))}catch{return false}}async function tryReddit(excluded=new Set){const response=await httpGet("https://www.reddit.com/r/videos/hot.json",{params:{limit:25,raw_json:1},headers:{"User-Agent":REDDIT_UA,Accept:"application/json"},timeout:8e3});const posts=(response.data?.data?.children||[]).map(c=>c?.data).filter(d=>d&&!d.over_18&&!d.stickied&&isRedditVideoUrl(d.url_overridden_by_dest||d.url));const post=chooseRandomUnseen(posts.filter(item=>!excluded.has(`reddit:${item.id}`)&&!_badKeys.has(`reddit:${item.id}`)),item=>`reddit:${item.id}`,_recentlySent);if(!post)return null;const url=post.url_overridden_by_dest||post.url;return{source:"reddit",sourceUrl:url,videoUrl:url,sentKey:`reddit:${post.id}`}}async function pickRandomVideo(excluded=new Set){for(const provider of[tryTumblr,tryReddit]){try{const picked=await provider(excluded);if(picked)return picked}catch(error){console.warn(`[RANDOM] ${provider.name} failed: ${error.message}`)}}return null}
export default{config:{name:"random",aliases:["فيديو"],version:"1.7.0",countDown:15,role:0,category:"وسائط وتحميل",description:"فيديو عشوائي من Tumblr أو Reddit",usage:["{pn}فيديو — فيديو عشوائي من Tumblr أو Reddit"]},onStart:async function({api,event}){
const{threadID,messageID}=event;
hydrateRecentlySent();
const excluded=new Set;
let lastError=null;
for(let attempt=0;attempt<MAX_ATTEMPTS;attempt++){
let tmpFile=null;
let partPaths=[];
try{
const picked=await pickRandomVideo(excluded);
if(!picked)break;
const{videoUrl,sourceUrl,source:mediaSource,sentKey}=picked;
excluded.add(sentKey);
let size;
try{
if(mediaSource==="reddit"){const media=await downloadYYMedia(sourceUrl||videoUrl,{type:"video"});tmpFile=media.filePath;size=media.bytes}
else{const downloaded=await downloadToTemp(videoUrl,"mp4");tmpFile=downloaded.tmpPath;size=downloaded.size}
if(size<10240)throw new Error("الفيديو فارغ.")}
catch(downloadError){
lastError=downloadError;
_badKeys.add(sentKey);
console.warn(`[RANDOM] تخطي ${sentKey}: ${String(downloadError?.message||downloadError).slice(0,80)}`);
continue}
const files=NEEDS_SPLIT(size)?partPaths=await splitFile(tmpFile,"mp4"):[tmpFile];
for(const file of files){await new Promise((resolve,reject)=>global.safeSend(api,{attachment:createReadStream(file)},threadID,err=>err?reject(err):resolve(),messageID))}
rememberSent(sentKey);
return}
catch(error){
console.error("[RANDOM:ERR]",error?.message||error);
return global.safeSend(api,"فشل إرسال الفيديو. "+(String(error?.message||"").substring(0,150)||"خطأ غير معروف."),threadID,null,messageID)}
finally{try{if(tmpFile)await unlink(tmpFile)}catch(_){}if(partPaths.length)await cleanupParts(partPaths)}}
if(lastError)console.error("[RANDOM:ERR]",lastError?.message||lastError);
return global.safeSend(api,"لم أجد فيديو الآن. حاول مرة أخرى لاحقاً.",threadID,null,messageID)}};
