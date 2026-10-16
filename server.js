const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.RENDER ? '0.0.0.0' : '127.0.0.1';
const SECRET = process.env.APP_SECRET || 'local-demo-secret-change-before-public-deploy';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const roleCodes = {
  admin: process.env.ADMIN_CODE || 'ADMIN-COURT',
  judge: process.env.JUDGE_CODE || 'JUDGE-COURT',
  jury: process.env.JURY_CODE || 'JURY-COURT',
  student: process.env.STUDENT_CODE || 'STUDENT-COURT'
};
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } }) : null;
const memory = { users: new Map(), cases: new Map(), sessions: new Map() };
const memoryLogs = [];

app.use(express.json({ limit: '32kb' }));
app.set('trust proxy', 1);
app.use(express.static(__dirname));
app.get('/health', (_req,res) => res.json({ ok:true, service:'ktu-excuse-court', liveSessions:memory.sessions.size }));

function token(payload) { const data = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${data}.${crypto.createHmac('sha256', SECRET).update(data).digest('base64url')}`; }
function readToken(value) { try { const [data, sig] = value.split('.'); const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url'); if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; return JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return null; } }
function auth(req, res, next) {
  // The browser keeps this token in sessionStorage, which is isolated per tab.
  // That lets the demo run Student, Judge, and Jury roles side by side.
  const header = req.headers.authorization || '';
  const user = readToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!user) return res.status(401).json({ error: 'Please sign in to enter the tribunal.' });
  req.user = user;
  next();
}
function allow(...roles) { return (req,res,next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'This action belongs to a different court role.' }); }
function clean(text, max = 400) { return String(text || '').replace(/[<>]/g, '').trim().slice(0, max); }
function codeHash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
const codeHashes = Object.fromEntries(Object.entries(roleCodes).map(([role,value])=>[role,codeHash(value)]));
function id(prefix) { return `${prefix}_${crypto.randomBytes(7).toString('hex')}`; }
function code() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function score(c) { const h = value => { let n = 2166136261; for (const ch of String(value)) { n ^= ch.charCodeAt(0); n = Math.imul(n, 16777619); } return n >>> 0; }; const evidence = c.evidence.reduce((n,e) => n + e.rating, 0) / 3; const totalWeight=c.votes.reduce((n,v)=>n+(v.weight||1),0); const guiltyWeight=c.votes.filter(v=>v.vote==='guilty').reduce((n,v)=>n+(v.weight||1),0); const jury = totalWeight ? Math.round(((guiltyWeight / totalWeight) - .5) * 20) : 0; return Math.max(0, Math.min(100, Math.round(c.base + h(c.excuse)%26 + evidence + (c.rebuttal ? h(c.rebuttal+'r')%16 : 8) + jury))); }
function verdict(s) { return s < 35 ? 'NOT GUILTY' : s < 65 ? 'INSUFFICIENT EVIDENCE' : 'GUILTY'; }
async function init() { if (!pool) return; await pool.query(`CREATE TABLE IF NOT EXISTS court_cases (id TEXT PRIMARY KEY, room_code TEXT UNIQUE NOT NULL, data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()); CREATE TABLE IF NOT EXISTS court_users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, joined_at TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW(), login_count INTEGER DEFAULT 1); CREATE TABLE IF NOT EXISTS court_logs (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ DEFAULT NOW(), actor TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL); CREATE TABLE IF NOT EXISTS court_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);`); const saved=await pool.query("SELECT value FROM court_settings WHERE key='role_codes'"); if(saved.rows[0]?.value) Object.assign(codeHashes,saved.rows[0].value); }
async function putCase(c) { if (!pool) { memory.cases.set(c.id, c); return c; } await pool.query('INSERT INTO court_cases (id, room_code, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', [c.id,c.roomCode,c]); return c; }
async function getCase(id) { if (!pool) return memory.cases.get(id); const r = await pool.query('SELECT data FROM court_cases WHERE id=$1',[id]); return r.rows[0]?.data; }
async function allCases() { if (!pool) return [...memory.cases.values()]; const r = await pool.query('SELECT data FROM court_cases ORDER BY created_at DESC'); return r.rows.map(x=>x.data); }
function publicCase(c) { const result = structuredClone(c); result.score = score(result); result.verdict = result.status === 'concluded' ? verdict(result.score) : null; return result; }
function liveAuth(req,res,next){const header=req.headers.authorization||'';const user=readToken(header.startsWith('Bearer ')?header.slice(7):'');if(!user||user.role!=='audience')return res.status(401).json({error:'Join this live tribunal first.'});req.user=user;next();}
function sessionFor(code){return memory.sessions.get(String(code||'').toUpperCase());}
function publicLive(session,caseFile){const c=publicCase(caseFile);return {code:session.code,status:session.status,participantCount:session.participants.size,votingOpen:!!c.votingOpen,case:{...c,evidence:c.evidence.map(e=>e.revealed?e:{id:e.id,revealed:false}),witnesses:c.witnesses.map(w=>w.revealed?w:{revealed:false}),votes:c.status==='concluded'||!c.votingOpen?c.votes.map(v=>({vote:v.vote,weight:v.weight||1,ai:!!v.ai,name:v.ai?v.name:undefined})):[]}};}
async function audit(user, action, detail) { const row={at:new Date().toISOString(),actor:user.name,role:user.role,action,detail}; if(!pool){memoryLogs.unshift(row); memoryLogs.splice(100,Infinity); return;} await pool.query('INSERT INTO court_logs (actor,role,action,detail) VALUES ($1,$2,$3,$4)',[row.actor,row.role,action,detail]); }
async function recordUser(user) { if(!pool){const existing=memory.users.get(user.id); memory.users.set(user.id,{...user,joinedAt:existing?.joinedAt||new Date().toISOString(),lastSeen:new Date().toISOString(),loginCount:(existing?.loginCount||0)+1}); return;} await pool.query('INSERT INTO court_users (id,name,role) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role, last_seen=NOW(), login_count=court_users.login_count+1',[user.id,user.name,user.role]); }
const materialSchema={type:'object',additionalProperties:false,required:['opening','evidence','witnesses'],properties:{opening:{type:'string'},evidence:{type:'array',items:{type:'object',additionalProperties:false,required:['title','description'],properties:{title:{type:'string'},description:{type:'string'}}}},witnesses:{type:'array',items:{type:'object',additionalProperties:false,required:['name','statement'],properties:{name:{type:'string'},statement:{type:'string'}}}}}};
const reviewSchema={type:'object',additionalProperties:false,required:['question','judgeStatement','sentence'],properties:{question:{type:'string'},judgeStatement:{type:'string'},sentence:{type:'string'}}};
const aiJurorSchema={type:'object',additionalProperties:false,required:['vote','rationale'],properties:{vote:{type:'string',enum:['guilty','notguilty']},rationale:{type:'string'}}};
async function aiJSON(schema,prompt){if(!OPENAI_API_KEY)throw new Error('AI is not configured');const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);try{const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:OPENAI_MODEL,input:prompt,text:{format:{type:'json_schema',name:'court_material',strict:true,schema}},max_output_tokens:900})});if(!response.ok)throw new Error(`AI request failed (${response.status})`);const data=await response.json();if(!data.output_text)throw new Error('AI returned no text');return JSON.parse(data.output_text);}finally{clearTimeout(timeout);}}
function safeText(value,max=360){return clean(value,max);}
async function generateMaterials(c){const prompt=`Return only the requested structured JSON for a fictional, absurdist academic courtroom game. The comedy should land in a live college hackathon: imaginative, specific, deadpan, and slightly theatrical—never corporate, generic, cruel, or humiliating. Never claim real records, surveillance, or institutional findings. Avoid insults and personal data. Create material based only on this fictional case: defendant alias ${JSON.stringify(c.defendant)}, charge ${JSON.stringify(c.charge)}, excuse ${JSON.stringify(c.excuse)}. Evidence must be clearly fictional reconstructions. Give evidence funny exhibit titles, such as a router affidavit or a timestamp having a personal grievance.`;try{const out=await aiJSON(materialSchema,prompt);if(out.evidence.length!==3||out.witnesses.length!==2)throw new Error('Invalid AI material count');c.opening=safeText(out.opening);c.evidence.forEach((e,i)=>{e.title=safeText(out.evidence[i].title,90);e.description=safeText(out.evidence[i].description);});c.witnesses.forEach((w,i)=>{w.name=safeText(out.witnesses[i].name,70);w.statement=safeText(out.witnesses[i].statement);});c.aiStatus='LIVE AI';}catch{c.aiStatus='DEMO FALLBACK';}}
async function generateReview(c){const prompt=`Return only the requested structured JSON for a fictional, absurdist academic courtroom game. Make it witty, specific, and suitable for a live college hackathon; avoid bland corporate language, real-world claims, insults, and humiliation. Do not assess real-world truth or claim access to records. Case: charge ${JSON.stringify(c.charge)}; excuse ${JSON.stringify(c.excuse)}; rebuttal ${JSON.stringify(c.rebuttal||'No rebuttal submitted')}; fictional evidence titles ${JSON.stringify(c.evidence.map(e=>e.title))}. Produce one sharply funny cross-examination question, a dramatic short judge statement, and an absurd fictional sentence with a precise ridiculous consequence.`;try{const out=await aiJSON(reviewSchema,prompt);c.question=safeText(out.question,240);c.judgeStatement=safeText(out.judgeStatement,360);c.sentence=safeText(out.sentence,360);c.aiStatus='LIVE AI';}catch{c.aiStatus=c.aiStatus||'DEMO FALLBACK';}}
async function generateAiJurorVote(c){const prompt=`Return only the requested structured JSON for a clearly labelled AI juror in a fictional absurdist academic courtroom game. Make a humorous, fair-minded decision from ONLY these fictional materials. Never claim real-world truth or access to records. Case: charge ${JSON.stringify(c.charge)}; excuse ${JSON.stringify(c.excuse)}; rebuttal ${JSON.stringify(c.rebuttal||'No rebuttal submitted')}; fictional evidence ${JSON.stringify(c.evidence.filter(e=>e.revealed).map(e=>e.title))}; human jury tally ${JSON.stringify(c.votes.filter(v=>!v.ai).map(v=>v.vote))}. Return guilty or notguilty and a one-sentence theatrical rationale.`;try{const out=await aiJSON(aiJurorSchema,prompt);return {vote:out.vote,rationale:safeText(out.rationale,260),source:'LIVE AI'};}catch{const vote=score(c)>=50?'guilty':'notguilty';return {vote,rationale:vote==='guilty'?'The AI Juror finds the excuse suspiciously well rehearsed, like a group presentation nobody attended.':'The AI Juror detects sufficient nonsense to create reasonable doubt.',source:'DEMO FALLBACK'};}}

app.post('/api/login', async (req,res) => {
  const role = clean(req.body.role, 20).toLowerCase(); const name = clean(req.body.name, 40); const accessCode = clean(req.body.accessCode, 80);
  if (!roleCodes[role] || codeHash(accessCode) !== codeHashes[role]) return res.status(401).json({ error:'Incorrect role access code.' });
  if (name.length < 2) return res.status(400).json({ error:'Enter a display name of at least two characters.' });
  // A stable ID makes the one-vote rule survive a browser refresh or re-login.
  const user = { id: `u_${crypto.createHash('sha256').update(`${role}:${name.toLowerCase()}`).digest('hex').slice(0, 18)}`, name, role, issuedAt: Date.now() };
  await recordUser(user); await audit(user,'SIGNED IN','Entered the tribunal.');
  res.json({ user: { name, role }, token: token(user) });
});
app.post('/api/logout', (_req,res) => res.json({ok:true}));
app.get('/api/me', auth, (req,res) => res.json({ user: { name:req.user.name, role:req.user.role } }));
app.get('/api/config', (_req,res) => res.json({ demo: !pool, ai:OPENAI_API_KEY ? 'LIVE AI' : 'DEMO FALLBACK', roles: Object.keys(roleCodes) }));

app.post('/api/cases', auth, allow('student','admin'), async (req,res) => {
  const charge=clean(req.body.charge,120), excuse=clean(req.body.excuse), defendant=clean(req.body.defendant,40) || req.user.name;
  if (!charge || !excuse) return res.status(400).json({error:'Choose a charge and submit an excuse.'});
  const seed = `${charge}|${excuse}|${Date.now()}`; const h=x=>crypto.createHash('sha256').update(seed+x).digest()[0];
  const c={ id:id('case'), roomCode:code(), caseNumber:`KTU-${100000+h('n')*257}-${String(h('x')%99).padStart(2,'0')}`, defendant, charge, excuse, ownerId:req.user.id, status:'filed', createdAt:new Date().toISOString(), base:25+(h('b')%10), evidence:[0,1,2].map(i=>({id:`E-00${i+1}`,title:['The Timestamp Incident','The Router’s Extremely Convenient Alibi','The Final_Final_v7 Archaeological Dig'][i],description:['A fictional timestamp has filed a complaint about being consulted at 11:59 PM.','A fictional router insists it was “meditating” and cannot elaborate.','A fictional paper trail contains enough finals to qualify as a trilogy.'][i],rating:5+h(`e${i}`)%21,revealed:false})), witnesses:[0,1].map(i=>({name:['The suspicious Wi-Fi router','A deadline with trust issues'][i],statement:['“I am fictional, but I noticed the excuse arrived wearing a tiny disguise and a fake moustache.”','“At 11:59 PM, I heard a keyboard make the sound of consequences.”'][i],revealed:false})), rebuttal:'',question:'',votes:[],events:[{at:new Date().toISOString(),who:'CLERK',text:'Case filed. The paperwork has sighed deeply and entered the room.'}] };
  await generateMaterials(c); await putCase(c); await audit(req.user,'CASE FILED',c.caseNumber); res.status(201).json({ case:publicCase(c) });
});
app.get('/api/cases', auth, async (req,res) => { const cases=await allCases(); const visible=req.user.role==='student' ? cases.filter(c=>c.ownerId===req.user.id) : cases; res.json({ cases:visible.map(publicCase) }); });
app.get('/api/cases/:id', auth, async (req,res) => { const c=await getCase(req.params.id); if(!c)return res.status(404).json({error:'Case not found.'}); if(req.user.role==='student'&&c.ownerId!==req.user.id)return res.status(403).json({error:'That case belongs to another student.'}); res.json({case:publicCase(c)}); });
app.post('/api/cases/join', auth, allow('jury','judge','admin'), async (req,res)=>{ const room=clean(req.body.roomCode,12).toUpperCase(); const c=(await allCases()).find(x=>x.roomCode===room); if(!c)return res.status(404).json({error:'Room code not found.'}); res.json({case:publicCase(c)}); });
app.post('/api/cases/:id/action', auth, async (req,res) => {
  const c=await getCase(req.params.id); if(!c)return res.status(404).json({error:'Case not found.'}); const action=clean(req.body.action,30); const event=(who,text)=>c.events.push({at:new Date().toISOString(),who,text});
  if (action==='revealEvidence' && ['judge','admin'].includes(req.user.role)) { const e=c.evidence.find(x=>!x.revealed); if(!e)return res.status(400).json({error:'All evidence is already revealed.'}); e.revealed=true; c.status='evidence'; event('JUDGE',`${e.id} — ${e.title} entered into the fictional record.`); }
  else if (action==='callWitness' && ['judge','admin'].includes(req.user.role)) { const w=c.witnesses.find(x=>!x.revealed); if(!w)return res.status(400).json({error:'All witnesses have spoken.'}); w.revealed=true; c.status='witnesses'; event('JUDGE',`${w.name} has been called to the stand.`); }
  else if (action==='question' && ['judge','admin'].includes(req.user.role)) { if(c.question)return res.status(400).json({error:'The judge has already asked a question.'}); if(OPENAI_API_KEY)await generateReview(c); c.question=c.question||'If this excuse were a project file, why does it have so many versions?'; event('JUDGE',c.question); }
  else if (action==='rebuttal' && ['student','admin'].includes(req.user.role)) { if(req.user.role==='student'&&c.ownerId!==req.user.id)return res.status(403).json({error:'Only the defendant may submit this rebuttal.'}); const r=clean(req.body.rebuttal); if(!r)return res.status(400).json({error:'Enter a rebuttal first.'}); c.rebuttal=r; c.status='rebuttal'; event('DEFENDANT',r); await generateReview(c); }
  else if (action==='vote' && req.user.role==='jury') { const vote=clean(req.body.vote,20); if(!['guilty','notguilty'].includes(vote))return res.status(400).json({error:'Choose a jury vote.'}); if(c.votes.some(v=>v.userId===req.user.id))return res.status(400).json({error:'You have already voted in this case.'}); c.votes.push({userId:req.user.id,name:req.user.name,vote}); c.status='jury'; event('JURY',`${req.user.name} cast a sealed vote.`); }
  else if (action==='aiJuror' && ['judge','admin'].includes(req.user.role)) { if(c.votes.some(v=>v.ai))return res.status(400).json({error:'The AI Juror has already rendered its two-weight opinion.'}); const aiVote=await generateAiJurorVote(c); c.votes.push({userId:'ai_juror',name:'AI Juror // Hon. Byte Bias',vote:aiVote.vote,weight:2,ai:true,rationale:aiVote.rationale,source:aiVote.source}); c.status='jury'; event('AI JUROR',`Two-weight ${aiVote.vote} vote: ${aiVote.rationale}`); }
  else if (action==='openVoting' && ['judge','admin'].includes(req.user.role)) { c.votingOpen=true; c.status='voting'; event('JUDGE','The jury is now deliberating. The legal atmosphere has become unnecessarily intense.'); }
  else if (action==='closeVoting' && ['judge','admin'].includes(req.user.role)) { c.votingOpen=false; c.status='jury'; event('JUDGE','Voting has closed. The ballot box has been given a tiny ceremonial hat.'); }
  else if (action==='conclude' && ['judge','admin'].includes(req.user.role)) { if(!c.votes.length)return res.status(400).json({error:'Wait for at least one jury vote before concluding.'}); c.status='concluded'; const s=score(c); event('COURT',`Verdict entered: ${verdict(s)} (${s}/100).`); }
  else return res.status(403).json({error:'Your current role cannot perform that action.'});
  await putCase(c); await audit(req.user,`CASE: ${action}`,c.caseNumber); res.json({case:publicCase(c)});
});

app.get('/api/admin/overview', auth, allow('admin'), async (_req,res) => {
  const users=pool ? (await pool.query('SELECT id,name,role,joined_at AS "joinedAt",last_seen AS "lastSeen",login_count AS "loginCount" FROM court_users ORDER BY last_seen DESC')).rows : [...memory.users.values()].sort((a,b)=>b.lastSeen.localeCompare(a.lastSeen));
  const logs=pool ? (await pool.query('SELECT at,actor,role,action,detail FROM court_logs ORDER BY id DESC LIMIT 100')).rows : memoryLogs;
  res.json({users,logs,configuredRoles:Object.keys(roleCodes)});
});
app.post('/api/admin/access-codes', auth, allow('admin'), async (req,res) => {
  const role=clean(req.body.role,20).toLowerCase(), newCode=clean(req.body.newCode,80);
  if(!roleCodes[role] || newCode.length<6) return res.status(400).json({error:'Choose a valid role and an access code of at least six characters.'});
  codeHashes[role]=codeHash(newCode);
  if(pool) await pool.query("INSERT INTO court_settings (key,value) VALUES ('role_codes',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify(codeHashes)]);
  await audit(req.user,'ACCESS CODE ROTATED',`Updated the ${role} access code.`);
  res.json({ok:true,message:`${role} access code updated.`});
});

app.post('/api/live/sessions', auth, allow('judge','admin'), async (req,res) => {
  const c=await getCase(clean(req.body.caseId,80)); if(!c)return res.status(404).json({error:'Select a case before opening a live tribunal.'});
  let room; do{room=code();}while(sessionFor(room));
  const session={code:room,hostId:req.user.id,status:'live',caseId:c.id,participants:new Map(),createdAt:new Date().toISOString()};
  memory.sessions.set(room,session); c.liveSessionCode=room; await putCase(c); await audit(req.user,'LIVE SESSION CREATED',`${c.caseNumber} · room ${room}`);
  const origin=`${req.protocol}://${req.get('host')}`; const joinUrl=`${origin}/?join=${room}`;
  res.status(201).json({session:{code:room,status:session.status,joinUrl,participantCount:0},case:publicCase(c)});
});
app.get('/api/live/:code/host', auth, async (req,res) => {const session=sessionFor(req.params.code);if(!session)return res.status(404).json({error:'Live room not found or expired.'});if(session.hostId!==req.user.id&&req.user.role!=='admin')return res.status(403).json({error:'Only the host may control this live room.'});const c=await getCase(session.caseId);res.json({session:{code:session.code,status:session.status,participantCount:session.participants.size,joinUrl:`${req.protocol}://${req.get('host')}/?join=${session.code}`},case:publicCase(c)});});
app.get('/api/live/:code/qr', auth, async (req,res) => {const session=sessionFor(req.params.code);if(!session)return res.status(404).json({error:'Live room not found.'});if(session.hostId!==req.user.id&&req.user.role!=='admin')return res.status(403).json({error:'Only the host may display this QR code.'});const joinUrl=`${req.protocol}://${req.get('host')}/?join=${session.code}`;res.json({joinUrl,qr:await QRCode.toDataURL(joinUrl,{margin:1,width:300,color:{dark:'#1b191c',light:'#f4eadd'}})});});
app.post('/api/live/join', async (req,res) => {const room=clean(req.body.roomCode,12).toUpperCase();const session=sessionFor(room);if(!session||session.status!=='live')return res.status(404).json({error:'That live tribunal is not accepting participants.'});const nickname=clean(req.body.nickname,30)||`Juror ${crypto.randomBytes(2).toString('hex').toUpperCase()}`;const participant={id:id('aud'),name:nickname,role:'audience',sessionCode:room};session.participants.set(participant.id,participant);await audit(participant,'AUDIENCE JOINED',`Joined live room ${room}.`);res.json({token:token(participant),name:nickname,code:room});});
app.get('/api/live/:code/public', liveAuth, async (req,res) => {const session=sessionFor(req.params.code);if(!session||session.status==='ended')return res.status(404).json({error:'This live tribunal has ended.'});if(req.user.sessionCode!==session.code)return res.status(403).json({error:'This juror pass belongs to another room.'});const c=await getCase(session.caseId);res.json({session:publicLive(session,c)});});
app.post('/api/live/:code/vote', liveAuth, async (req,res) => {const session=sessionFor(req.params.code);if(!session||session.status!=='live'||req.user.sessionCode!==session.code)return res.status(404).json({error:'Live tribunal not found.'});const c=await getCase(session.caseId);if(!c.votingOpen)return res.status(400).json({error:'Voting is not open yet. The judge enjoys suspense.'});const vote=clean(req.body.vote,20);if(!['guilty','notguilty'].includes(vote))return res.status(400).json({error:'Choose Guilty or Not Guilty.'});const old=c.votes.find(v=>v.userId===req.user.id);if(old){old.vote=vote;old.name=req.user.name;}else c.votes.push({userId:req.user.id,name:req.user.name,vote,weight:1,audience:true});c.events.push({at:new Date().toISOString(),who:'AUDIENCE JUROR',text:`${req.user.name} submitted a sealed ballot.`});await putCase(c);res.json({ok:true,message:'Your vote has been sealed in a highly unnecessary envelope.'});});
app.post('/api/live/:code/end', auth, allow('judge','admin'), async (req,res)=>{const session=sessionFor(req.params.code);if(!session)return res.status(404).json({error:'Live room not found.'});if(session.hostId!==req.user.id&&req.user.role!=='admin')return res.status(403).json({error:'Only the host may end this room.'});session.status='ended';await audit(req.user,'LIVE SESSION ENDED',session.code);res.json({ok:true});});

async function startServer() {
  await init();
  const server = app.listen(PORT, HOST, () => {
    console.log(`KTU Excuse Court listening on http://${HOST}:${PORT} (${pool ? 'Postgres' : 'temporary in-memory'} data)`);
    console.log('Keep this terminal open while using the live court. Press Ctrl+C to stop it.');
  });
  // Explicitly retain the listener. This also makes unexpected closes visible in the terminal.
  server.ref();
  server.on('error', error => { console.error('Server failed to start:', error); process.exit(1); });
  server.on('close', () => console.error('Court server closed.'));
}

startServer().catch(error=>{console.error(error);process.exit(1);});
