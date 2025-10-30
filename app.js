// App bootstrap & UI wiring for Multi-DB Playground V3.0
import * as RedisDB from './db-redis.js';
import * as MongoDB from './db-mongo.js';
import * as CqlDB   from './db-cql.js';

/** Utilities ******************************************************************/
const $ = sel => document.querySelector(sel);
const el = (tag, props={}, ...children) => {
  const n = document.createElement(tag);
  Object.entries(props).forEach(([k,v])=>{
    if(k==='class') n.className=v;
    else if(k==='html') n.innerHTML=v;
    else if(k==='text') n.textContent=v;
    else if(k.startsWith('on') && typeof v==='function') n.addEventListener(k.substring(2), v);
    else n.setAttribute(k, v);
  });
  children.forEach(c => n.append(c));
  return n;
};
const nowIso = () => new Date().toISOString();
const deepClone = obj => JSON.parse(JSON.stringify(obj));
const fmtBytes = n => (n/1024).toFixed(2)+' KB';
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
function measureStorageBytes(obj){
  try { return new Blob([JSON.stringify(obj)]).size; } catch { return JSON.stringify(obj||{}).length; }
}
function copyText(t){ navigator.clipboard.writeText(t).catch(()=>{}); }

/** Persistent Store ************************************************************/
const ROOT_KEY = 'dbPlayground:v2';
const BUCKET = {
  redis: 'dbPlayground:v2:redis',
  mongo: 'dbPlayground:v2:mongo',
  cassandra: 'dbPlayground:v2:cassandra'
};
function ensureRoot(){
  const existing = localStorage.getItem(ROOT_KEY);
  if(existing) return JSON.parse(existing);
  const root = { formatVersion:2, createdAt: nowIso(), updatedAt: nowIso(), global:{ aof:false, rdb:{enabled:false, threshold:10} } };
  localStorage.setItem(ROOT_KEY, JSON.stringify(root));
  return root;
}
function ensureBucket(key, init){
  const existing = localStorage.getItem(key);
  if(existing) return JSON.parse(existing);
  const bucket = { formatVersion:2, createdAt: nowIso(), updatedAt: nowIso(), data: init||{}, settings:{ aofCap:800, snapCap:8 }, aofLog:[] };
  if(key===BUCKET.redis) bucket.snapshots = [];
  localStorage.setItem(key, JSON.stringify(bucket));
  return bucket;
}
let root = ensureRoot();
// Legacy migration (from Redis-only reference)
(function migrateLegacy(){
  try{
    if(!localStorage.getItem(BUCKET.redis)){
      const legacy = localStorage.getItem('redisPlaygroundStateV2');
      if(legacy){
        const L = JSON.parse(legacy);
        const mapped = {
          strings: L.strings||{}, lists: L.lists||{},
          sets: (L.sets? Object.fromEntries(Object.entries(L.sets).map(([k,arr])=>[k, Array.from(arr)])) : {}),
          hashes: L.hashes||{}, zsets: L.zsets||{}, ttl: L.ttl||{}
        };
        const redisBucketInit = { formatVersion:2, createdAt: nowIso(), updatedAt: nowIso(),
          data: mapped, settings: { aofCap:800, snapCap:8 }, aofLog:[], snapshots:[] };
        localStorage.setItem(BUCKET.redis, JSON.stringify(redisBucketInit));
        root.global.aof = !!L.aofEnabled;
        root.global.rdb = { enabled: !!L.rdbEnabled, threshold: Math.max(1, Number(L.rdbInterval||10)) };
        root.updatedAt = nowIso(); localStorage.setItem(ROOT_KEY, JSON.stringify(root));
      }
    }
  }catch{}
})();
let redisBucket = ensureBucket(BUCKET.redis, { strings:{}, lists:{}, sets:{}, hashes:{}, zsets:{}, ttl:{} });
let mongoBucket = ensureBucket(BUCKET.mongo, { databases:{ default:{ collections:{} } }, currentDb:'default' });
let cassBucket  = ensureBucket(BUCKET.cassandra, { keyspaces:{ system:{ tables:{} } }, currentKs:'system' });

function saveRoot(){ root.updatedAt = nowIso(); localStorage.setItem(ROOT_KEY, JSON.stringify(root)); }
function saveBucket(name){
  const key = BUCKET[name];
  const obj = (name==='redis'? redisBucket : name==='mongo'? mongoBucket : cassBucket);
  obj.updatedAt = nowIso(); localStorage.setItem(key, JSON.stringify(obj));
}
function getActiveBucket(){ return activeDB==='redis'? redisBucket : activeDB==='mongo'? mongoBucket : cassBucket; }

/** Global UI State *************************************************************/
let activeDB = 'redis';
const history = []; let histIndex = 0;
const opsWindow = { redis:[], mongo:[], cassandra:[] }; // timestamps per DB (ms)
let redisWriteCount = 0; // for snapshots
let quotaWarned = false;

/** Terminal ********************************************************************/
const output = $('#output');
function print(type, text){ const line = el('div',{class:'line '+(type||'')}); line.textContent = text; output.append(line); output.scrollTop = output.scrollHeight; while(output.children.length>600) output.removeChild(output.firstChild); }
function promptLabel(){ return (activeDB==='redis'?'redis> ':activeDB==='mongo'?'mongo> ':'cql> '); }
function clearTerminal(){ output.innerHTML = ''; print('muted', promptLabel()+'Ready. Type HELP for supported commands. Type CLEAR to clear terminal.'); }

/** Storage & Metrics ***********************************************************/
const OPS_MS = 10_000;
function recordOp(db){ const arr = opsWindow[db]; const now = Date.now(); arr.push(now); while(arr.length && now - arr[0] > OPS_MS) arr.shift(); if(db===activeDB) updateOpsUI(); }
function updateOpsUI(){ const arr = opsWindow[activeDB]; const span = arr.length ? (arr[arr.length-1] - arr[0]) : 1; const opsPerSec = span>0 ? (arr.length/(span/1000)) : 0; $('#opsMeter').textContent = opsPerSec.toFixed(1); $('#opsBar').style.width = clamp(opsPerSec*10,0,100)+'%'; }
function updateStorageUI(){
  const all = { root, redis: redisBucket, mongo: mongoBucket, cassandra: cassBucket };
  const bytes = measureStorageBytes(all);
  const badge = $('#quotaBadge'); const dot = badge.querySelector('.i');
  $('#storageText').textContent = fmtBytes(bytes);
  if(bytes > 4.5*1024*1024){ dot.className = 'i red'; if(!quotaWarned){ console.warn('[index.html] Storage usage approaching/exceeding quota (~4.5MB) — consider exporting and clearing.'); quotaWarned=true; } }
  else { dot.className = 'i cyan'; }
}

/** AOF / Snapshots (per-DB) ****************************************************/
function setAOF(enabled){ root.global.aof = !!enabled; saveRoot(); $('#aofDot').className = 'i '+(enabled?'blue':''); $('#aofStatus').textContent = enabled?'on':'off'; }
function setRDB(enabled){ root.global.rdb.enabled = !!enabled; saveRoot(); $('#rdbDot').className = 'i '+(enabled?'orange':''); $('#rdbStatus').textContent = enabled?('every '+root.global.rdb.threshold+' writes'):'off'; }
function logAOFFor(db, text){
  if(!root.global.aof) return;
  const bucket = db==='redis'? redisBucket : db==='mongo'? mongoBucket : cassBucket;
  bucket.aofLog.unshift({ t: Date.now(), line: `[${db}] ${text}` });
  const cap = Math.max(50, Number(bucket.settings?.aofCap||800));
  while(bucket.aofLog.length>cap) bucket.aofLog.pop();
  saveBucket(db); if(db===activeDB) renderAOF();
}
function addSnapshotIfNeeded(){
  if(!root.global.rdb?.enabled) return;
  if(++redisWriteCount % (root.global.rdb.threshold||10)===0){
    const cap = Math.max(1, Number(redisBucket.settings?.snapCap||8));
    const snap = { t: Date.now(), data: deepClone(redisBucket.data) };
    redisBucket.snapshots = redisBucket.snapshots || [];
    redisBucket.snapshots.unshift(snap);
    while(redisBucket.snapshots.length>cap) redisBucket.snapshots.pop();
    saveBucket('redis'); if(activeDB==='redis') renderSnapshots();
  }
}
function renderAOF(){
  const cont = $('#aofLog'); cont.innerHTML='';
  const bucket = getActiveBucket();
  (bucket.aofLog||[]).forEach(entry=>{
    const d = new Date(entry.t).toLocaleTimeString();
    cont.append(el('div',{class:'line'}, `[${d}] ${entry.line}`));
  });
}
function renderSnapshots(){
  const cont = $('#snapshots'); cont.innerHTML='';
  if(activeDB!=='redis'){ cont.append(el('div',{class:'mini',text:'N/A for this DB'})); return; }
  (redisBucket.snapshots||[]).forEach(s=>{
    const time = new Date(s.t).toLocaleTimeString();
    cont.append(el('div',{class:'snap'}, `Snapshot ${time} — keys: ${
      Object.keys(s.data.strings||{}).length + Object.keys(s.data.lists||{}).length +
      Object.keys(s.data.sets||{}).length + Object.keys(s.data.hashes||{}).length +
      Object.keys(s.data.zsets||{}).length
    }`));
  });
}

/** Keyboard & a11y *************************************************************/
const cmd = $('#cmd'); const runBtn = $('#run');
cmd.addEventListener('keydown', (e)=>{
  if(e.key==='Enter'){ e.preventDefault(); runCurrent(); }
  else if(e.key==='ArrowUp'){ if(history.length){ e.preventDefault(); histIndex = Math.max(0, histIndex-1); cmd.value = history[histIndex] || ''; } }
  else if(e.key==='ArrowDown'){ if(history.length){ e.preventDefault(); histIndex = Math.min(history.length, histIndex+1); cmd.value = history[histIndex] || ''; if(histIndex===history.length) cmd.value=''; } }
  else if(e.key==='Tab'){ e.preventDefault(); autocomplete(); }
});
document.addEventListener('keydown',(e)=>{
  if(e.key==='Escape'){ cmd.focus(); cmd.select(); }
  if(e.ctrlKey && !e.shiftKey && !e.altKey){
    if(e.key==='1'){ switchDB('redis'); }
    else if(e.key==='2'){ switchDB('mongo'); }
    else if(e.key==='3'){ switchDB('cassandra'); }
  }
});
runBtn.addEventListener('click', runCurrent);
function runCurrent(){
  const text = cmd.value.trim();
  if(!text) return;
  handleInput(text);
  if(history[history.length-1]!==text) history.push(text);
  histIndex = history.length;
  cmd.value = '';
}

/** Suggestions & Placeholder ***************************************************/
const BASE_REDIS_CMDS = [
 'SET','GET','DEL','EXISTS','TYPE','PERSIST','EXPIRE','TTL','HSET','HGET','HGETALL','HDEL',
 'LPUSH','RPUSH','LRANGE','SADD','SMEMBERS','SREM','SISMEMBER','SINTER','SUNION','SDIFF','SCARD',
 'ZADD','ZRANGE','ZRANGEBYSCORE','ZREM','ZCARD','SCAN','RENAME','SUBSCRIBE','UNSUBSCRIBE','PUBLISH'
];
const BASE_MONGO = [
 'use <dbname>',
 'db.<collection>.insertOne({...})',
 'db.<collection>.insertMany([{...},{...}])',
 'db.<collection>.find({},{})',
 'db.<collection>.find({...},{...}).limit(n)',
 'db.<collection>.aggregate([{$match:{}},{$group:{_id:"$f",count:{$sum:1}}}]).limit(n)',
 'db.<collection>.updateOne(filter,{"$set":{...}})',
 'db.<collection>.deleteOne({...})',
 'db.<collection>.count()',
 'db.<collection>.createIndex({"field":1})'
];
const BASE_CQL = [
 'CREATE KEYSPACE ks WITH replication = {...};',
 'USE ks;',
 'CREATE TABLE t (col type, ..., PRIMARY KEY (pk));',
 'CREATE INDEX ON t (column);',
 'INSERT INTO t (cols...) VALUES (...) USING TTL <sec>;',
 'SELECT cols FROM t WHERE pk = ...;',
 'SELECT cols FROM t WHERE pk IN (...);',
 'SELECT * FROM t LIMIT n;',
 'DELETE FROM t WHERE pk = ...;',
 'ALTER TABLE t ADD col type;'
];
function setPromptUI(){ cmd.placeholder = promptLabel(); }
function refreshSuggestions(){
  const dl = $('#suggest'); dl.innerHTML='';
  let list = activeDB==='redis'? BASE_REDIS_CMDS : activeDB==='mongo'? BASE_MONGO : BASE_CQL;
  // Mongo dynamic hints
  if(activeDB==='mongo'){
    const val = cmd.value.trim();
    const m1 = val.match(/^db\.([A-Za-z0-9_\-]*)$/);
    const db = mongoBucket.data; const collNames = Object.keys((db.databases[db.currentDb]||{collections:{}}).collections||{});
    if(m1){
      list = collNames.map(c=>`db.${c}.`);
    } else {
      const m2 = val.match(/^db\.([A-Za-z0-9_\-]+)\.find\(\s*\{\s*([^}]*)$/);
      if(m2){
        const c = m2[1]; const collection = (db.databases[db.currentDb]||{collections:{}}).collections[c];
        if(collection){
          const fields = new Set();
          collection.docs.forEach(d=> Object.keys(d||{}).forEach(k=> fields.add(k)));
          list = Array.from(fields).map(f=>`"${f}": `);
        }
      }
    }
  }
  list.forEach(v=> dl.append(el('option',{value:v})));
}
function autocomplete(){
  const val = cmd.value.trim();
  const list = activeDB==='redis'? BASE_REDIS_CMDS : activeDB==='mongo'? BASE_MONGO : BASE_CQL;
  const first = val.split(/\s+/)[0].toUpperCase();
  const match = list.find(s => s.toUpperCase().startsWith(first));
  if(match){ const rest = val.replace(/^\S*/, '').trim(); cmd.value = match + (rest? ' '+rest : ' '); }
}

/** Tabs ************************************************************************/
document.querySelectorAll('.tab').forEach(t=>{
  t.addEventListener('click', ()=>switchDB(t.dataset.db));
});
function switchDB(db){
  if(activeDB===db) return;
  activeDB = db;
  document.querySelectorAll('.tab').forEach(t=>t.setAttribute('aria-selected', String(t.dataset.db===db)));
  print('muted', promptLabel()+'Switched database.');
  setPromptUI(); refreshSuggestions(); updateOpsUI(); updateLiveCount(); renderVisualizer(); renderAOF(); renderSnapshots();
  // Context-aware controls
  $('#redisControls').style.display = (activeDB==='redis')? 'flex':'none';
  $('#rdbBadge').style.display = (activeDB==='redis')? 'inline-flex':'none';
  $('#snapCapWrap').style.display = (activeDB==='redis')? 'inline-flex':'none';
  const bucket = getActiveBucket();
  $('#aofCapInput').value = bucket.settings?.aofCap ?? 800;
  if(activeDB==='redis') $('#snapCapInput').value = redisBucket.settings?.snapCap ?? 8;
}

/** Router (HELP/CLEAR handled here) ********************************************/
function handleInput(line){
  const trimmed = line.trim();
  if(!trimmed) return;
  const upper = trimmed.split(/\s+/)[0].toUpperCase();
  if(upper==='CLEAR'){ clearTerminal(); recordOp(activeDB); return; }
  if(upper==='HELP'){
    const rest = trimmed.slice(4).trim();
    showHelp(rest);
    recordOp(activeDB);
    return;
  }
  try{
    if(activeDB==='redis') RedisDB.execute(trimmed, redisCTX);
    else if(activeDB==='mongo') MongoDB.execute(trimmed, mongoCTX);
    else CqlDB.execute(trimmed, cqlCTX);
  }catch(err){
    print('err','(error) '+err.message);
  }
}

/** Visualizer ******************************************************************/
function updateLiveCount(){
  let n=0;
  if(activeDB==='redis'){
    const d=redisBucket.data; n = Array.from(new Set([ ...Object.keys(d.strings),...Object.keys(d.lists),...Object.keys(d.sets),...Object.keys(d.hashes),...Object.keys(d.zsets) ])).length;
  } else if(activeDB==='mongo'){
    const m=mongoBucket.data; const db = m.databases[m.currentDb];
    n = Object.values(db.collections).reduce((s,c)=>s+c.docs.length,0);
  } else {
    const c=cassBucket.data; const ks=c.keyspaces[c.currentKs];
    n = Object.values(ks.tables).reduce((s,t)=>s+Object.keys(t.rows).length,0);
  }
  $('#liveCount').textContent = n;
}
function renderVisualizer(){
  const box = $('#viz'); box.innerHTML='';
  if(activeDB==='redis'){
    const d = redisBucket.data;
    const keys = Array.from(new Set([ ...Object.keys(d.strings),...Object.keys(d.lists),...Object.keys(d.sets),...Object.keys(d.hashes),...Object.keys(d.zsets) ])).sort();
    const list = el('div',{class:'list'});
    if(!keys.length){ list.append(el('div',{class:'mini'},'No keys. Try: SET key value')); }
    keys.forEach(k=>{
      const t = (k in d.strings)?'string' : (k in d.lists)?'list' : (k in d.sets)?'set' : (k in d.hashes)?'hash' : (k in d.zsets)?'zset':'?';
      const ttl = d.ttl[k]; const rem = ttl!==undefined? Math.max(0, Math.ceil((ttl-Date.now())/1000)) : null;
      const row = el('div',{class:'line'}, `${k}  [${t}] ${rem===null?'': '  TTL: '+rem+'s'}`);
      row.style.cursor='pointer';
      row.title = 'Click to run a read command';
      row.addEventListener('click', ()=>{
        const map = { string: `GET ${k}`, list: `LRANGE ${k} 0 -1`, set:`SMEMBERS ${k}`, hash:`HGETALL ${k}`, zset:`ZRANGE ${k} 0 -1 WITHSCORES` };
        handleInput(map[t]||`TYPE ${k}`);
      });
      list.append(row);
    });
    // counts table
    const table = el('table',{class:'table'}); table.append(el('caption',{text:'Redis overview'}));
    const head = el('tr',{}, el('th',{text:'Type'}), el('th',{text:'Count'}));
    const tb = el('tbody'); tb.append(
      el('tr',{}, el('td',{text:'strings'}), el('td',{text:String(Object.keys(d.strings).length)})),
      el('tr',{}, el('td',{text:'lists'}), el('td',{text:String(Object.keys(d.lists).length)})),
      el('tr',{}, el('td',{text:'sets'}), el('td',{text:String(Object.keys(d.sets).length)})),
      el('tr',{}, el('td',{text:'hashes'}), el('td',{text:String(Object.keys(d.hashes).length)})),
      el('tr',{}, el('td',{text:'zsets'}), el('td',{text:String(Object.keys(d.zsets).length)}))
    );
    const thead = el('thead'); thead.append(head); table.append(thead,tb);
    box.append(el('div',{class:'mini',text:'Keys & TTLs'}), list, el('div',{style:'height:8px'}), table);
  } else if(activeDB==='mongo'){
    const d = mongoBucket.data; const db = d.databases[d.currentDb] || { collections:{} };
    const title = el('div',{class:'mini'}, `db: ${d.currentDb}`);
    const table = el('table',{class:'table'});
    const thead=el('thead',{}, el('tr',{}, el('th',{text:'Collection'}), el('th',{text:'Count'}), el('th',{text:'Indexes'}), el('th',{text:'Sample (first doc)'})));
    const tb = el('tbody');
    Object.entries(db.collections).forEach(([name,coll])=>{
      const sample= coll.docs[0]? JSON.stringify(coll.docs[0], null, 0) : '';
      const row = el('tr',{}); row.style.cursor='pointer'; row.title='Click to run: db.'+name+'.find({}).limit(5)';
      row.addEventListener('click', ()=> handleInput(`db.${name}.find({},{}).limit(5)`));
      row.append(
        el('td',{text:name}), el('td',{text:String(coll.docs.length)}),
        el('td',{text: (coll.indexes||[]).map(i=>i.field+':'+i.order).join(', ') || '—'}),
        el('td',{text: sample || '—'})
      );
      tb.append(row);
    });
    table.append(thead,tb);
    box.append(title, table);
  } else {
    const d = cassBucket.data; const ks = d.keyspaces[d.currentKs] || { tables:{} };
    const title = el('div',{class:'mini'}, `keyspace: ${d.currentKs}`);
    const table = el('table',{class:'table'});
    const thead=el('thead',{}, el('tr',{}, el('th',{text:'Table'}), el('th',{text:'Columns'}), el('th',{text:'Rows'}), el('th',{text:'Primary Key'})));
    const tb = el('tbody');
    Object.entries(ks.tables).forEach(([name,t])=>{
      const row = el('tr',{}); row.style.cursor='pointer'; row.title='Click to run: SELECT * FROM '+name+' LIMIT 5;';
      row.addEventListener('click', ()=> handleInput(`SELECT * FROM ${name} LIMIT 5;`));
      row.append(
        el('td',{text:name}),
        el('td',{text:Object.entries(t.columns).map(([c,ty])=> c+':'+ty).join(', ')}),
        el('td',{text:String(Object.keys(t.rows).length)}),
        el('td',{text: t.primaryKey || '—'})
      );
      tb.append(row);
    });
    table.append(thead,tb);
    box.append(title, table);
  }
  updateLiveCount();
}

/** TTL Tickers *****************************************************************/
function sweepMongoTTL(){
  const d = mongoBucket.data;
  Object.keys(d.databases).forEach(db=>{
    Object.entries(d.databases[db].collections).forEach(([c,coll])=>{
      const now = Date.now();
      const before = coll.docs.length;
      coll.docs = coll.docs.filter(doc=>{
        if(doc && ('expiresAt' in doc)){
          const v = doc.expiresAt;
          const t = typeof v==='string' ? Date.parse(v) : Number(v);
          if(isFinite(t) && t<=now) return false;
        }
        return true;
      });
      if(coll.docs.length!==before){ saveBucket('mongo'); if(db===d.currentDb) renderVisualizer(); updateLiveCount(); }
    });
  });
}
function sweepCassandraTTL(){
  const d = cassBucket.data; const now = Date.now(); let changed=false;
  Object.values(d.keyspaces).forEach(ks=>{
    Object.values(ks.tables).forEach(t=>{
      Object.entries(t.ttl||{}).forEach(([pk,exp])=>{
        if(exp<=now){ delete t.rows[pk]; delete t.ttl[pk]; changed=true; }
      });
    });
  });
  if(changed){ saveBucket('cassandra'); if(activeDB==='cassandra') renderVisualizer(); updateLiveCount(); }
}
setInterval(()=>{
  // Redis expirations
  const d=redisBucket.data; const now=Date.now(); let changed=false;
  Object.entries(d.ttl||{}).forEach(([k,exp])=>{
    if(exp<=now){
      ['strings','lists','sets','hashes','zsets'].forEach(sect=>{ if(d[sect][k]!==undefined) delete d[sect][k]; });
      delete d.ttl[k]; changed=true; print('', `Key expired: ${k}`);
    }
  });
  if(changed){ saveBucket('redis'); if(activeDB==='redis') renderVisualizer(); updateLiveCount(); }
  sweepMongoTTL(); sweepCassandraTTL();
  updateOpsUI(); updateStorageUI();
}, 1000);

/** HELP (top-level) ************************************************************/
function showHelp(command){
  print('prompt', promptLabel()+'HELP'+(command?' '+command:''));
  if(!command){
    if(activeDB==='redis'){ RedisDB.help().forEach(x=> print('', ' - '+x)); }
    else if(activeDB==='mongo'){ MongoDB.help().forEach(x=> print('', ' - '+x)); }
    else { CqlDB.help().forEach(x=> print('', ' - '+x)); }
    return;
  }
  if(activeDB==='redis'){ const usage = RedisDB.help(command); Array.isArray(usage)? usage.forEach(x=> print('', x)) : print('', String(usage||'Unknown command')); }
  else if(activeDB==='mongo'){ print('', 'See CRUD Guide or Quick Start for examples.'); }
  else { print('', 'See CRUD Guide or Quick Start for examples.'); }
}

/** Import / Export (All & per-DB) **********************************************/
$('#exportAllBtn').addEventListener('click', ()=>{
  const payload = { formatVersion:2, root, redis:redisBucket, mongo:mongoBucket, cassandra:cassBucket };
  const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
  const a = el('a',{href:URL.createObjectURL(blob), download:'dbPlayground-v3-export.json'});
  document.body.append(a); a.click(); a.remove();
});
$('#importAllFile').addEventListener('change', async (e)=>{
  const f=e.target.files[0]; if(!f) return;
  try{
    const text = await f.text(); const obj = JSON.parse(text);
    if(obj.formatVersion!==2) throw new Error('Invalid formatVersion');
    if(!obj.root||!obj.redis||!obj.mongo||!obj.cassandra) throw new Error('Missing sections');
    root = obj.root; redisBucket=obj.redis; mongoBucket=obj.mongo; cassBucket=obj.cassandra;
    saveRoot(); saveBucket('redis'); saveBucket('mongo'); saveBucket('cassandra');
    setAOF(root.global?.aof||false); setRDB(root.global?.rdb?.enabled||false);
    $('#rdbThreshold').value = root.global?.rdb?.threshold || 10;
    clearTerminal(); print('', 'Import successful.');
    renderAOF(); renderSnapshots(); renderVisualizer(); updateStorageUI();
  }catch(err){ print('err','(error) Import failed: '+err.message); }
  finally { e.target.value=''; }
});
$('#exportDbBtn').addEventListener('click', ()=>{
  const name = activeDB; const bucket = getActiveBucket();
  const blob = new Blob([JSON.stringify(bucket,null,2)], {type:'application/json'});
  const a = el('a',{href:URL.createObjectURL(blob), download:`dbPlayground-v3-${name}.json`});
  document.body.append(a); a.click(); a.remove();
});
$('#importDbFile').addEventListener('change', async (e)=>{
  const f=e.target.files[0]; if(!f) return;
  try{
    const text = await f.text(); const obj = JSON.parse(text);
    if(obj.formatVersion!==2) throw new Error('Invalid formatVersion');
    if(!obj.data) throw new Error('Missing "data"');
    const name = activeDB;
    if(name==='redis'){ redisBucket = obj; }
    else if(name==='mongo'){ mongoBucket = obj; }
    else { cassBucket = obj; }
    saveBucket(name);
    clearTerminal(); print('', `Imported into ${name}.`);
    renderAOF(); renderSnapshots(); renderVisualizer(); updateStorageUI();
  }catch(err){ print('err','(error) Import (active DB) failed: '+err.message); }
  finally { e.target.value=''; }
});

/** Data menu + Seed ************************************************************/
function toggleMenu(btn, menuId){ const menu = $(menuId); const wrap = btn.parentElement; wrap.classList.toggle('open'); btn.setAttribute('aria-expanded', wrap.classList.contains('open')?'true':'false'); }
$('#dataMenuBtn').addEventListener('click', ()=>{ toggleMenu($('#dataMenuBtn'), '#dataMenu'); });
document.addEventListener('click',(e)=>{ if(!e.target.closest('.menu')) document.querySelectorAll('.menu').forEach(m=>m.classList.remove('open')); });
$('#dataMenu').addEventListener('click', (e)=>{
  const b = e.target.closest('button'); if(!b) return;
  const seed = b.dataset.seed;
  if(seed==='redis'){
    const d = redisBucket.data; d.lists['list:groceries'] = ['milk','eggs','bread']; saveBucket('redis'); renderVisualizer(); print('', 'Seeded Redis list:groceries.'); logAOFFor('redis','LPUSH list:groceries milk eggs bread');
  } else if(seed==='mongo'){
    const db = mongoBucket.data; const name='school'; db.databases[name]=db.databases[name]||{collections:{}}; db.currentDb = name;
    const coll = db.databases[name].collections; coll.students = coll.students||{ docs:[], indexes:[] };
    if(coll.students.docs.length===0) coll.students.docs.push({ _id:1, name:'Sam', grade:3, expiresAt: 32503680000000 }, { _id:2, name:'Ada', grade:4, skills:['db','js'] });
    saveBucket('mongo'); renderVisualizer(); print('', 'Seeded Mongo school.students.'); logAOFFor('mongo','db.students.insertMany([...])');
  } else if(seed==='cassandra'){
    const d = cassBucket.data; d.keyspaces['demo']=d.keyspaces['demo']||{ tables:{} }; d.currentKs='demo';
    d.keyspaces['demo'].tables['users']=d.keyspaces['demo'].tables['users']||{ columns:{ id:'int', name:'text', created:'timestamp' }, primaryKey:'id', rows:{}, ttl:{}, indexes:[] };
    if(Object.keys(d.keyspaces['demo'].tables['users'].rows).length===0){ d.keyspaces['demo'].tables['users'].rows['1']={id:1,name:'Eve',created:1690000000000}; }
    saveBucket('cassandra'); renderVisualizer(); print('', 'Seeded Cassandra demo.users.'); logAOFFor('cassandra','INSERT INTO users (...)');
  }
  updateLiveCount(); updateStorageUI();
});

/** Tunables *******************************************************************/
$('#aofCapInput').addEventListener('change', (e)=>{
  const n = parseInt(e.target.value,10); const cap = Math.max(50, isFinite(n)? n : 800);
  const bucket = getActiveBucket(); bucket.settings = bucket.settings||{}; bucket.settings.aofCap = cap; saveBucket(activeDB); renderAOF();
});
$('#snapCapInput').addEventListener('change', (e)=>{
  const n = parseInt(e.target.value,10); const cap = Math.max(1, isFinite(n)? n : 8);
  redisBucket.settings = redisBucket.settings||{}; redisBucket.settings.snapCap = cap; saveBucket('redis'); renderSnapshots();
});

/** Top controls ****************************************************************/
$('#aofToggle').addEventListener('click', ()=>{ const v=!root.global.aof; setAOF(v); });
$('#rdbToggle').addEventListener('click', ()=>{ const v=!(root.global.rdb?.enabled); setRDB(v); });
$('#rdbThreshold').addEventListener('change', e=>{
  const n = parseInt(e.target.value,10); root.global.rdb.threshold = isFinite(n)&&n>0?n:10; e.target.value = root.global.rdb.threshold; saveRoot(); setRDB(root.global.rdb.enabled);
});

/** CRUD Guide modal ************************************************************/
$('#openCrudGuide').addEventListener('click', ()=> { $('#crudModal').style.display='flex'; });
$('#crudClose').addEventListener('click', ()=> { $('#crudModal').style.display='none'; });
document.querySelectorAll('.chip').forEach(ch=>{
  ch.addEventListener('click', ()=>{
    document.querySelectorAll('.chip').forEach(c=> c.setAttribute('aria-selected','false'));
    ch.setAttribute('aria-selected','true');
    ['g-redis','g-mongo','g-cassandra'].forEach(id=> $('#'+id).style.display='none');
    $('#'+ch.dataset.tab).style.display='block';
  });
});
$('#copyGuide').addEventListener('click', ()=>{
  const tab = document.querySelector('.chip[aria-selected="true"]').dataset.tab;
  const text = $('#'+tab).textContent;
  copyText(text);
  print('', 'Guide copied. Paste into terminal.');
});

/** Quick Start copy helpers ****************************************************/
document.querySelectorAll('pre.list').forEach(pre=>{
  pre.style.cursor='pointer';
  pre.addEventListener('click', ()=>{
    const text = pre.textContent.replace(/\n\s+\n/g,'\n').trim();
    navigator.clipboard.writeText(text);
    print('', 'Copied block to clipboard. Paste into terminal to run.');
  });
});

/** Hard Reset ******************************************************************/
$('#hardResetBtn').addEventListener('click', ()=>{
  if(confirm('Hard Reset will wipe ALL playground state for Redis, MongoDB, and Cassandra. Continue?')){
    localStorage.removeItem(ROOT_KEY);
    localStorage.removeItem(BUCKET.redis);
    localStorage.removeItem(BUCKET.mongo);
    localStorage.removeItem(BUCKET.cassandra);
    location.reload();
  }
});

/** Context objects for DB modules **********************************************/
const baseCTX = {
  print, promptLabel, logAOFFor, addSnapshotIfNeeded, saveBucket, recordOp,
  getRoot: ()=>root, getBuckets: ()=>({ redisBucket, mongoBucket, cassBucket }),
  getActiveDB: ()=>activeDB,
};
const redisCTX = Object.assign({}, baseCTX, {
  getBucket: ()=>redisBucket,
  setRedisWriteCount: (n)=>{ redisWriteCount = n; },
  getRedisWriteCount: ()=>redisWriteCount,
  isAOFOn: ()=>root.global.aof
});
const mongoCTX = Object.assign({}, baseCTX, {
  getBucket: ()=>mongoBucket
});
const cqlCTX = Object.assign({}, baseCTX, {
  getBucket: ()=>cassBucket
});

/** Module init *****************************************************************/
RedisDB.init(redisCTX);
MongoDB.init(mongoCTX);
CqlDB.init(cqlCTX);

/** Initial UI ******************************************************************/
setAOF(root.global?.aof||false);
setRDB(root.global?.rdb?.enabled||false);
$('#rdbThreshold').value = root.global?.rdb?.threshold || 10;
$('#aofCapInput').value = getActiveBucket().settings?.aofCap ?? 800;
$('#snapCapInput').value = redisBucket.settings?.snapCap ?? 8;
$('#redisControls').style.display = 'flex';
$('#rdbBadge').style.display = 'inline-flex';
$('#snapCapWrap').style.display = 'inline-flex';
renderAOF(); renderSnapshots(); renderVisualizer(); updateStorageUI();
print('muted', promptLabel()+'Tip: Paste commands from Quick Start above.');
setPromptUI(); refreshSuggestions();
cmd.focus();
