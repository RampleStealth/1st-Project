import { createServer } from "node:http";
import { loadConfig } from "@aio/config";

const config = loadConfig();
const port = config.WEB_PORT;

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AI Email Organizer</title><link rel="stylesheet" href="/app.css"></head><body><main><section><h1>Bring your Gmail into focus.</h1><p>Connect one Gmail account. We use read-only access to organize and synchronize email metadata; we never send, archive, delete, or label mail in this milestone.</p><form action="${config.API_ORIGIN}/v1/auth/google/start" method="post"><button type="submit">Connect Gmail</button></form><div id="status" class="status" aria-live="polite">Checking connection status…</div></section></main><script src="/app.js" defer></script></body></html>`;
const css = `body{margin:0;background:#f8f9fa;color:#18181b;font:16px/1.5 Inter,system-ui,sans-serif}main{max-width:640px;margin:12vh auto;padding:24px}section{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px}h1{font-size:28px;line-height:1.2;margin:0 0 12px}p{color:#52525b}button{background:#2563eb;border:0;border-radius:8px;color:#fff;cursor:pointer;font:inherit;font-weight:600;padding:12px 16px}button:focus-visible,a:focus-visible{outline:3px solid #60a5fa;outline-offset:3px}button[disabled]{opacity:.6;cursor:wait}.status{margin-top:20px;padding:12px;background:#f1f3f5;border-radius:8px}.error{color:#b91c1c}.secondary{background:#fff;border:1px solid #d1d5db;color:#18181b;margin-top:12px}`;
const client = `const api=${JSON.stringify(config.API_ORIGIN)};const csrf=()=>document.cookie.split('; ').find(x=>x.startsWith('aio_csrf='))?.split('=')[1];const status=document.getElementById('status');async function disconnect(id){if(!confirm('Disconnect this Gmail account? Synchronization will stop.'))return;const r=await fetch(api+'/v1/mailboxes/'+id,{method:'DELETE',credentials:'include',headers:{'x-csrf-token':csrf()||''}});if(!r.ok){status.textContent='We could not disconnect Gmail. Please try again.';return}await load()}async function load(){const r=await fetch(api+'/v1/mailboxes',{credentials:'include'});if(r.status===401){status.textContent='No Gmail account connected yet.';return}if(!r.ok){status.textContent='We could not load connection status. Please refresh.';return}const account=(await r.json())[0];if(!account){status.textContent='No Gmail account connected yet.';return}const sync=account.last_sync_error?'Sync needs attention: '+account.last_sync_error:account.last_synced_at?'Last synchronized '+new Date(account.last_synced_at).toLocaleString():'Preparing your mailbox…';status.replaceChildren(document.createTextNode(account.email_address+' is connected. '+sync));const button=document.createElement('button');button.className='secondary';button.type='button';button.textContent='Disconnect Gmail';button.addEventListener('click',()=>disconnect(account.id));status.append(document.createElement('br'),button)}load();`;

createServer((request, response) => {
  if (request.url === "/" || request.url?.startsWith("/connect/complete")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' " + config.API_ORIGIN });
    response.end(page);
    return;
  }
  if (request.url === "/app.css") { response.writeHead(200, { "content-type": "text/css; charset=utf-8" }); response.end(css); return; }
  if (request.url === "/app.js") { response.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); response.end(client); return; }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}).listen(port, "0.0.0.0");
