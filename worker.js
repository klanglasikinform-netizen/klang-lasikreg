/**
 * API ระบบนัดหมายเลสิก — เก็บข้อมูลใน GitHub repo (Private)
 * Variables: REPO_OWNER, REPO_NAME, BRANCH, ALLOWED_ORIGIN
 * Secrets  : GITHUB_TOKEN, ADMIN_USERS  เช่น {"admin":"Lasik#2025"}
 */
const FILES = { doctors:'data/doctors.json', schedule:'data/schedule.json', appts:'data/appointments.json' };
const EMPTY = { doctors:[], schedule:{}, appts:[] };
const SLOT_DAYS = { in730:[1,2,3,4,5], out1400:[1,2,3,4,5], sat730:[6] };
const SLOT_TEXT = { in730:'ในเวลาราชการ 07.30 น.', out1400:'นอกเวลาราชการ 14.00 น.', sat730:'วันเสาร์ (นอกเวลาราชการ) 07.30 น.' };
const STATUSES = ['pending','contacted','unreachable'];
const TTL = 4000;      // แคชในหน่วยความจำ 4 วินาที ลดการเรียก GitHub
const mem = {};

class HttpError extends Error { constructor(status,msg){ super(msg); this.status=status; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isDate = s => typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s+'T00:00:00Z'));
const wday = s => new Date(s+'T00:00:00Z').getUTCDay();
const str = (v,max) => String(v ?? '').trim().slice(0,max);

function b64enc(s){
  const b = new TextEncoder().encode(s); let bin = '';
  for (let i=0;i<b.length;i+=0x8000) bin += String.fromCharCode(...b.subarray(i,i+0x8000));
  return btoa(bin);
}
function b64dec(s){
  const bin = atob(s.replace(/\s/g,'')); const u = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) u[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(u);
}

/* ---------- อ่าน/เขียนไฟล์ JSON ใน GitHub ---------- */
class GitHubStore {
  constructor(env){
    this.env = env;
    this.base = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}`;
    this.branch = env.BRANCH || 'main';
  }
  h(extra={}){
    return { 'Authorization':`Bearer ${this.env.GITHUB_TOKEN}`, 'Accept':'application/vnd.github+json',
             'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'lasik-booking', ...extra };
  }
  async read(key, fresh=false){
    const c = mem[key];
    if (!fresh && c && Date.now()-c.at < TTL) return c;
    const r = await fetch(`${this.base}/contents/${FILES[key]}?ref=${this.branch}`,
      { headers: this.h(c?.etag ? { 'If-None-Match': c.etag } : {}) });
    if (r.status === 304 && c){ c.at = Date.now(); return c; }        // 304 ไม่นับโควตา GitHub
    if (r.status === 404){ return mem[key] = { sha:null, etag:null, data:structuredClone(EMPTY[key]), at:Date.now() }; }
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
    const meta = await r.json();
    let b64 = meta.content;
    if (!b64 && meta.size > 0){                                       // ไฟล์ใหญ่กว่า 1MB อ่านผ่าน blob
      const br = await fetch(`${this.base}/git/blobs/${meta.sha}`, { headers: this.h() });
      if (!br.ok) throw new Error(`GitHub blob ${br.status}`);
      b64 = (await br.json()).content;
    }
    const text = b64 ? b64dec(b64) : '';
    return mem[key] = { sha:meta.sha, etag:r.headers.get('ETag'),
      data: text.trim() ? JSON.parse(text) : structuredClone(EMPTY[key]), at:Date.now() };
  }
  /* แก้ไขแบบปลอดภัย: ถ้ามีคนเขียนพร้อมกัน (sha ไม่ตรง) จะอ่านใหม่แล้วลองซ้ำ */
  async update(key, fn, message){
    for (let i=0;i<6;i++){
      const cur = await this.read(key, true);
      const data = fn(structuredClone(cur.data));
      const body = { message, branch:this.branch, content:b64enc(JSON.stringify(data, null, 1)) };
      if (cur.sha) body.sha = cur.sha;
      const r = await fetch(`${this.base}/contents/${FILES[key]}`,
        { method:'PUT', headers:this.h({'Content-Type':'application/json'}), body:JSON.stringify(body) });
      if (r.ok){ const j = await r.json(); mem[key] = { sha:j.content.sha, etag:null, data, at:Date.now() }; return data; }
      if (r.status===409 || r.status===422){ await sleep(300*(i+1) + Math.random()*300); continue; }
      throw new Error(`GitHub PUT ${r.status}: ${await r.text()}`);
    }
    throw new HttpError(503, 'ระบบมีผู้ใช้งานพร้อมกันจำนวนมาก กรุณาลองใหม่อีกครั้ง');
  }
}

async function readBody(req, max=20000){
  const t = await req.text();
  if (t.length > max) throw new HttpError(413, 'ข้อมูลมีขนาดใหญ่เกินไป');
  try { return JSON.parse(t || '{}'); } catch { throw new HttpError(400, 'รูปแบบข้อมูลไม่ถูกต้อง'); }
}

async function safeEq(a,b){
  const [x,y] = await Promise.all([a,b].map(s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}
async function getAdmin(req, env){
  const u = req.headers.get('X-Admin-User') || '', p = req.headers.get('X-Admin-Pass') || '';
  let users = {}; try { users = JSON.parse(env.ADMIN_USERS || '{}'); } catch {}
  const exp = users[u];
  return (typeof exp === 'string' && await safeEq(p, exp)) ? u : null;
}

/* ---------- ผู้ป่วยบันทึกนัดหมาย ---------- */
async function createAppointment(b, gh){
  if (b.website) return null;                                         // กันบอท (honeypot)
  const a = {
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), status:'pending',
    name: str(b.name,150), age: Number(b.age), phone: str(b.phone,20),
    eyeR: str(b.eyeR,100), eyeL: str(b.eyeL,100),
    type: b.type, slot: b.slot, date: str(b.date,10), doctorId: b.doctorId ? str(b.doctorId,60) : null
  };
  if (!a.name || !a.eyeR || !a.eyeL) throw new HttpError(400, 'กรุณากรอกข้อมูลให้ครบถ้วน');
  if (!(a.age >= 1 && a.age <= 120)) throw new HttpError(400, 'อายุไม่ถูกต้อง');
  if (!/^[0-9\-\s]{9,12}$/.test(a.phone)) throw new HttpError(400, 'เบอร์โทรศัพท์ไม่ถูกต้อง');
  if (!['exam','combo'].includes(a.type)) throw new HttpError(400, 'ลักษณะความต้องการไม่ถูกต้อง');
  if (a.type === 'combo') a.slot = 'out1400';
  if (!SLOT_DAYS[a.slot]) throw new HttpError(400, 'ช่วงเวลาไม่ถูกต้อง');
  if (!isDate(a.date)) throw new HttpError(400, 'วันที่ไม่ถูกต้อง');

  const todayBkk = new Date(Date.now() + 7*3600e3).toISOString().slice(0,10);
  const [doctors, schedule] = await Promise.all([gh.read('doctors'), gh.read('schedule')]);
  const ids = ((schedule.data[a.date] || {})[a.slot] || []).filter(id => doctors.data.some(d => d.id === id));
  const ok = a.date > todayBkk && SLOT_DAYS[a.slot].includes(wday(a.date)) && (a.doctorId ? ids.includes(a.doctorId) : ids.length > 0);
  if (!ok) throw new HttpError(409, 'ขออภัย วันที่เลือกไม่ว่างแล้ว กรุณาเลือกวันใหม่');

  a.time = a.type === 'combo' ? '07.30 น. (ตรวจเช้า-ผ่าตัดเย็น)' : SLOT_TEXT[a.slot];
  a.doctorName = a.doctorId ? doctors.data.find(d => d.id === a.doctorId).name : 'ไม่ระบุแพทย์';
  await gh.update('appts', list => { list.push(a); return list; }, `นัดหมายใหม่ ${a.date} (${a.id.slice(0,8)})`);
  return a.id;
}

/* ---------- เส้นทางสำหรับแอดมิน ---------- */
async function adminRoute(m, r, req, gh, user){
  let x;
  if (m==='GET' && r==='/data'){
    const [d,s,a] = await Promise.all([gh.read('doctors'), gh.read('schedule'), gh.read('appts')]);
    return { user, doctors:d.data, schedule:s.data, appointments:a.data };
  }
  if ((x = r.match(/^\/appointments\/([\w-]+)$/))){
    const id = x[1];
    if (m==='PATCH'){
      const { status } = await readBody(req);
      if (!STATUSES.includes(status)) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
      await gh.update('appts', list => {
        const a = list.find(i => i.id === id);
        if (!a) throw new HttpError(404, 'ไม่พบรายการนัดหมาย');
        Object.assign(a, { status, updatedBy:user, updatedAt:new Date().toISOString() });
        return list;
      }, `สถานะนัดหมาย ${id.slice(0,8)} → ${status} (${user})`);
      return { ok:true };
    }
    if (m==='DELETE'){
      await gh.update('appts', list => list.filter(i => i.id !== id), `ลบนัดหมาย ${id.slice(0,8)} (${user})`);
      return { ok:true };
    }
  }
  if (m==='POST' && r==='/schedule/bulk'){
    const { doctorId, slot, from, to, weekdays, add } = await readBody(req);
    if (!SLOT_DAYS[slot] || !isDate(from) || !isDate(to) || from > to) throw new HttpError(400, 'ข้อมูลช่วงวันที่ไม่ถูกต้อง');
    const t0 = Date.parse(from+'T00:00:00Z'), t1 = Date.parse(to+'T00:00:00Z');
    if ((t1-t0)/864e5 > 800) throw new HttpError(400, 'ช่วงวันที่ยาวเกินไป (ไม่เกิน 2 ปี)');
    if (!(await gh.read('doctors')).data.some(d => d.id === doctorId)) throw new HttpError(404, 'ไม่พบแพทย์');
    const wds = (Array.isArray(weekdays) ? weekdays : []).map(Number);
    let n = 0;
    await gh.update('schedule', sc => {
      n = 0;
      for (let t=t0; t<=t1; t+=864e5){
        const d = new Date(t), w = d.getUTCDay();
        if (!wds.includes(w) || !SLOT_DAYS[slot].includes(w)) continue;
        const k = d.toISOString().slice(0,10);
        const arr = ((sc[k] ??= {})[slot] ??= []);
        const i = arr.indexOf(doctorId);
        if (add && i < 0){ arr.push(doctorId); n++; }
        else if (!add && i >= 0){ arr.splice(i,1); n++; }
      }
      return sc;
    }, `${add?'เพิ่ม':'ลบ'}ตาราง ${doctorId} ${slot} ${from}→${to} (${user})`);
    return { ok:true, n };
  }
  if (m==='POST' && r==='/schedule/day'){
    const { date, slots } = await readBody(req);
    if (!isDate(date)) throw new HttpError(400, 'วันที่ไม่ถูกต้อง');
    const w = wday(date), allowed = w===0 ? [] : w===6 ? ['sat730'] : ['in730','out1400'];
    const docIds = (await gh.read('doctors')).data.map(d => d.id);
    await gh.update('schedule', sc => {
      const day = {};
      for (const s of allowed) day[s] = (Array.isArray(slots?.[s]) ? slots[s] : []).map(String).filter(id => docIds.includes(id));
      sc[date] = day; return sc;
    }, `ตารางแพทย์ ${date} (${user})`);
    return { ok:true };
  }
  if (m==='POST' && r==='/doctors'){
    const name = str((await readBody(req)).name, 100);
    if (!name) throw new HttpError(400, 'กรุณาระบุชื่อแพทย์');
    const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    await gh.update('doctors', l => { l.push({ id, name, order:Date.now() }); return l; }, `เพิ่มแพทย์ ${name} (${user})`);
    return { ok:true, id };
  }
  if (m==='DELETE' && (x = r.match(/^\/doctors\/([\w-]+)$/))){
    const id = x[1];
    await gh.update('doctors', l => l.filter(d => d.id !== id), `ลบแพทย์ ${id} (${user})`);
    await gh.update('schedule', sc => {
      for (const k in sc) for (const s in sc[k]) sc[k][s] = (sc[k][s] || []).filter(v => v !== id);
      return sc;
    }, `ลบตารางของแพทย์ ${id} (${user})`);
    return { ok:true };
  }
  if (m==='POST' && r==='/seed'){
    if ((await gh.read('doctors', true)).data.length) throw new HttpError(409, 'มีข้อมูลแพทย์อยู่แล้ว');
    const demo = [['d1','นพ.สมชาย ใจดี'],['d2','พญ.สุดา แสงทอง'],['d3','นพ.วิทยา รักษ์ตา'],['d4','พญ.อรุณี มองไกล']];
    const ids = demo.map(d => d[0]);
    await gh.update('doctors', () => demo.map(([id,name],i) => ({ id, name, order:i+1 })), `สร้างข้อมูลตัวอย่าง: แพทย์ (${user})`);
    const y0 = new Date().getUTCFullYear();
    await gh.update('schedule', sc => {
      for (const y of [y0, y0+1]){
        for (let t=Date.UTC(y,0,1); new Date(t).getUTCFullYear()===y; t+=864e5){
          const d = new Date(t), w = d.getUTCDay(), k = d.toISOString().slice(0,10);
          if (w>=1 && w<=5) sc[k] = { in730:[ids[(w-1)%4], ids[w%4]], out1400:[ids[(w+1)%4]] };
          else if (w===6) sc[k] = { sat730:[ids[Math.floor(d.getUTCDate()/7)%4]] };
        }
      }
      return sc;
    }, `สร้างข้อมูลตัวอย่าง: ตารางแพทย์ (${user})`);
    return { ok:true };
  }
  throw new HttpError(404, 'ไม่พบ API');
}

export default {
  async fetch(req, env){
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Admin-User,X-Admin-Pass',
      'Access-Control-Max-Age': '86400'
    };
    const json = (d, s=200) => new Response(JSON.stringify(d), { status:s,
      headers: { ...cors, 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' } });
    if (req.method === 'OPTIONS') return new Response(null, { status:204, headers:cors });

    try {
      const gh = new GitHubStore(env);
      const p = new URL(req.url).pathname.replace(/\/+$/,''), m = req.method;

      if (m==='GET' && p==='/api/public'){
        const [d,s] = await Promise.all([gh.read('doctors'), gh.read('schedule')]);
        return json({ doctors:d.data, schedule:s.data });
      }
      if (m==='POST' && p==='/api/appointments'){
        await createAppointment(await readBody(req), gh);
        return json({ ok:true });
      }
      if (p.startsWith('/api/admin/')){
        const user = await getAdmin(req, env);
        if (!user) throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
        return json(await adminRoute(m, p.slice(10), req, gh, user));
      }
      throw new HttpError(404, 'ไม่พบ API');
    } catch (e) {
      if (!e.status) console.error(e);
      return json({ error: e.status ? e.message : 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' }, e.status || 500);
    }
  }
};
