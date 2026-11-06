import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { pool, migrate } from './db.js';
import { decryptSecret, encryptSecret, encryptionKey, randomToken, sha256 } from './crypto.js';

const required = ['APP_ORIGIN','GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET','TOKEN_ENCRYPTION_KEY','SESSION_SECRET','DATABASE_URL'];
for (const name of required) if (!process.env[name]) throw new Error(name + ' is required');
const APP_ORIGIN = new URL(process.env.APP_ORIGIN).origin;
const API_ORIGIN = process.env.PUBLIC_API_URL ? new URL(process.env.PUBLIC_API_URL).origin : '';
const KEY = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
const TTL = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 168)) * 3600000;
const COOKIE = 'ocode_session';
const STATE_COOKIE = 'ocode_oauth_state';
const production = process.env.NODE_ENV === 'production';
const cookieOptions = { httpOnly:true, secure:production, sameSite:production ? 'none' : 'lax', path:'/' };
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', production ? 1 : false);
app.use(helmet());
app.use((req,res,next) => {
  const origin = req.get('origin');
  if (origin && origin !== APP_ORIGIN) return res.status(403).json({error:'origin_not_allowed'});
  if (origin === APP_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials','true');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Ocode-CSRF');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Vary','Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({limit:process.env.BODY_LIMIT || '16kb',strict:true}));
app.use(cookieParser());
const authLimit = rateLimit({windowMs:900000,limit:20,standardHeaders:'draft-7',legacyHeaders:false});
const apiLimit = rateLimit({windowMs:60000,limit:60,standardHeaders:'draft-7',legacyHeaders:false});
app.use('/auth',authLimit);
app.use('/api',apiLimit);

function originGuard(req,res,next) {
  if (req.get('origin') !== APP_ORIGIN) return res.status(403).json({error:'origin_not_allowed'});
  next();
}
function setSession(res,id) { res.cookie(COOKIE,id,{...cookieOptions,maxAge:TTL}); }
function clearSession(res) { res.clearCookie(COOKIE,cookieOptions); }
async function createSession(githubId) {
  const id = randomToken(), csrf = randomToken(), expires = new Date(Date.now()+TTL);
  await pool.query('INSERT INTO auth_sessions(id_hash,github_id,csrf_hash,expires_at) VALUES($1,$2,$3,$4)',[sha256(id),githubId,sha256(csrf),expires]);
  return {id,csrf};
}
async function findSession(req) {
  const id = req.cookies && req.cookies[COOKIE];
  if (!id || id.length > 128) return null;
  const r = await pool.query('SELECT s.id_hash,s.github_id,s.csrf_hash,s.expires_at,u.github_login,u.token_ciphertext,u.token_kind,u.scopes FROM auth_sessions s JOIN auth_users u ON u.github_id=s.github_id WHERE s.id_hash=$1 AND s.expires_at>NOW()',[sha256(id)]);
  return r.rows[0] || null;
}
async function requireSession(req,res,next) {
  try {
    const session = await findSession(req);
    if (!session) return res.status(401).json({error:'not_authenticated'});
    const csrf = req.get('x-ocode-csrf');
    if (!csrf || sha256(csrf) !== session.csrf_hash) return res.status(403).json({error:'csrf_check_failed'});
    req.auth = session;
    next();
  } catch { next(new Error('session_lookup_failed')); }
}
async function githubRequest(path,token) {
  const response = await fetch('https://api.github.com' + path,{
    headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'OCodeJS-CLI-Hub'},
    signal:AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'github_token_invalid' : 'github_api_error');
  return {data:await response.json(),scopes:(response.headers.get('x-oauth-scopes') || '').split(',').map(x=>x.trim()).filter(Boolean)};
}
async function saveCredential(user,token,kind,scopes) {
  await pool.query("INSERT INTO auth_users(github_id,github_login,token_ciphertext,token_kind,scopes,updated_at) VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(github_id) DO UPDATE SET github_login=EXCLUDED.github_login,token_ciphertext=EXCLUDED.token_ciphertext,token_kind=EXCLUDED.token_kind,scopes=EXCLUDED.scopes,updated_at=NOW()",
    [user.id,user.login,encryptSecret(token,KEY),kind,scopes]);
}
const publicUser = row => ({id:String(row.github_id),login:row.github_login,method:row.token_kind,scopes:row.scopes || []});

app.get('/health',(_req,res)=>res.json({ok:true,service:'ocodejs-auth'}));
app.get('/auth/github',originGuard,async (_req,res,next)=>{
  try {
    const state = randomToken();
    await pool.query('INSERT INTO oauth_states(state_hash,expires_at) VALUES($1,$2)',[sha256(state),new Date(Date.now()+600000)]);
    res.cookie(STATE_COOKIE,state,{httpOnly:true,secure:production,sameSite:'lax',path:'/auth/github/callback',maxAge:600000});
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id',process.env.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri',(API_ORIGIN || '')+'/auth/github/callback');
    url.searchParams.set('scope','read:user');
    url.searchParams.set('state',state);
    res.redirect(url.toString());
  } catch { next(new Error('oauth_start_failed')); }
});
app.get('/auth/github/callback',async (req,res,next)=>{
  try {
    const code=req.query.code, state=req.query.state, cookieState=req.cookies && req.cookies[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE,{httpOnly:true,secure:production,sameSite:'lax',path:'/auth/github/callback'});
    if (req.query.error) return res.redirect(APP_ORIGIN+'/?auth=cancelled');
    if (typeof code!=='string' || typeof state!=='string' || !cookieState || state!==cookieState) return res.status(400).send('OAuth state validation failed');
    const used=await pool.query('DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at>NOW() RETURNING state_hash',[sha256(state)]);
    if (!used.rowCount) return res.status(400).send('OAuth state expired or already used');
    const exchange=await fetch('https://github.com/login/oauth/access_token',{
      method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},
      body:JSON.stringify({client_id:process.env.GITHUB_CLIENT_ID,client_secret:process.env.GITHUB_CLIENT_SECRET,code}),
      signal:AbortSignal.timeout(12000)
    });
    const payload=await exchange.json();
    if (!exchange.ok || !payload.access_token) return res.status(400).send('GitHub OAuth exchange failed');
    const result=await githubRequest('/user',payload.access_token);
    await saveCredential(result.data,payload.access_token,'oauth',result.scopes);
    const session=await createSession(result.data.id);
    setSession(res,session.id);
    res.redirect(APP_ORIGIN+'/?auth=connected');
  } catch { next(new Error('oauth_callback_failed')); }
});
app.post('/auth/pat',originGuard,async (req,res,next)=>{
  try {
    const token=req.body && req.body.token;
    if (typeof token!=='string' || token.length<20 || token.length>500 || /\s/.test(token)) return res.status(400).json({error:'invalid_token_format'});
    const result=await githubRequest('/user',token);
    await saveCredential(result.data,token,'pat',result.scopes);
    const session=await createSession(result.data.id);
    setSession(res,session.id);
    res.status(201).json({connected:true,user:{id:String(result.data.id),login:result.data.login,method:'pat',scopes:result.scopes},csrfToken:session.csrf});
  } catch (error) {
    if (error.message==='github_token_invalid') return res.status(401).json({error:'github_token_invalid'});
    next(new Error('pat_connection_failed'));
  }
});
app.get('/auth/session',async (req,res,next)=>{
  try {
    const session=await findSession(req);
    if (!session) return res.json({connected:false});
    const csrf=randomToken();
    await pool.query('UPDATE auth_sessions SET csrf_hash=$1 WHERE id_hash=$2',[sha256(csrf),session.id_hash]);
    res.json({connected:true,user:publicUser(session),csrfToken:csrf});
  } catch { next(new Error('session_read_failed')); }
});
app.post('/auth/logout',originGuard,requireSession,async (req,res,next)=>{
  try { await pool.query('DELETE FROM auth_sessions WHERE id_hash=$1',[req.auth.id_hash]); clearSession(res); res.json({disconnected:true}); }
  catch { next(new Error('logout_failed')); }
});
app.post('/auth/disconnect',originGuard,requireSession,async (req,res,next)=>{
  try { await pool.query('DELETE FROM auth_users WHERE github_id=$1',[req.auth.github_id]); clearSession(res); res.json({disconnected:true,credentialsDeleted:true}); }
  catch { next(new Error('disconnect_failed')); }
});
app.get('/api/github/user',originGuard,requireSession,async (req,res,next)=>{
  try {
    const token=decryptSecret(req.auth.token_ciphertext,KEY);
    const result=await githubRequest('/user',token);
    const u=result.data;
    res.json({id:String(u.id),login:u.login,name:u.name,avatar_url:u.avatar_url,html_url:u.html_url});
  } catch { next(new Error('github_user_request_failed')); }
});
app.get('/api/github/repos',originGuard,requireSession,async (req,res,next)=>{
  try {
    const token=decryptSecret(req.auth.token_ciphertext,KEY);
    const page=Math.min(10,Math.max(1,Number.parseInt(req.query.page || '1',10) || 1));
    const result=await githubRequest('/user/repos?per_page=100&sort=updated&page='+page,token);
    res.json(result.data.map(r=>({id:r.id,name:r.name,full_name:r.full_name,private:r.private,html_url:r.html_url,description:r.description,updated_at:r.updated_at})));
  } catch { next(new Error('github_repos_request_failed')); }
});
app.use((error,_req,res,_next)=>{
  // Never log request bodies, headers, OAuth codes, credentials, or exception messages.
  console.error('OCode auth request failed');
  if (!res.headersSent) res.status(500).json({error:'internal_server_error'});
});
const server=app.listen(Number(process.env.PORT || 8787),async()=>{
  try { await migrate(); console.log('OCode auth service ready'); }
  catch { console.error('OCode auth database initialization failed'); server.close(()=>process.exit(1)); }
});
process.on('SIGTERM',async()=>{server.close();await pool.end();});
