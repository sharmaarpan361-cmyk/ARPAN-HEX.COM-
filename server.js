'use strict';
// ARPAN HEX IND — zero-dependency Node 22+ server (node:sqlite). Run: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DatabaseSync}=require('node:sqlite');
const E=process.env, PORT=+E.PORT||3000, KEY=E.RAZORPAY_KEY_ID, SEC=E.RAZORPAY_KEY_SECRET, WH=E.RAZORPAY_WEBHOOK_SECRET;
const PROD=E.NODE_ENV==='production', GW=!!(KEY&&SEC);
const db=new DatabaseSync(E.DB_PATH||'hex.db');
db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,pass TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY,slug TEXT UNIQUE,name TEXT,description TEXT,active INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,slug TEXT UNIQUE NOT NULL,category_id INTEGER REFERENCES categories(id),name TEXT NOT NULL,short TEXT DEFAULT '',full TEXT DEFAULT '',price_paise INTEGER NOT NULL,orig_paise INTEGER,available INTEGER DEFAULT 1,published INTEGER DEFAULT 0,version TEXT DEFAULT '',sysreq TEXT DEFAULT '',compat TEXT DEFAULT '',install TEXT DEFAULT '',support TEXT DEFAULT '',delivery TEXT DEFAULT '',delivery_url TEXT DEFAULT '',updated TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),total_paise INTEGER NOT NULL,currency TEXT DEFAULT 'INR',status TEXT NOT NULL,created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_items(order_id TEXT REFERENCES orders(id),product_id INTEGER,name TEXT,price_paise INTEGER);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,order_id TEXT UNIQUE REFERENCES orders(id),provider_order_id TEXT UNIQUE,provider_payment_id TEXT UNIQUE,status TEXT,amount_paise INTEGER,currency TEXT,verified_at TEXT);
CREATE TABLE IF NOT EXISTS entitlements(user_id INTEGER,product_id INTEGER,order_id TEXT,UNIQUE(user_id,product_id));
CREATE TABLE IF NOT EXISTS webhook_events(id TEXT PRIMARY KEY,received TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,detail TEXT,at TEXT DEFAULT CURRENT_TIMESTAMP);`);
db.exec(`CREATE TABLE IF NOT EXISTS tokens(h TEXT PRIMARY KEY,user_id INTEGER NOT NULL,kind TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS email_events(id INTEGER PRIMARY KEY,key TEXT UNIQUE,kind TEXT,to_addr TEXT,status TEXT,at TEXT DEFAULT CURRENT_TIMESTAMP);`);
try{db.exec('ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0')}catch{}
for(const c of['file_name','file_key'])try{db.exec(`ALTER TABLE products ADD COLUMN ${c} TEXT DEFAULT ''`)}catch{}
const DIR=path.join(path.dirname(E.DB_PATH?path.resolve(E.DB_PATH):__dirname+'/x'),'private_files'),MAXF=(+E.MAX_UPLOAD_MB||500)*1048576;
[['game-tools','HEX Game Tools','Gaming utilities and supported game-related tools.'],['pro-utilities','HEX Pro Utilities','Advanced utilities for supported gaming software.'],['emulator-hub','HEX Emulator Hub','Emulator management and compatibility tools.'],['performance-lab','HEX Performance Lab','Performance monitoring and optimization utilities.'],['gaming-essentials','HEX Gaming Essentials','Essential gaming tools and resources.'],['config-studio','HEX Config Studio','Configuration management and customization utilities.']]
 .forEach(c=>db.prepare('INSERT OR IGNORE INTO categories(slug,name,description) VALUES(?,?,?)').run(...c));
const q=(s,...a)=>db.prepare(s).all(...a), one=(s,...a)=>db.prepare(s).get(...a), run=(s,...a)=>db.prepare(s).run(...a);
const audit=(actor,action,detail)=>run('INSERT INTO audit(actor,action,detail) VALUES(?,?,?)',String(actor),action,JSON.stringify(detail));
// ---- auth helpers
const hashPw=p=>{const s=crypto.randomBytes(16);return s.toString('hex')+':'+crypto.scryptSync(p,s,64).toString('hex')};
const checkPw=(p,st)=>{const[s,h]=st.split(':');const b=crypto.scryptSync(p,Buffer.from(s,'hex'),64);return crypto.timingSafeEqual(b,Buffer.from(h,'hex'))};
const sha=t=>crypto.createHash('sha256').update(t).digest('hex');
if(!one("SELECT 1 x FROM users WHERE role='admin'")){
  if(E.ADMIN_EMAIL&&(E.ADMIN_PASSWORD||'').length>=12){run("INSERT INTO users(email,name,pass,role) VALUES(?,?,?,'admin')",E.ADMIN_EMAIL.toLowerCase(),'Owner',hashPw(E.ADMIN_PASSWORD));audit('system','admin.bootstrap',{email:E.ADMIN_EMAIL});console.log('Admin created. Remove ADMIN_PASSWORD from env now.')}
  else console.warn('No admin exists. Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ chars) for the first start.');}
// ---- email (Resend HTTP API). Unconfigured = recorded as SKIPPED, never pretends to send.
const APP=(E.APP_URL||'http://localhost:'+PORT).replace(/\/$/,'');
function sendMail(key,kind,to,subject,text){ // one row per key => retried events can't send twice
  if(run('INSERT OR IGNORE INTO email_events(key,kind,to_addr,status) VALUES(?,?,?,?)',key,kind,to,E.RESEND_API_KEY?'QUEUED':'SKIPPED').changes===0)return;
  if(!E.RESEND_API_KEY){if(!PROD)console.log(`[mail skipped: ${kind}] to ${to}\n${text}\n`);return}
  fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+E.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:E.MAIL_FROM,to:[to],subject,text})})
   .then(r=>run('UPDATE email_events SET status=? WHERE key=?',r.ok?'SENT':'FAILED',key)).catch(()=>run("UPDATE email_events SET status='FAILED' WHERE key=?",key))}
function mkToken(uid,kind,ms){const t=crypto.randomBytes(32).toString('hex');run('DELETE FROM tokens WHERE user_id=? AND kind=?',uid,kind);run('INSERT INTO tokens VALUES(?,?,?,?,0)',sha(t),uid,kind,Date.now()+ms);return t}
function sendVerify(u){const t=mkToken(u.id,'verify',864e5);sendMail('verify:'+t.slice(0,12),'verify',u.email,'Verify your ARPAN HEX IND email',`Hi ${u.name},\n\nConfirm your email: ${APP}/#/verify/${t}\n\nThis link works for 24 hours. If you did not sign up, ignore this email.`)}
const fails=new Map();
const limited=k=>{const f=fails.get(k);return f&&f.n>=5&&Date.now()-f.t<9e5};
const bump=k=>{const f=fails.get(k);fails.set(k,{n:(f&&Date.now()-f.t<9e5?f.n:0)+1,t:Date.now()})};
// ---- payments
const money=p=>Math.round(p);
async function rzp(method,url,body){const r=await fetch('https://api.razorpay.com/v1'+url,{method,headers:{Authorization:'Basic '+Buffer.from(KEY+':'+SEC).toString('base64'),'Content-Type':'application/json'},body:body&&JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error('Gateway error '+r.status);return j}
const hmac=(secret,data)=>crypto.createHmac('sha256',secret).update(data).digest('hex');
const safeEq=(a,b)=>{a=Buffer.from(String(a));b=Buffer.from(String(b));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
function fulfil(orderId,payId,amount,currency){ // idempotent: only the first caller flips the order to PAID
  db.exec('BEGIN IMMEDIATE');
  try{const o=one('SELECT * FROM orders WHERE id=?',orderId);
    if(!o||o.status==='PAID'||o.status==='REFUNDED'){db.exec('COMMIT');return false}
    if(o.total_paise!==amount||currency!=='INR')throw new Error('amount/currency mismatch');
    run("UPDATE orders SET status='PAID' WHERE id=?",orderId);
    run("UPDATE payments SET status='VERIFIED',provider_payment_id=?,amount_paise=?,currency=?,verified_at=CURRENT_TIMESTAMP WHERE order_id=?",payId,amount,currency,orderId);
    run('INSERT OR IGNORE INTO entitlements(user_id,product_id,order_id) SELECT ?,product_id,order_id FROM order_items WHERE order_id=?',o.user_id,orderId);
    audit('payment-provider','order.paid',{orderId,payId,amount});
    db.exec('COMMIT');
    const u=one('SELECT email,name FROM users WHERE id=?',o.user_id),names=q('SELECT name FROM order_items WHERE order_id=?',orderId).map(x=>x.name).join(', '),amt='₹'+(amount/100).toFixed(2);
    sendMail('paid:'+orderId,'order_confirmation',u.email,`Payment confirmed — order ${orderId}`,`Hi ${u.name},\n\nWe have verified your payment.\nOrder: ${orderId}\nProducts: ${names}\nAmount: ${amt} INR\nStatus: PAID\n\nView your order: ${APP}/#/order/${orderId}`);
    sendMail('deliver:'+orderId,'delivery',u.email,`Your products are ready — order ${orderId}`,`Your purchase (${names}) is unlocked. Sign in and open ${APP}/#/order/${orderId} to get access and installation steps.`);
    return true}catch(e){try{db.exec('ROLLBACK')}catch{}throw e}}
// ---- http plumbing
const send=(res,c,o,h={})=>{res.writeHead(c,{'Content-Type':'application/json','Cache-Control':'no-store',...h});res.end(JSON.stringify(o))};
const fail=(c,m)=>{const e=new Error(m);e.code=c;return e};
const readBody=req=>new Promise((ok,no)=>{let b=[],n=0;req.on('data',d=>{n+=d.length;if(n>1e5){no(fail(413,'Too large'));req.destroy()}else b.push(d)});req.on('end',()=>ok(Buffer.concat(b).toString()))});
const cookie=(req,n)=>((req.headers.cookie||'').split(/;\s*/).find(c=>c.startsWith(n+'='))||'').slice(n.length+1);
function userOf(req){const t=cookie(req,'sid');if(!t)return null;return one('SELECT u.id,u.email,u.name,u.role,u.verified FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.h=? AND s.expires>?',sha(t),Date.now())}
const publicProduct=p=>{const{delivery_url,file_key,file_name,...r}=p;return r};
const PSQL='SELECT p.*,c.slug cat_slug,c.name cat_name FROM products p LEFT JOIN categories c ON c.id=p.category_id';
const str=(v,max,req)=>{v=String(v??'').trim();if(req&&!v)throw fail(400,'Missing field');if(v.length>max)throw fail(400,'Field too long');return v};
function cleanProduct(b,old){ // server-side validation of every admin product edit
  const price=Math.round(Number(b.price)*100), orig=b.original===''||b.original==null?null:Math.round(Number(b.original)*100);
  if(!Number.isInteger(price)||price<0||price>1e7)throw fail(400,'Price must be between ₹0 and ₹1,00,000');
  if(orig!==null&&(!Number.isInteger(orig)||orig<price))throw fail(400,'Original price must be at least the current price');
  const cat=one('SELECT id FROM categories WHERE id=?',+b.category_id);if(!cat)throw fail(400,'Choose a category');
  const url=str(b.delivery_url,500);if(url&&!/^https:\/\//.test(url))throw fail(400,'Delivery URL must start with https://');
  return{name:str(b.name,120,1),short:str(b.short,200),full:str(b.full,5000),price_paise:price,orig_paise:orig,category_id:cat.id,available:b.available?1:0,published:b.published?1:0,version:str(b.version,40),sysreq:str(b.sysreq,1000),compat:str(b.compat,1000),install:str(b.install,2000),support:str(b.support,500),delivery:str(b.delivery,300),delivery_url:url}}
const slugify=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'product';
const routes=[];const R=(m,p,f,role)=>routes.push([m,new RegExp('^'+p+'$'),f,role]);
// public
R('GET','/api/config',()=>({gateway:GW?(KEY.startsWith('rzp_live')?'LIVE':'TEST MODE'):'NOT CONFIGURED',key:GW?KEY:null,support:E.SUPPORT_EMAIL||null}));
R('GET','/api/categories',()=>q('SELECT c.id,c.slug,c.name,c.description,c.active,(SELECT COUNT(*) FROM products p WHERE p.category_id=c.id AND p.published=1) count FROM categories c ORDER BY c.id'));
R('GET','/api/products',({u})=>{const s=u.searchParams,w=['p.published=1','c.active=1'],a=[];
  if(s.get('category')){w.push('c.slug=?');a.push(s.get('category'))}
  if(s.get('q')){w.push('p.name LIKE ?');a.push('%'+s.get('q').slice(0,50)+'%')}
  if(s.get('available')==='1')w.push('p.available=1');
  const o={price_asc:'p.price_paise ASC',price_desc:'p.price_paise DESC',name:'p.name ASC'}[s.get('sort')]||'p.id DESC';
  return q(PSQL+' WHERE '+w.join(' AND ')+' ORDER BY '+o,...a).map(publicProduct)});
R('GET','/api/products/([a-z0-9-]+)',({m})=>{const p=one(PSQL+' WHERE p.slug=? AND p.published=1 AND c.active=1',m[1]);if(!p)throw fail(404,'Not found');return publicProduct(p)});
// auth
R('POST','/api/register',async({b,req,res})=>{const email=str(b.email,200,1).toLowerCase(),name=str(b.name,80,1),pw=str(b.password,200,1);
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))throw fail(400,'Enter a valid email');if(pw.length<10)throw fail(400,'Password needs at least 10 characters');
  if(one('SELECT 1 x FROM users WHERE email=?',email))throw fail(409,'An account with this email already exists');
  const id=run('INSERT INTO users(email,name,pass) VALUES(?,?,?)',email,name,hashPw(pw)).lastInsertRowid;sendVerify({id,email,name});return session(res,id)});
R('POST','/api/login',async({b,req,res})=>{const email=str(b.email,200,1).toLowerCase(),k=req.socket.remoteAddress+email;
  if(limited(k))throw fail(429,'Too many attempts. Try again in 15 minutes.');
  const u=one('SELECT * FROM users WHERE email=?',email);if(!u||!checkPw(String(b.password||''),u.pass)){bump(k);throw fail(401,'Email or password is incorrect')}
  if(b.admin&&u.role!=='admin'){bump(k);throw fail(401,'Email or password is incorrect')}
  fails.delete(k);if(u.role==='admin')audit(u.email,'admin.login',{});return session(res,u.id)});
function session(res,id){const t=crypto.randomBytes(32).toString('hex');run('INSERT INTO sessions VALUES(?,?,?)',sha(t),id,Date.now()+6048e5);
  res.setHeader('Set-Cookie',`sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${PROD?'; Secure':''}`);return one('SELECT id,email,name,role,verified FROM users WHERE id=?',id)}
R('POST','/api/logout',({req,res})=>{run('DELETE FROM sessions WHERE h=?',sha(cookie(req,'sid')));res.setHeader('Set-Cookie','sid=; Max-Age=0; Path=/');return{ok:1}});
R('GET','/api/me',({user})=>user||null);
R('POST','/api/verify-email',({b})=>{const t=one('SELECT * FROM tokens WHERE h=? AND kind=? AND used=0 AND expires>?',sha(String(b.token||'')),'verify',Date.now());if(!t)throw fail(400,'This verification link is invalid or expired');
  run('UPDATE users SET verified=1 WHERE id=?',t.user_id);run('UPDATE tokens SET used=1 WHERE h=?',t.h);return{ok:1}});
R('POST','/api/resend-verification',({user})=>{if(user.verified)return{ok:1};const k='rv'+user.id;if(limited(k))throw fail(429,'Please wait before requesting another email');bump(k);bump(k);bump(k);bump(k);bump(k);sendVerify(user);return{ok:1}});
R('POST','/api/forgot-password',({b,req})=>{const email=str(b.email,200,1).toLowerCase(),k='fp'+req.socket.remoteAddress;if(limited(k))throw fail(429,'Too many requests. Try again later.');bump(k);
  const u=one('SELECT * FROM users WHERE email=?',email); // same answer whether or not the account exists
  if(u){const t=mkToken(u.id,'reset',36e5);sendMail('reset:'+t.slice(0,12),'reset',u.email,'Reset your ARPAN HEX IND password',`Hi ${u.name},\n\nSet a new password: ${APP}/#/reset/${t}\n\nThis link works for 1 hour. If you did not ask for this, ignore this email; your password is unchanged.`)}
  return{ok:1}});
R('POST','/api/reset-password',({b})=>{const pw=str(b.password,200,1);if(pw.length<10)throw fail(400,'Password needs at least 10 characters');
  const t=one('SELECT * FROM tokens WHERE h=? AND kind=? AND used=0 AND expires>?',sha(String(b.token||'')),'reset',Date.now());if(!t)throw fail(400,'This reset link is invalid or expired');
  run('UPDATE users SET pass=? WHERE id=?',hashPw(pw),t.user_id);run('UPDATE tokens SET used=1 WHERE h=?',t.h);run('DELETE FROM sessions WHERE user_id=?',t.user_id);audit('user:'+t.user_id,'password.reset',{});return{ok:1}});
// checkout: prices are ALWAYS re-read from the database here
R('POST','/api/checkout',async({b,user})=>{const ids=[...new Set((Array.isArray(b.items)?b.items:[]).map(i=>+i.id))].slice(0,20);if(!ids.length)throw fail(400,'Your cart is empty');
  const ps=ids.map(id=>one(PSQL+' WHERE p.id=? AND p.published=1 AND p.available=1 AND c.active=1',id));if(ps.some(p=>!p))throw fail(400,'A product in your cart is no longer available');
  const total=ps.reduce((s,p)=>s+p.price_paise,0),oid='HEX'+Date.now().toString(36).toUpperCase()+crypto.randomBytes(3).toString('hex').toUpperCase();
  if(total<100)throw fail(400,'Minimum order is ₹1');
  run("INSERT INTO orders(id,user_id,total_paise,status) VALUES(?,?,?,'PENDING')",oid,user.id,total);
  ps.forEach(p=>run('INSERT INTO order_items VALUES(?,?,?,?)',oid,p.id,p.name,p.price_paise));
  if(!GW)return{orderId:oid,gateway:'NOT CONFIGURED'};
  const ro=await rzp('POST','/orders',{amount:total,currency:'INR',receipt:oid});
  run("INSERT INTO payments(order_id,provider_order_id,status,amount_paise,currency) VALUES(?,?,'CREATED',?,'INR')",oid,ro.id,total);
  run("UPDATE orders SET status='PAYMENT PROCESSING' WHERE id=?",oid);
  return{orderId:oid,gateway:'ON',key:KEY,providerOrderId:ro.id,amount:total}});
R('POST','/api/payment/verify',async({b,user})=>{const o=one('SELECT * FROM orders WHERE id=? AND user_id=?',String(b.orderId),user.id),p=o&&one('SELECT * FROM payments WHERE order_id=?',o.id);if(!p)throw fail(404,'Order not found');
  const pid=String(b.razorpay_payment_id||'');if(!safeEq(hmac(SEC,p.provider_order_id+'|'+pid),b.razorpay_signature||''))throw fail(400,'Signature check failed');
  const gp=await rzp('GET','/payments/'+encodeURIComponent(pid)); // independent server-to-server confirmation
  if(gp.order_id!==p.provider_order_id)throw fail(400,'Payment does not belong to this order');
  if(gp.status!=='captured')return{status:o.status,note:'Payment is '+gp.status+'. Your order stays unpaid until the gateway confirms capture.'};
  fulfil(o.id,gp.id,gp.amount,gp.currency);return{status:'PAID'}});
R('POST','/api/webhook/razorpay',async({req,raw})=>{if(!WH)throw fail(503,'Webhook not configured');
  if(!safeEq(hmac(WH,raw),req.headers['x-razorpay-signature']||''))throw fail(400,'Bad signature');
  const eid=req.headers['x-razorpay-event-id'];if(!eid)throw fail(400,'No event id');
  if(run('INSERT OR IGNORE INTO webhook_events(id) VALUES(?)',eid).changes===0)return{duplicate:1};
  const ev=JSON.parse(raw),pay=ev.payload&&ev.payload.payment&&ev.payload.payment.entity;if(!pay)return{ignored:1};
  const p=one('SELECT * FROM payments WHERE provider_order_id=?',pay.order_id);if(!p)return{ignored:1};
  if(ev.event==='payment.captured')fulfil(p.order_id,pay.id,pay.amount,pay.currency);
  else if(ev.event==='payment.failed'){run("UPDATE orders SET status='FAILED' WHERE id=? AND status IN('PENDING','PAYMENT PROCESSING')",p.order_id);run("UPDATE payments SET status='FAILED' WHERE order_id=? AND status<>'VERIFIED'",p.order_id);
    const o=one("SELECT o.id,o.total_paise,u.email FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=? AND o.status='FAILED'",p.order_id);
    if(o)sendMail('failed:'+o.id,'payment_failed',o.email,`Payment failed — order ${o.id}`,`Your payment for order ${o.id} (₹${(o.total_paise/100).toFixed(2)}) did not go through and the order is marked FAILED. You can place a new order any time: ${APP}/#/cart`)}
  return{ok:1}});
// user data
R('GET','/api/orders',({user})=>q('SELECT o.*,(SELECT group_concat(name,", ") FROM order_items i WHERE i.order_id=o.id) items FROM orders o WHERE user_id=? ORDER BY created DESC',user.id));
R('GET','/api/orders/([A-Z0-9]+)',({m,user})=>{const o=one('SELECT * FROM orders WHERE id=? AND user_id=?',m[1],user.id);if(!o)throw fail(404,'Not found');
  const pay=one('SELECT status,provider_payment_id,amount_paise,currency,verified_at FROM payments WHERE order_id=?',o.id);
  const items=q('SELECT i.*,CASE WHEN e.user_id IS NULL THEN 0 ELSE 1 END access FROM order_items i LEFT JOIN entitlements e ON e.product_id=i.product_id AND e.user_id=? AND e.order_id=i.order_id WHERE i.order_id=?',user.id,o.id);return{...o,payment:pay,items}});
R('GET','/api/access/(\\d+)',({m,user})=>{if(!one('SELECT 1 x FROM entitlements WHERE user_id=? AND product_id=?',user.id,+m[1]))throw fail(403,'Purchase required');
  const p=one('SELECT name,delivery,delivery_url,install,file_name FROM products WHERE id=?',+m[1]);return p});
R('GET','/api/purchased',({user})=>q('SELECT p.id,p.name,p.version FROM entitlements e JOIN products p ON p.id=e.product_id WHERE e.user_id=?',user.id));
// admin
const A='admin';
R('GET','/api/admin/stats',()=>({orders:one('SELECT COUNT(*) n FROM orders').n,paid:one("SELECT COUNT(*) n FROM orders WHERE status='PAID'").n,pending:one("SELECT COUNT(*) n FROM orders WHERE status IN('PENDING','PAYMENT PROCESSING')").n,failed:one("SELECT COUNT(*) n FROM orders WHERE status IN('FAILED','CANCELLED')").n,sales_paise:one("SELECT COALESCE(SUM(total_paise),0) n FROM orders WHERE status='PAID'").n,users:one('SELECT COUNT(*) n FROM users').n,recent:q('SELECT o.id,o.status,o.total_paise,o.created,u.email FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created DESC LIMIT 5')}),A);
R('GET','/api/admin/products',()=>q(PSQL+' ORDER BY p.id DESC'),A);
R('POST','/api/admin/products',({b,user})=>{const d=cleanProduct(b),slug=slugify(d.name)+'-'+crypto.randomBytes(2).toString('hex');
  const k=Object.keys(d);const id=run(`INSERT INTO products(slug,${k}) VALUES(?,${k.map(()=>'?')})`,slug,...k.map(x=>d[x])).lastInsertRowid;audit(user.email,'product.create',{id,...d,delivery_url:d.delivery_url?'(set)':''});return{id}},A);
R('PUT','/api/admin/products/(\\d+)',({b,m,user})=>{const old=one('SELECT * FROM products WHERE id=?',+m[1]);if(!old)throw fail(404,'Not found');const d=cleanProduct(b),k=Object.keys(d),ch={};
  k.forEach(x=>{if(d[x]!==old[x])ch[x]=x==='delivery_url'?'(changed)':{from:old[x],to:d[x]}});
  run(`UPDATE products SET ${k.map(x=>x+'=?')},updated=CURRENT_TIMESTAMP WHERE id=?`,...k.map(x=>d[x]),old.id);audit(user.email,'product.update',{id:old.id,changes:ch});return{ok:1,changes:Object.keys(ch).length}},A);
R('PUT','/api/admin/categories/(\\d+)',({b,m,user})=>{run('UPDATE categories SET active=? WHERE id=?',b.active?1:0,+m[1]);audit(user.email,'category.active',{id:+m[1],active:!!b.active});return{ok:1}},A);
R('GET','/api/admin/orders',({u})=>{const s=u.searchParams,w=['1=1'],a=[];if(s.get('q')){w.push('(o.id LIKE ? OR u.email LIKE ?)');a.push('%'+s.get('q')+'%','%'+s.get('q')+'%')}if(s.get('status')){w.push('o.status=?');a.push(s.get('status'))}
  return q(`SELECT o.*,u.email,p.provider_order_id,p.provider_payment_id,p.status pay_status,p.verified_at FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN payments p ON p.order_id=o.id WHERE ${w.join(' AND ')} ORDER BY o.created DESC LIMIT 25 OFFSET ?`,...a,25*Math.max(0,(+s.get('page')||1)-1))},A);
R('GET','/api/admin/users',()=>q('SELECT id,email,name,role,created FROM users ORDER BY id DESC LIMIT 100'),A);
R('GET','/api/admin/audit',({u})=>q('SELECT * FROM audit ORDER BY id DESC LIMIT 25 OFFSET ?',25*Math.max(0,(+u.searchParams.get('page')||1)-1)),A);
// server
const FILES={'/':'index.html','/app.js':'app.js','/style.css':'style.css'},TYPES={html:'text/html',js:'text/javascript',css:'text/css'};
http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://checkout.razorpay.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-src https://api.razorpay.com; connect-src 'self'; frame-ancestors 'none'");
  try{const u=new URL(req.url,'http://x');
    if(!u.pathname.startsWith('/api/')){const f=FILES[u.pathname]||'index.html';res.writeHead(200,{'Content-Type':(TYPES[f.split('.')[1]])+'; charset=utf-8','Cache-Control':'no-cache'});return res.end(fs.readFileSync(path.join(__dirname,'public',f)))}
    const up=/^\/api\/admin\/products\/(\d+)\/file$/.exec(u.pathname),dl=/^\/api\/download\/(\d+)$/.exec(u.pathname);
    if(up&&req.method==='PUT'){ // streamed upload to private disk folder (never served statically)
      if(req.headers['x-hex']!=='1')throw fail(403,'Missing CSRF header');const adm=userOf(req);if(!adm||adm.role!=='admin')throw fail(403,'Admins only');
      const p=one('SELECT * FROM products WHERE id=?',+up[1]);if(!p)throw fail(404,'Not found');if(!(+req.headers['content-length']>0))throw fail(400,'Empty file');if(+req.headers['content-length']>MAXF)throw fail(413,'File too large (limit '+MAXF/1048576+' MB)');
      const name=(decodeURIComponent(String(req.headers['x-filename']||'file')).replace(/[^\w.\- ]/g,'_').slice(0,100))||'file',key=crypto.randomBytes(16).toString('hex'),fp=path.join(DIR,key);fs.mkdirSync(DIR,{recursive:true});
      let n=0;try{await new Promise((ok,no)=>{const ws=fs.createWriteStream(fp);req.on('data',d=>{n+=d.length;if(n>MAXF){no(fail(413,'File too large'));req.destroy()}});req.on('error',no);req.on('aborted',()=>no(fail(400,'Upload interrupted')));ws.on('error',no);ws.on('finish',ok);req.pipe(ws)})}catch(e){fs.rmSync(fp,{force:true});throw e}
      if(p.file_key)fs.rmSync(path.join(DIR,p.file_key),{force:true});run('UPDATE products SET file_name=?,file_key=?,updated=CURRENT_TIMESTAMP WHERE id=?',name,key,p.id);audit(adm.email,'product.file',{id:p.id,name,bytes:n});return send(res,200,{ok:1,name,bytes:n})}
    if(dl&&req.method==='GET'){const du=userOf(req);if(!du)throw fail(401,'Please sign in');
      if(du.role!=='admin'&&!one('SELECT 1 x FROM entitlements WHERE user_id=? AND product_id=?',du.id,+dl[1]))throw fail(403,'Purchase required');
      const p=one('SELECT file_name,file_key FROM products WHERE id=?',+dl[1]);if(!p||!p.file_key)throw fail(404,'No file has been uploaded for this product');const fp=path.join(DIR,p.file_key);if(!fs.existsSync(fp))throw fail(404,'File missing on server');
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':fs.statSync(fp).size,'Content-Disposition':`attachment; filename="${p.file_name}"`,'Cache-Control':'private, no-store'});return fs.createReadStream(fp).pipe(res)}
    const raw=req.method==='GET'?'':await readBody(req),isWH=u.pathname==='/api/webhook/razorpay';
    if(req.method!=='GET'&&!isWH&&req.headers['x-hex']!=='1')throw fail(403,'Missing CSRF header'); // custom header can't be sent cross-site
    const user=userOf(req);
    for(const[m,re,fn,role]of routes){const mm=re.exec(u.pathname);if(m!==req.method||!mm)continue;
      const open=['/api/config','/api/categories','/api/products','/api/login','/api/register','/api/me','/api/logout','/api/forgot-password','/api/verify-email','/api/reset-password'];
      const pub=isWH||open.includes(u.pathname)||u.pathname.startsWith('/api/products/');
      if(!pub&&!user)throw fail(401,'Please sign in');if(role==='admin'&&(!user||user.role!=='admin'))throw fail(403,'Admins only');
      let b={};if(raw&&!isWH){try{b=JSON.parse(raw)}catch{throw fail(400,'Invalid JSON')}}
      return send(res,200,await fn({req,res,u,m:mm,b,raw,user}))}
    throw fail(404,'Not found')
  }catch(e){const c=e.code>=400&&e.code<600?e.code:500;if(c===500)console.error(e);send(res,c,{error:c===500?'Something went wrong':e.message})}
}).listen(PORT,()=>console.log(`ARPAN HEX IND on :${PORT} — gateway: ${GW?(KEY.startsWith('rzp_live')?'LIVE':'TEST MODE'):'NOT CONFIGURED'}`));
