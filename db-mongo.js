// MongoDB simulator module: parser, matcher, projection, updates, aggregate(), index hint
let ctx;
export function init(context){ ctx = context; }

function splitArgs(s){
  const out=[]; let cur=''; let depth=0; let q=null;
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(q){ cur+=c; if(c==='\\'){ if(i+1<s.length){ cur+=s[++i]; } } else if(c===q){ q=null; } continue; }
    if(c==='"'||c==="'"){ q=c; cur+=c; continue; }
    if(c==='{'||c==='['||c==='('){ depth++; cur+=c; continue; }
    if(c==='}'||c===']'||c===')'){ depth--; cur+=c; continue; }
    if(c===',' && depth===0){ out.push(cur.trim()); cur=''; continue; }
    cur+=c;
  }
  if(cur.trim()) out.push(cur.trim());
  return out;
}
function parseJSONish(s){
  if(s===undefined || s===null) return undefined;
  const t = s.trim();
  if(!t.length) return undefined;
  if(t[0]==='{' || t[0]==='['){
    const norm = t.replace(/([{,]\s*)'([^']*)'\s*:/g, '$1"$2":').replace(/:\s*'([^']*)'/g, ':"$1"');
    return JSON.parse(norm);
  }
  if(t[0]==='"' || t[0]==="'"){ const v = t[0]==="'" ? t.replace(/^'/,'"').replace(/'$/,'"') : t; return JSON.parse(v); }
  if(/^[-+]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t);
  if(/^true|false|null$/i.test(t)) return JSON.parse(t.toLowerCase());
  return t; // bare string
}
function parseMongo(line){
  // support chaining .limit(n) for find/aggregate
  let limit = null; let rest = line.trim();
  const limMatch = rest.match(/\.limit\(\s*([0-9]+)\s*\)\s*;?\s*$/);
  if(limMatch){ limit = parseInt(limMatch[1],10); rest = rest.slice(0, limMatch.index); }
  const mUse = rest.match(/^\s*use\s+([A-Za-z0-9_\-]+)\s*;?\s*$/i);
  if(mUse) return { type:'use', db:mUse[1] };
  const p = rest.match(/^\s*db\.([A-Za-z0-9_\-]+)\.([A-Za-z]+)\s*\(([\s\S]*)\)\s*;?\s*$/);
  if(!p) return null;
  return { type:'call', coll:p[1], op:p[2], args: splitArgs(p[3]), limit };
}

// Match & projection
function matchValue(val, cond){
  if(cond && typeof cond==='object' && !Array.isArray(cond)){
    for(const op of Object.keys(cond)){
      const v = cond[op];
      if(op==='$gt'){ if(!(val>v)) return false; }
      else if(op==='$lt'){ if(!(val<v)) return false; }
      else if(op==='$gte'){ if(!(val>=v)) return false; }
      else if(op==='$lte'){ if(!(val<=v)) return false; }
      else if(op==='$ne'){ if(val===v) return false; }
      else if(op==='$in'){ if(!Array.isArray(v) || !v.some(x=> JSON.stringify(x)===JSON.stringify(val))) return false; }
      else if(op==='$nin'){ if(Array.isArray(v) && v.some(x=> JSON.stringify(x)===JSON.stringify(val))) return false; }
      else { if(JSON.stringify(val)!==JSON.stringify(cond)) return false; }
    }
    return true;
  }
  return JSON.stringify(val)===JSON.stringify(cond);
}
function matchDoc(doc, query){
  if(!query || typeof query!=='object') return true;
  if('$or' in query){ const arr=query['$or']||[]; return arr.some(q=>matchDoc(doc,q)); }
  if('$and' in query){ const arr=query['$and']||[]; return arr.every(q=>matchDoc(doc,q)); }
  if('$not' in query){ return !matchDoc(doc, query['$not']); }
  if('$nor' in query){ const arr=query['$nor']||[]; return arr.every(q=>!matchDoc(doc,q)); }
  for(const k of Object.keys(query)){
    if(k.startsWith('$')) continue;
    const cond = query[k];
    const val = doc[k];
    if(!matchValue(val, cond)) return false;
  }
  return true;
}
function projectDoc(doc, proj){
  if(!proj || typeof proj!=='object') return JSON.parse(JSON.stringify(doc));
  const include = Object.entries(proj).filter(([k,v])=> v===1 && k!=='_id').map(([k])=>k);
  const excludeId = ('_id' in proj) && proj._id===0;
  if(include.length===0){ const out=JSON.parse(JSON.stringify(doc)); if(excludeId) delete out._id; return out; }
  const out={}; include.forEach(k=>{ if(doc[k]!==undefined) out[k]=doc[k]; });
  if(!excludeId && ('_id' in doc)) out._id = doc._id;
  return out;
}

// Index hint
function eligibleIndexHint(coll, q){
  if(!q||typeof q!=='object') return null;
  const idx = new Set((coll.indexes||[]).map(i=>i.field));
  const fields = Object.keys(q).filter(k=>!k.startsWith('$'));
  const hit = fields.find(f=> idx.has(f));
  return hit? `(eligible index: ${hit})` : null;
}

// Aggregate helpers
function resolveExpr(doc, expr){
  if(typeof expr==='string' && expr.startsWith('$')){ return doc[expr.slice(1)]; }
  return expr;
}

export function help(){
  return ['MongoDB — Supported:',
    'use <dbname>',
    'db.<coll>.insertOne(doc)',
    'db.<coll>.insertMany([..])',
    'db.<coll>.find(query, projection).limit(n)',
    'db.<coll>.aggregate([{$match:{}},{$group:{_id:"$field"|null, total:{$sum:1}, avg:{$avg:"$f"}, items:{$push:"$f"}}}]).limit(n)',
    'db.<coll>.updateOne(filter, {$set|$inc|$push|$pull|$rename:{...}})',
    'db.<coll>.deleteOne(filter)',
    'db.<coll>.count()',
    'db.<coll>.createIndex({field:1})'
  ];
}

export function execute(line){
  const parsed = parseMongo(line);
  ctx.print('prompt', ctx.promptLabel()+line);
  if(!parsed){ ctx.print('err','(error) Unrecognized Mongo shell command. Try HELP.'); ctx.recordOp('mongo'); return; }
  const d = ctx.getBucket().data;
  const save = ()=>{ ctx.saveBucket('mongo'); };
  try{
    if(parsed.type==='use'){
      d.currentDb = parsed.db; d.databases[d.currentDb]=d.databases[d.currentDb]||{ collections:{} };
      ctx.print('',`switched to db ${d.currentDb}`); save();
    } else {
      d.databases[d.currentDb]=d.databases[d.currentDb]||{ collections:{} };
      const colls=d.databases[d.currentDb].collections;
      colls[parsed.coll] = colls[parsed.coll]||{ docs:[], indexes:[] };
      const coll = colls[parsed.coll];
      const op = parsed.op.toLowerCase();
      const args = parsed.args.map(parseJSONish);

      if(op==='insertone'){
        const doc = args[0]; if(!doc || typeof doc!=='object') throw new Error('insertOne requires a document');
        if(doc._id===undefined) doc._id = (++_idCounter);
        coll.docs.push(doc);
        ctx.print('ok', JSON.stringify({ acknowledged:true, insertedId: doc._id }, null, 2));
        ctx.logAOFFor('mongo', `db.${parsed.coll}.insertOne(${JSON.stringify(doc)})`);
        save();
      }
      else if(op==='insertmany'){
        const arr = args[0]; if(!Array.isArray(arr)) throw new Error('insertMany requires an array');
        arr.forEach(doc=>{ if(doc._id===undefined) doc._id=(++_idCounter); coll.docs.push(doc); });
        ctx.print('ok', JSON.stringify({ acknowledged:true, insertedCount: arr.length }, null, 2));
        ctx.logAOFFor('mongo', `db.${parsed.coll}.insertMany(${JSON.stringify(arr)})`);
        save();
      }
      else if(op==='find'){
        const q = args[0]||{}; const proj = args[1]||null;
        const hint = eligibleIndexHint(coll,q); if(hint) ctx.print('muted', hint);
        let hits = coll.docs.filter(doc=>matchDoc(doc,q)).map(doc=>projectDoc(doc,proj));
        if(parsed.limit!=null){ hits = hits.slice(0, parsed.limit); }
        ctx.print('', JSON.stringify(hits, null, 2));
      }
      else if(op==='aggregate'){
        const pipeline = Array.isArray(args[0])? args[0] : [];
        let docs = coll.docs.slice();
        for(const stage of pipeline){
          if(stage.$match){ docs = docs.filter(doc=>matchDoc(doc, stage.$match)); }
          else if(stage.$group){
            const spec = stage.$group; const idExpr = spec._id; const groups = new Map();
            const ensure = (key)=>{ if(!groups.has(key)) groups.set(key, {}); return groups.get(key); };
            docs.forEach(doc=>{
              const key = idExpr===null ? null : resolveExpr(doc, idExpr);
              const bucket = ensure(JSON.stringify(key));
              for(const [field, agg] of Object.entries(spec)){
                if(field==='_id') continue;
                const op = Object.keys(agg||{})[0]; const param = agg[op];
                if(op==='$sum'){
                  const val = resolveExpr(doc, param);
                  bucket[field] = (bucket[field]||0) + (typeof val==='number'? val : (param===1?1:0));
                } else if(op==='$avg'){
                  const val = resolveExpr(doc, param);
                  bucket[field] = bucket[field]||{__sum:0,__cnt:0};
                  if(typeof val==='number'){ bucket[field].__sum += val; bucket[field].__cnt++; }
                } else if(op==='$push'){
                  const val = resolveExpr(doc, param);
                  bucket[field] = bucket[field]||[]; bucket[field].push(val);
                }
              }
            });
            // finalize
            const out=[]; for(const [k,b] of groups.entries()){
              const obj={ _id: JSON.parse(k) };
              for(const [field,val] of Object.entries(b)){
                if(val && typeof val==='object' && '__sum' in val){ obj[field] = val.__cnt? (val.__sum/val.__cnt) : 0; }
                else obj[field] = val;
              }
              out.push(obj);
            }
            docs = out;
          }
        }
        if(parsed.limit!=null){ docs = docs.slice(0, parsed.limit); }
        ctx.print('', JSON.stringify(docs, null, 2));
      }
      else if(op==='updateone'){
        const filter = args[0]||{}; const upd = args[1]||{};
        const idx = coll.docs.findIndex(doc=>matchDoc(doc,filter));
        if(idx<0){ ctx.print('', JSON.stringify({ acknowledged:true, matchedCount:0, modifiedCount:0 }, null, 2)); }
        else{
          const doc = coll.docs[idx];
          if(upd.$set){ Object.entries(upd.$set||{}).forEach(([k,v])=> doc[k]=v); }
          if(upd.$inc){ Object.entries(upd.$inc||{}).forEach(([k,v])=> { const cur = Number(doc[k]||0); doc[k]=cur+Number(v); }); }
          if(upd.$push){ Object.entries(upd.$push||{}).forEach(([k,v])=> { doc[k]=Array.isArray(doc[k])? doc[k].concat([v]) : [v]; }); }
          if(upd.$pull){ Object.entries(upd.$pull||{}).forEach(([k,v])=> { const arr = Array.isArray(doc[k])? doc[k] : []; doc[k]=arr.filter(x=> JSON.stringify(x)!==JSON.stringify(v)); }); }
          if(upd.$rename){ Object.entries(upd.$rename||{}).forEach(([from,to])=> { if(from in doc){ doc[to]=doc[from]; delete doc[from]; } }); }
          ctx.print('ok', JSON.stringify({ acknowledged:true, matchedCount:1, modifiedCount:1 }, null, 2));
          ctx.logAOFFor('mongo', `db.${parsed.coll}.updateOne(${JSON.stringify(filter)},${JSON.stringify(upd)})`);
          save();
        }
      }
      else if(op==='deleteone'){
        const filter = args[0]||{};
        const idx = coll.docs.findIndex(doc=>matchDoc(doc,filter));
        if(idx<0){ ctx.print('', JSON.stringify({ acknowledged:true, deletedCount:0 }, null, 2)); }
        else{
          coll.docs.splice(idx,1);
          ctx.print('ok', JSON.stringify({ acknowledged:true, deletedCount:1 }, null, 2));
          ctx.logAOFFor('mongo', `db.${parsed.coll}.deleteOne(${JSON.stringify(filter)})`);
          save();
        }
      }
      else if(op==='count'){
        ctx.print('', String(coll.docs.length));
      }
      else if(op==='createindex'){
        const spec = args[0]; const kv = Object.entries(spec||{})[0];
        if(!kv) throw new Error('createIndex requires {field:1}');
        coll.indexes.push({ field: kv[0], order: Number(kv[1])||1 });
        ctx.print('ok', JSON.stringify({ createdCollectionAutomatically:false, numIndexesAfter: coll.indexes.length }, null, 2));
        ctx.logAOFFor('mongo', `db.${parsed.coll}.createIndex(${JSON.stringify(spec)})`);
        save();
      }
      else {
        throw new Error('Unknown operation: '+parsed.op);
      }
    }
  }catch(err){ ctx.print('err','(error) '+err.message); }
  ctx.recordOp('mongo');
}
let _idCounter = 1000;

