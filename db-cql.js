// /src/db-cql.js
// Cassandra simulator: keyspaces/tables, TTL, SELECT with PK/IN, secondary indexes, LIMIT, ALLOW FILTERING
let ctx;
export function init(context){ ctx = context; }

function cqlTypeCast(type, raw){
  if(type==='int') return parseInt(stripQ(raw),10);
  if(type==='timestamp'){
    const r = stripQ(raw);
    if(/^\d+$/.test(r)) return Number(r);
    return Date.parse(r);
  }
  return stripQ(raw);
}
function stripQ(s){ return (typeof s==='string' && /^'.*'$|^".*"$/.test(s)) ? s.slice(1,-1) : String(s); }
function splitArgs(s){
  const out=[]; let cur=''; let depth=0; let q=null;
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(q){ cur+=c; if(c==='\\'){ if(i+1<s.length){ cur+=s[++i]; } } else if(c===q){ q=null; } continue; }
    if(c==='"'||c==="'"){ q=c; cur+=c; continue; }
    if(c==='('||c==='['){ depth++; cur+=c; continue; }
    if(c===')'||c===']'){ depth--; cur+=c; continue; }
    if(c===',' && depth===0){ out.push(cur.trim()); cur=''; continue; }
    cur+=c;
  }
  if(cur.trim()) out.push(cur.trim());
  return out;
}

export function help(){
  return ['Cassandra — Supported:',
    'CREATE KEYSPACE ks WITH replication = {...};',
    'USE ks;',
    'CREATE TABLE t (col type, ..., PRIMARY KEY (pk));',
    'CREATE INDEX ON t (column);',
    'INSERT INTO t (cols...) VALUES (...) [USING TTL <sec>];',
    'SELECT cols FROM t WHERE pk = ...;',
    'SELECT cols FROM t WHERE pk IN (...);',
    'SELECT * FROM t LIMIT n;',
    '...non-PK requires ALLOW FILTERING unless indexed.',
    'DELETE FROM t WHERE pk = ...;',
    'ALTER TABLE t ADD col type;'
  ];
}

export function execute(line){
  const s = line.trim();
  const print = (t)=> ctx.print('', t);
  ctx.print('prompt', ctx.promptLabel()+line);
  if(!s){ ctx.recordOp('cassandra'); return; }
  const d = ctx.getBucket().data;
  const save = ()=> ctx.saveBucket('cassandra');

  try{
    let m;
    // CREATE KEYSPACE
    if(m = s.match(/^CREATE\s+KEYSPACE\s+([A-Za-z0-9_]+)\s+WITH\s+replication\s*=\s*(\{[\s\S]*\})\s*;?$/i)){
      const ks=m[1]; const repl=m[2]; d.keyspaces[ks]=d.keyspaces[ks]||{ tables:{} }; d.keyspaces[ks].replication = repl;
      print('Keyspace '+ks+' created.'); ctx.logAOFFor('cassandra', `CREATE KEYSPACE ${ks} WITH replication = ${repl}`); save(); ctx.recordOp('cassandra'); return;
    }
    // USE ks
    if(m = s.match(/^USE\s+([A-Za-z0-9_]+)\s*;?$/i)){
      const ks=m[1]; d.keyspaces[ks]=d.keyspaces[ks]||{ tables:{} }; d.currentKs = ks; save(); print('Using keyspace '+ks); ctx.recordOp('cassandra'); return;
    }
    // CREATE TABLE
    if(m = s.match(/^CREATE\s+TABLE\s+([A-Za-z0-9_]+)\s*\(([\s\S]+)\)\s*;?$/i)){
      const t=m[1]; const ks=d.currentKs; d.keyspaces[ks]=d.keyspaces[ks]||{ tables:{} };
      const inner=m[2]; const parts = splitArgs(inner);
      const table = d.keyspaces[ks].tables[t] = { columns:{}, primaryKey:null, rows:{}, ttl:{}, indexes:[] };
      parts.forEach(p=>{
        const pk = p.match(/PRIMARY\s+KEY\s*\(\s*([A-Za-z0-9_]+)\s*\)/i);
        if(pk){ table.primaryKey = pk[1]; }
        else{
          const mm = p.trim().match(/^([A-Za-z0-9_]+)\s+(text|int|timestamp)$/i);
          if(!mm) throw new Error('Bad column definition: '+p);
          table.columns[mm[1]] = mm[2].toLowerCase();
        }
      });
      if(!table.primaryKey) throw new Error('PRIMARY KEY required');
      print('Table '+t+' created.'); ctx.logAOFFor('cassandra', `CREATE TABLE ${t} (...)`); save(); ctx.recordOp('cassandra'); return;
    }
    // CREATE INDEX
    if(m = s.match(/^CREATE\s+INDEX\s+ON\s+([A-Za-z0-9_]+)\s*\(\s*([A-Za-z0-9_]+)\s*\)\s*;?$/i)){
      const t=m[1]; const col=m[2]; const ks=d.currentKs; const table = (d.keyspaces[ks].tables[t] ||= { columns:{}, primaryKey:null, rows:{}, ttl:{}, indexes:[] });
      table.indexes = table.indexes || [];
      if(!table.indexes.includes(col)) table.indexes.push(col);
      print(`Index created on ${t}(${col}).`); ctx.logAOFFor('cassandra', `CREATE INDEX ON ${t} (${col})`); save(); ctx.recordOp('cassandra'); return;
    }
    // INSERT
    if(m = s.match(/^INSERT\s+INTO\s+([A-Za-z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*(USING\s+TTL\s+(\d+))?\s*;?$/i)){
      const t=m[1]; const ks=d.currentKs; const table=(d.keyspaces[ks].tables[t] ||= { columns:{}, primaryKey:null, rows:{}, ttl:{}, indexes:[] });
      const row = {};
      const cols = m[2].split(',').map(x=>x.trim()); const vals = splitArgs(m[3]).map(x=>x.trim());
      cols.forEach((c,i)=> row[c] = cqlTypeCast(table.columns[c]||'text', vals[i]));
      const pk = table.primaryKey; if(pk==null) throw new Error('PRIMARY KEY not set');
      const key = String(row[pk]); table.rows[key] = Object.assign({}, table.rows[key]||{}, row);
      if(m[5]){ const ttlSec=Number(m[5]); table.ttl[key] = Date.now()+ttlSec*1000; }
      print('1 row applied.'); ctx.logAOFFor('cassandra', `INSERT INTO ${t} (...)${m[5]?' USING TTL '+m[5]:''}`); save(); ctx.recordOp('cassandra'); return;
    }
    // DELETE
    if(m = s.match(/^DELETE\s+FROM\s+([A-Za-z0-9_]+)\s+WHERE\s+([A-Za-z0-9_]+)\s*=\s*([^;]+)\s*;?$/i)){
      const t=m[1]; const fld=m[2]; const raw=m[3].trim(); const ks=d.currentKs; const table=d.keyspaces[ks].tables[t];
      if(fld!==table.primaryKey) throw new Error('Only primary-key deletes supported');
      const key = String(cqlTypeCast(table.columns[fld]||'text', raw));
      const existed = !!table.rows[key];
      delete table.rows[key]; if(table.ttl) delete table.ttl[key];
      print(existed?'1 row deleted.':'0 rows deleted.'); ctx.logAOFFor('cassandra', `DELETE FROM ${t} WHERE ${fld}=${raw}`); save(); ctx.recordOp('cassandra'); return;
    }
    // ALTER TABLE ADD
    if(m = s.match(/^ALTER\s+TABLE\s+([A-Za-z0-9_]+)\s+ADD\s+([A-Za-z0-9_]+)\s+(text|int|timestamp)\s*;?$/i)){
      const t=m[1]; const col=m[2]; const type=m[3].toLowerCase(); const ks=d.currentKs; const table=d.keyspaces[ks].tables[t];
      table.columns[col]=type; print('Altered table '+t+'.'); ctx.logAOFFor('cassandra', `ALTER TABLE ${t} ADD ${col} ${type}`); save(); ctx.recordOp('cassandra'); return;
    }

    // SELECT with optional WHERE, IN, ALLOW FILTERING, LIMIT
    // Patterns:
    //   SELECT cols FROM t WHERE fld = val [ALLOW FILTERING] [LIMIT n];
    //   SELECT cols FROM t WHERE fld IN (..)[ALLOW FILTERING] [LIMIT n];
    //   SELECT * FROM t LIMIT n;
    let sel = s.match(/^SELECT\s+(.+)\s+FROM\s+([A-Za-z0-9_]+)(?:\s+WHERE\s+([A-Za-z0-9_]+)\s*(=|IN)\s*(.+?))?(?:\s+ALLOW\s+FILTERING)?(?:\s+LIMIT\s+(\d+))?\s*;?$/i);
    if(sel){
      const colsSel = sel[1].trim(); const tableName = sel[2]; const fld = sel[3]; const op = sel[4]?.toUpperCase(); let rhs = sel[5]; const lim = sel[6] ? parseInt(sel[6],10) : null;
      const ks=d.currentKs; const table=d.keyspaces[ks].tables[tableName]; if(!table) throw new Error('Table not found');
      const isWhere = !!fld;
      let allowFiltering = /\sALLOW\s+FILTERING/i.test(s);
      const results = [];

      function pushRow(r){ results.push(r); }
      function finalize(rows){
        const showCols = colsSel==='*'? Object.keys(table.columns) : colsSel.split(',').map(x=>x.trim());
        if(rows.length===0){ print('(0 rows)'); ctx.recordOp('cassandra'); return; }
        const header = showCols.join(' | '); ctx.print('', header);
        rows.forEach(r => { const vals = showCols.map(c=> r[c]===undefined? 'null' : String(r[c])); ctx.print('', vals.join(' | ')); });
        ctx.print('', `(${rows.length} row${rows.length>1?'s':''})`);
        ctx.recordOp('cassandra');
      }

      if(!isWhere){
        // table scan (preview) allowed with LIMIT
        let rows = Object.values(table.rows);
        if(Number.isFinite(lim)) rows = rows.slice(0, lim);
        finalize(rows); return;
      }

      const pk = table.primaryKey; const isPk = (fld===pk);
      const isIndexed = (table.indexes||[]).includes(fld);

      if(!isPk && !isIndexed && !allowFiltering){
        throw new Error('Non-primary-key queries require ALLOW FILTERING (or an index)');
      }

      let rows = [];
      if(op==='=' ){
        const keyVal = cqlTypeCast(table.columns[fld]||'text', rhs?.trim());
        if(isPk){
          const r = table.rows[String(keyVal)]; if(r) rows=[r];
        }else{
          // full scan or index-assisted (we still scan in-memory)
          rows = Object.values(table.rows).filter(r=> r[fld]===keyVal);
        }
      } else if(op==='IN'){
        const vals = rhs.match(/^\(\s*([\s\S]*?)\s*\)$/) ? splitArgs(RegExp.$1) : [];
        const keys = vals.map(v=> cqlTypeCast(table.columns[fld]||'text', v));
        if(isPk){
          rows = keys.map(k=> table.rows[String(k)]).filter(Boolean);
        } else {
          rows = Object.values(table.rows).filter(r=> keys.includes(r[fld]));
        }
      } else {
        throw new Error('Unsupported SELECT operator');
      }

      if(Number.isFinite(lim)) rows = rows.slice(0, lim);
      finalize(rows); return;
    }

    if(/^HELP\s*;?$/i.test(s)){ /* router handles top-level */ ctx.recordOp('cassandra'); return; }
    if(/^CLEAR\s*;?$/i.test(s)){ /* router handles top-level */ ctx.recordOp('cassandra'); return; }

    throw new Error('Unsupported CQL. Try HELP.');
  }catch(err){ ctx.print('err','(error) '+err.message); ctx.recordOp('cassandra'); }
}
