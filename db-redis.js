// /src/db-redis.js
// Redis simulator module (command map, tokenization, sorted sets, sets, hashes, pub/sub)
let ctx;
export function init(context){ ctx = context; setupPubSub(); }

function tokenise(s){
  const out=[]; let cur=''; let q=null;
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(q){
      if(c==='\\' && i+1<s.length){ cur+=s[i+1]; i++; continue; }
      if(c===q){ q=null; continue; }
      cur+=c;
    } else {
      if(c==='"' || c==="'"){ q=c; if(cur) { out.push(cur); cur=''; } }
      else if(/\s/.test(c)){ if(cur){ out.push(cur); cur=''; } }
      else cur+=c;
    }
  }
  if(q) throw new Error('Unterminated quoted string');
  if(cur) out.push(cur);
  return out;
}

// Helpers for Redis data
function rType(key){
  const d=ctx.getBucket().data;
  if(key in d.strings) return 'string';
  if(key in d.lists) return 'list';
  if(key in d.sets) return 'set';
  if(key in d.hashes) return 'hash';
  if(key in d.zsets) return 'zset';
  return null;
}
function rExists(key){ return rType(key)!==null; }
function rDelKey(key){
  let removed = 0; const d=ctx.getBucket().data;
  ['strings','lists','sets','hashes','zsets'].forEach(k=>{ if(d[k][key]!==undefined){ delete d[k][key]; removed=1; }});
  if(d.ttl && d.ttl[key]!==undefined) delete d.ttl[key];
  return removed;
}
function rRename(oldKey,newKey){
  const d=ctx.getBucket().data;
  if(!rExists(oldKey)) return false;
  rDelKey(newKey);
  if(d.strings[oldKey]!==undefined){ d.strings[newKey]=d.strings[oldKey]; delete d.strings[oldKey]; }
  if(d.lists[oldKey]!==undefined){ d.lists[newKey]=d.lists[oldKey]; delete d.lists[oldKey]; }
  if(d.sets[oldKey]!==undefined){ d.sets[newKey]=d.sets[oldKey]; delete d.sets[oldKey]; }
  if(d.hashes[oldKey]!==undefined){ d.hashes[newKey]=d.hashes[oldKey]; delete d.hashes[oldKey]; }
  if(d.zsets[oldKey]!==undefined){ d.zsets[newKey]=d.zsets[oldKey]; delete d.zsets[oldKey]; }
  if(d.ttl && d.ttl[oldKey]!==undefined){ d.ttl[newKey]=d.ttl[oldKey]; delete d.ttl[oldKey]; }
  return true;
}
function rAllKeys(){
  const d=ctx.getBucket().data;
  return Array.from(new Set([
    ...Object.keys(d.strings||{}),...Object.keys(d.lists||{}),...Object.keys(d.sets||{}),
    ...Object.keys(d.hashes||{}),...Object.keys(d.zsets||{})
  ])).sort();
}

/** PUB/SUB *********************************************************************/
let bc; // BroadcastChannel
const localSubs = new Set();
function setupPubSub(){
  try{ bc = new BroadcastChannel('mdb-playground-redis'); bc.onmessage = onPubSubMessage; }catch{ bc = null; }
  window.addEventListener('storage', (e)=>{
    if(e.key==='dbPlayground:redis:pubsub' && e.newValue){
      try{ const msg=JSON.parse(e.newValue); onPubSubMessage({ data: msg }); }catch{}
    }
  });
}
function onPubSubMessage(ev){
  const data = ev.data||{};
  if(data.type!=='redis_pubsub') return;
  if(localSubs.has(data.channel)){
    ctx.print('', `message ${data.channel} "${data.payload}"`);
    ctx.recordOp('redis');
  }
}
function publish(channel, payload){
  const msg = { type:'redis_pubsub', channel, payload, ts: Date.now() };
  if(bc){ try{ bc.postMessage(msg); }catch{} }
  try{ localStorage.setItem('dbPlayground:redis:pubsub', JSON.stringify(msg)); }catch{}
}

/** HELP ***********************************************************************/
const redisHelpList = [
  'SET key value','GET key','DEL key [key ...]','EXISTS key [key ...]','TYPE key','PERSIST key','EXPIRE key seconds','TTL key','RENAME oldkey newkey',
  'HSET key field value [field value ...]','HGET key field','HGETALL key','HDEL key field [field ...]',
  'LPUSH key value [value ...]','RPUSH key value [value ...]','LRANGE key start stop',
  'SADD key member [member ...]','SREM key member [member ...]','SISMEMBER key member','SINTER key [key ...]','SUNION key [key ...]','SDIFF key [key ...]','SCARD key','SMEMBERS key',
  'ZADD key score member [score member ...]','ZRANGE key start stop [WITHSCORES]','ZRANGEBYSCORE key min max [WITHSCORES]','ZREM key member [member ...]','ZCARD key',
  'SCAN cursor [MATCH p]','SUBSCRIBE channel','UNSUBSCRIBE channel','PUBLISH channel message'
];
export function help(name){
  if(!name) return ['Redis — Supported:', ...redisHelpList];
  const u = redisHelpList.find(x=> x.toUpperCase().startsWith(name.trim().toUpperCase()));
  return u? ['Usage: '+u] : ['Unknown command for HELP'];
}

/** Command execution ***********************************************************/
const REDIS_WRITES = new Set(['SET','DEL','LPUSH','RPUSH','HSET','HDEL','SADD','SREM','ZADD','ZREM','EXPIRE','PERSIST','RENAME']);
export function execute(line){
  const d = ctx.getBucket().data;
  const argv = tokenise(line);
  const cmdName = (argv[0]||'').toUpperCase();
  const a = argv.slice(1);
  const out=[];
  const print = (text)=> ctx.print('', text);
  const prompt = ()=> ctx.print('prompt', ctx.promptLabel()+line);

  const cmdMap = {
    // Strings
    SET:()=>{ if(a.length<2) throw new Error('SET requires key and value'); const key=a[0]; const val=a.slice(1).join(' '); rDelKey(key); d.strings[key]=val; return 'OK'; },
    GET:()=>{ if(a.length<1) throw new Error('GET requires key'); return d.strings[a[0]]!==undefined? d.strings[a[0]] : '(nil)'; },
    DEL:()=>{ if(!a.length) throw new Error('DEL requires key'); let n=0; a.forEach(k=>{ n+=rDelKey(k); }); return '(integer) '+n; },
    EXISTS:()=>{ let n=0; a.forEach(k=>{ n+= rExists(k)?1:0; }); return '(integer) '+n; },
    TYPE:()=>{ const t=rType(a[0]); return t||'none'; },
    PERSIST:()=>{ const k=a[0]; if(!k) throw new Error('PERSIST requires key'); if(!rExists(k)) return '(integer) 0'; if(d.ttl && d.ttl[k]!==undefined){ delete d.ttl[k]; return '(integer) 1'; } return '(integer) 0'; },
    EXPIRE:()=>{ if(a.length<2) throw new Error('EXPIRE requires key seconds'); const k=a[0]; const sec=parseInt(a[1],10); if(!rExists(k)) return '(integer) 0'; if(!isFinite(sec)) throw new Error('seconds must be a number'); if(sec<=0){ rDelKey(k); return '(integer) 1'; } d.ttl=d.ttl||{}; d.ttl[k]=Date.now()+sec*1000; return '(integer) 1'; },
    TTL:()=>{ const k=a[0]; if(!k) return '(integer) -2'; if(!rExists(k)) return '(integer) -2'; if(!d.ttl || d.ttl[k]===undefined) return '(integer) -1'; const rem=Math.max(0, Math.ceil((d.ttl[k]-Date.now())/1000)); return '(integer) '+rem; },
    RENAME:()=>{ if(a.length<2) throw new Error('RENAME requires oldkey newkey'); if(!rRename(a[0],a[1])) throw new Error('ERR no such key'); return 'OK'; },
    // Hash
    HSET:()=>{ if(a.length<3 || (a.length-1)%2!==0) throw new Error('HSET requires key field value [field value ...]'); const k=a[0]; d.hashes[k]=d.hashes[k]||{}; let added=0; for(let i=1;i<a.length;i+=2){ const f=a[i], v=a[i+1]; if(d.hashes[k][f]===undefined) added++; d.hashes[k][f]=String(v); } return '(integer) '+added; },
    HGET:()=>{ const k=a[0], f=a[1]; const h=d.hashes[k]||{}; return h[f]!==undefined?h[f]:'(nil)'; },
    HGETALL:()=>{ const k=a[0]; const h=d.hashes[k]||{}; const ent=Object.entries(h); if(!ent.length) return '(empty list or set)'; const lines=[]; ent.forEach(([f,v],i)=>{ lines.push(`${i*2+1}) "${f}"`); lines.push(`${i*2+2}) "${v}"`); }); return lines; },
    HDEL:()=>{ if(a.length<2) throw new Error('HDEL requires key and field'); const k=a[0]; const h=d.hashes[k]; if(!h) return '(integer) 0'; let removed=0; a.slice(1).forEach(f=>{ if(h[f]!==undefined){ delete h[f]; removed++; } }); if(Object.keys(h).length===0){ delete d.hashes[k]; if(d.ttl) delete d.ttl[k]; } return '(integer) '+removed; },
    // List
    LPUSH:()=>{ if(a.length<2) throw new Error('LPUSH requires key and value'); const k=a[0]; d.lists[k]=d.lists[k]||[]; a.slice(1).forEach(v=>d.lists[k].unshift(v)); return '(integer) '+(d.lists[k].length); },
    RPUSH:()=>{ if(a.length<2) throw new Error('RPUSH requires key and value'); const k=a[0]; d.lists[k]=d.lists[k]||[]; a.slice(1).forEach(v=>d.lists[k].push(v)); return '(integer) '+(d.lists[k].length); },
    LRANGE:()=>{ if(a.length<3) throw new Error('LRANGE requires key start stop'); const k=a[0], s=parseInt(a[1],10), e=parseInt(a[2],10); const L=d.lists[k]||[]; let st = s<0?Math.max(L.length+s,0):s; let en=e<0?L.length+e:e; en=Math.min(en,L.length-1); if(en<st || !L.length) return '(empty list or set)'; return L.slice(st,en+1).map((v,i)=>`${i+1}) "${v}"`); },
    // Sets
    SADD:()=>{ if(a.length<2) throw new Error('SADD requires key and member'); const k=a[0]; const set=new Set(d.sets[k]||[]); let added=0; a.slice(1).forEach(m=>{ if(!set.has(m)){ set.add(m); added++; } }); d.sets[k]=Array.from(set); return '(integer) '+added; },
    SMEMBERS:()=>{ const k=a[0]; const arr=Array.from(new Set(d.sets[k]||[])); if(!arr.length) return '(empty list or set)'; return arr.map((m,i)=>`${i+1}) "${m}"`); },
    SREM:()=>{ if(a.length<2) throw new Error('SREM requires key and member'); const k=a[0]; const set=new Set(d.sets[k]||[]); let removed=0; a.slice(1).forEach(m=>{ if(set.delete(m)) removed++; }); d.sets[k]=Array.from(set); if(!d.sets[k].length) delete d.sets[k]; return '(integer) '+removed; },
    SISMEMBER:()=>{ const k=a[0]; const m=a[1]; const set=new Set(d.sets[k]||[]); return '(integer) '+(set.has(m)?1:0); },
    SINTER:()=>{ if(!a.length) throw new Error('SINTER requires at least one key'); const sets=a.map(k=> new Set(d.sets[k]||[])); const inter=sets.length? Array.from(sets[0]).filter(v=>sets.every(s=>s.has(v))) : []; if(!inter.length) return '(empty list or set)'; return inter.map((m,i)=>`${i+1}) "${m}"`); },
    SUNION:()=>{ if(!a.length) throw new Error('SUNION requires at least one key'); const u=new Set(); a.forEach(k=> (d.sets[k]||[]).forEach(v=>u.add(v))); const arr=Array.from(u); if(!arr.length) return '(empty list or set)'; return arr.map((m,i)=>`${i+1}) "${m}"`); },
    SDIFF:()=>{ if(!a.length) throw new Error('SDIFF requires at least one key'); const base=new Set(d.sets[a[0]]||[]); const other=a.slice(1).map(k=> new Set(d.sets[k]||[])); const diff=Array.from(base).filter(v=> !other.some(s=>s.has(v))); if(!diff.length) return '(empty list or set)'; return diff.map((m,i)=>`${i+1}) "${m}"`); },
    SCARD:()=>{ const k=a[0]; return '(integer) '+((d.sets[k]||[]).length||0); },
    // Sorted sets
    ZADD:()=>{ if(a.length<3) throw new Error('ZADD requires key score member [score member ...]'); const k=a[0]; const rest=a.slice(1); if(rest.length%2!==0) throw new Error('ZADD requires score member pairs'); d.zsets[k]=d.zsets[k]||[]; const map=new Map(d.zsets[k].map(it=>[it.member,it])); let added=0; for(let i=0;i<rest.length;i+=2){ const score=parseFloat(rest[i]); if(!isFinite(score)) throw new Error('ZADD requires numeric scores'); const member=rest[i+1]; if(!map.has(member)) added++; map.set(member,{score,member}); } d.zsets[k]=Array.from(map.values()).sort((a,b)=> a.score-b.score || a.member.localeCompare(b.member)); return '(integer) '+added; },
    ZRANGE:()=>{ if(a.length<3) throw new Error('ZRANGE requires key start stop [WITHSCORES]'); const k=a[0], s=parseInt(a[1],10), e=parseInt(a[2],10); const withS=(a[3]||'').toUpperCase()==='WITHSCORES'; const z=d.zsets[k]||[]; let st=s<0?Math.max(z.length+s,0):s; let en=e<0?z.length+e:e; en=Math.min(en,z.length-1); if(en<st||!z.length) return '(empty list or set)'; const slice=z.slice(st,en+1); const lines=[]; slice.forEach((it,i)=>{ lines.push(`${i+1}) "${it.member}"`); if(withS) lines.push(`   "${it.score}"`); }); return lines; },
    ZRANGEBYSCORE:()=>{ if(a.length<3) throw new Error('ZRANGEBYSCORE requires key min max [WITHSCORES]'); const k=a[0]; const minArg=a[1], maxArg=a[2]; const withS=(a[3]||'').toUpperCase()==='WITHSCORES'; const parseB=v=> (v==='-inf' ? -Infinity : (v==='+inf'||v==='inf')? Infinity : parseFloat(v)); const min=parseB(minArg), max=parseB(maxArg); if(!isFinite(min)&&min!==-Infinity) throw new Error('min must be numeric'); if(!isFinite(max)&&max!==Infinity) throw new Error('max must be numeric'); const z=d.zsets[k]||[]; const filtered=z.filter(it=> it.score>=min && it.score<=max); const lines=[]; filtered.forEach((it,i)=>{ lines.push(`${i+1}) "${it.member}"`); if(withS) lines.push(`   "${it.score}"`); }); return lines.length?lines:'(empty list or set)'; },
    ZREM:()=>{ if(a.length<2) throw new Error('ZREM requires key and member'); const k=a[0]; const members=new Set(a.slice(1)); const z=d.zsets[k]||[]; let removed=0; d.zsets[k]=z.filter(it=>{ if(members.has(it.member)){ removed++; return false; } return true; }); if(!d.zsets[k].length) delete d.zsets[k]; return '(integer) '+removed; },
    ZCARD:()=>{ const k=a[0]; const z=d.zsets[k]||[]; return '(integer) '+z.length; },
    // SCAN
    SCAN:()=>{ if(a.length<1) throw new Error('SCAN requires cursor'); let cur=parseInt(a[0],10); if(!isFinite(cur)||cur<0) cur=0; let pattern='*'; if(a[1] && a[1].toUpperCase()==='MATCH') pattern = a[2]||'*'; const regex = new RegExp('^'+pattern.replace(/[.+^${}()|[\\]\\\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$'); const keys = rAllKeys().filter(k=>regex.test(k)); const slice = keys.slice(cur, cur+10); const next = (cur+slice.length)>=keys.length ? 0 : (cur+slice.length); const lines=['1) "'+String(next)+'"']; if(!slice.length){ lines.push('2) (empty list or set)'); } else { lines.push('2)'); slice.forEach((k,i)=> lines.push('   '+(i+1)+') "'+k+'"')); } return lines; },
    // Pub/Sub
    SUBSCRIBE:()=>{ const ch=a[0]; if(!ch) throw new Error('SUBSCRIBE requires channel'); localSubs.add(ch); return 'Subscribed to '+ch; },
    UNSUBSCRIBE:()=>{ const ch=a[0]; if(!ch) throw new Error('UNSUBSCRIBE requires channel'); localSubs.delete(ch); return 'Unsubscribed from '+ch; },
    PUBLISH:()=>{ const ch=a[0]; const msg=a.slice(1).join(' '); if(!ch || !msg) throw new Error('PUBLISH requires channel and message'); publish(ch, msg); if(ctx.isAOFOn()) ctx.logAOFFor('redis', line); return '(integer) '+(localSubs.has(ch)?1:0); }
  };

  ctx.print('prompt', ctx.promptLabel()+line);
  try{
    if(!cmdMap[cmdName]) throw new Error('Unknown command: '+cmdName);
    const res = cmdMap[cmdName]();
    if(Array.isArray(res)) res.forEach(x=> print(String(x)));
    else if(res!==undefined && res!==null) print(String(res));

    if(REDIS_WRITES.has(cmdName)){
      if(ctx.getRoot().global?.aof) ctx.logAOFFor('redis', line);
      ctx.addSnapshotIfNeeded();
      ctx.saveBucket('redis');
    } else {
      ctx.saveBucket('redis');
    }
  }catch(err){ ctx.print('err','(error) '+err.message); }
  ctx.recordOp('redis');
}
