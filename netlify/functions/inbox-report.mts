/* =====================================================================
   LotOut Inbox Report — data feed  (Netlify Function, .mts)  v3 Conversations
   Route: /.netlify/functions/inbox-report
   Reads the HubSpot Conversations inbox (scope: conversations.read), strips
   noise, parses i-bidder / BidSpotter enquiries, classifies the rest, and
   reports what's been ACTIONED (thread closed) vs still OPEN. Upserts ONE
   row into Supabase public.inbox_reports (one per day).
     ?diagnostics=1  -> credential presence only
     ?inboxes=1      -> list your conversations inboxes (to confirm INBOX_ID)
     ?dry=1          -> return payload WITHOUT writing (add &limit=40 to test fast)
     ?date=YYYY-MM-DD-> run for a specific day (default: yesterday, London)
     ?inbox=<id>     -> override inbox (default INBOX_ID below)
   Read-only. Does not write back to the CRM.
   ===================================================================== */

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const INBOX_ID = "228812790";   // Info Inbox (the info@ shared mailbox). Confirm with ?inboxes=1
const CONCURRENCY = 6;
const OVERDUE_DAYS = 3;

const USER_BY_ID = {
  "78639512":"Elliot Corney","51982711":"Anthony Worth","51110999":"Emma Humble",
  "51108339":"Amy Rutherford","65901157":"Ross Gilfillan","29383896":"Neil Rayner","50019395":"Andy Smith"
};
const CAT_LABELS = {
  buyer:"Buyer & lot", seller:"Seller leads", collection:"Collections/RAMS",
  payment:"Payments/invoices", viewing:"Viewings", complaint:"Complaints", partnership:"Partnerships"
};

const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function hsGet(path){
  for (let a=0; a<6; a++){
    const r = await fetch("https://api.hubapi.com"+path, { headers:{ Authorization:"Bearer "+HUBSPOT_TOKEN } });
    if (r.status===429){ const ra=Number(r.headers.get("retry-after"))||1; await sleep(ra*1000+250); continue; }
    if (!r.ok) throw new Error("HubSpot "+path+" "+r.status+" "+(await r.text()).slice(0,300));
    return r.json();
  }
  throw new Error("HubSpot rate limit: retries exhausted on "+path);
}
async function mapPool(items, worker, concurrency){
  const out=[]; let i=0;
  const runners = Array.from({length:Math.min(concurrency,items.length||1)}, async ()=>{
    while (i<items.length){ const idx=i++; out[idx]=await worker(items[idx]); }
  });
  await Promise.all(runners);
  return out;
}
async function listThreads(inboxId, sinceISO){
  const out=[]; let after;
  do{
    const qs = new URLSearchParams({ limit:"200", sort:"latestMessageTimestamp", latestMessageTimestampAfter:sinceISO });
    if (inboxId) qs.set("inboxId", inboxId);
    if (after)   qs.set("after", after);
    const j = await hsGet("/conversations/v3/conversations/threads?"+qs.toString());
    for (const t of (j.results||[])) out.push(t);
    after = j.paging && j.paging.next && j.paging.next.after;
  } while(after);
  return out;
}
const getMessages = threadId => hsGet("/conversations/v3/conversations/threads/"+threadId+"/messages?limit=100").then(j=>j.results||[]);

async function sbUpsert(row){
  const r = await fetch(SUPABASE_URL+"/rest/v1/inbox_reports?on_conflict=report_date", {
    method:"POST",
    headers:{ apikey:SUPABASE_KEY, Authorization:"Bearer "+SUPABASE_KEY, "Content-Type":"application/json", Prefer:"resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row)
  });
  if (!r.ok) throw new Error("Supabase "+r.status+" "+(await r.text()).slice(0,300));
}

// ---- pure helpers ----
const londonDate = ms => new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/London"}).format(new Date(ms));
const hhmm = ms => new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",hour:"2-digit",minute:"2-digit"}).format(new Date(ms));
function yesterdayLondon(now){ const [y,m,d]=londonDate(now).split("-").map(Number); return londonDate(Date.UTC(y,m-1,d,12)-86400000); }

export function senderEmail(msg){
  const a = (msg.senders && msg.senders[0]) || {};
  if (typeof a.actorId==="string" && a.actorId.startsWith("E-")) return a.actorId.slice(2).toLowerCase();
  const di = a.deliveryIdentifier || (a.deliveryIdentifiers && a.deliveryIdentifiers[0]);
  if (di && di.type==="HS_EMAIL_ADDRESS" && di.value) return String(di.value).toLowerCase();
  return null;
}
export function personFromActor(actorId){
  if (typeof actorId==="string" && actorId.startsWith("A-")){ const id=actorId.slice(2); if (USER_BY_ID[id]) return USER_BY_ID[id]; }
  return "—";
}
export function parseATG(subject, text){
  const s=subject||"", t=(text||"").replace(/\r/g," ");
  const platform = /bidspotter/i.test(s+t) ? "BidSpotter" : (/i-bidder/i.test(s+t) ? "i-bidder" : null);
  if (!platform) return null;
  const lot = (s.match(/re lot\s+(\d+)/i)||t.match(/-\s*lot\s+(\d+)/i)||t.match(/\bLot\s+(\d+)\b/))?.[1] || null;
  const email = (t.match(/\bFrom\s+([^\s@]+@[^\s]+?)(?:\s|$)/i))?.[1]?.toLowerCase() || null;
  const name  = (t.match(/\bName\s+(.+?)\s+Phone\b/is))?.[1]?.trim() || null;
  const phone = (t.match(/\bPhone\s+(\+?[\d][\d\s]{6,}\d)/i))?.[1]?.replace(/\s+/g,"") || null;
  const message = (t.match(/\bMessage\s+([\s\S]+?)(?:\s*Please add\b|\s*Metropress\b|$)/i))?.[1]?.trim() || null;
  return { platform, lot, buyerEmail:email, buyerName:name, buyerPhone:phone, message };
}
export function noiseBucket(from, subject, text){
  const f=(from||"").toLowerCase(), s=(subject||"").toLowerCase(), b=(text||"").toLowerCase();
  if (f.includes("googlealerts")) return "Google Alerts";
  if (f.includes("linkedin.com")) return "LinkedIn";
  if (s.includes("auction approved") || ((f.includes("bidspotter")||f.includes("i-bidder")) && !s.includes("enquiry") && (s.includes("approved")||s.includes("registration")))) return "Auction \"approved\"";
  if (/^(automatic reply|out of office|auto)/i.test(s) || s.includes("automatic reply")) return "Auto-replies/bounces";
  if (s.includes("undeliverable")||s.includes("delivery status")||s.includes("mail delivery")||f.includes("mailer-daemon")||f.includes("postmaster")) return "Auto-replies/bounces";
  if (f.includes("onmicrosoft")||f.includes("microsoftexchange")||s.includes("mailbox is almost full")||s.includes("mailbox is full")||s.includes("quarantine")||s.includes("storage limit")||s.includes("password")) return "System / mailbox";
  if (f.includes("govdelivery")||f.includes("find-a-tender")||f.includes("find a tender")||f.includes("due-north")||f.includes("proactis")||f.includes("in-tend")||f.includes("coupa")||f.includes("procontract")||s.includes("tender")||s.includes("funding opportunit")) return "Tender/procurement";
  if (f.includes("ebay.")||f.includes("paypal")||f.includes("@amazon")||f.includes("stripe.com")||s.includes("seller news")) return "Marketplace/platform";
  if (f.includes("pressxchange")||f.includes("newsletter")||f.includes("noreply")||f.includes("no-reply")||f.includes("donotreply")||f.includes("mailchimp")||f.includes("news@")||f.includes("marketing@")||f.includes("@hubspot")||s.includes("newsletter")||s.includes("webinar")||s.includes("unsubscribe")||s.includes("can help drive")) return "Newsletters/marketing";
  if (b.includes("unsubscribe")||b.includes("view in browser")||b.includes("view this email")||b.includes("manage preferences")||b.includes("you received this email")||b.includes("no longer wish to receive")||b.includes("testflight")||b.includes("now open for pre")) return "Newsletters/marketing";
  if ((f.includes("statements@")||f.includes("billing@")||f.includes("accounts@")) && (s.includes("statement")||s.includes("invoice ready")||s.includes("summary"))) return "Statements (auto)";
  if (/[\u{1D400}-\u{1D7FF}]/u.test((subject||"")+" "+(text||""))) return "Spam / other";
  return null;
}
// human-signal gate: stops system/marketing mail sitting in the "partnership" fallback
export function looksHuman(from, text){
  const f=(from||"").toLowerCase(), t=(text||"");
  if (/no-?reply|noreply|donotreply|do-not-reply|notification|notifications@|mailer|postmaster|govdelivery|onmicrosoft|@ebay\.|automated|@hubspot|mailchimp/.test(f)) return false;
  return /\b(hi|hello|dear|thanks|thank you|regards|please|could you|can you|we (have|are|would|'re)|i (am|would|have|'m|'ve)|interested)\b|\?/i.test(t);
}
export function classify(from, subject, text, atg){
  if (atg) return "buyer";
  const blob=((subject||"")+" "+(text||"")).toLowerCase();
  if (/wrong item|missing|damaged|refund|reimburse|complaint|not as (described|pictured)|return(ed)? the funds|not returned|deal with this urgently/.test(blob)) return "complaint";
  if (/collection|collect|rams|collected/.test(blob)) return "collection";
  if (/invoice|statement|payment|paid|figures|buyer number|remittance/.test(blob)) return "payment";
  if (/viewing|view this lot|view the lot|arrange a view|come and view|book a view/.test(blob)) return "viewing";
  if (/asset disposal|surplus|site closure|relocation|clearance|sell (our|my|the)|to sell|for sale|selling|dispose|liquidat|furniture|plant equipment|release value|assets to/.test(blob)) return "seller";
  if (/lot\s*[№#]?\s*\d+|enquiry re lot|is (it|this) working|working\?|reserve|condition|bid on|interested in (this|the)?\s?item|flat pack|does it (include|come|have)/.test(blob)) return "buyer";
  return "partnership";
}

/* Turn one thread + its messages into either a noise hit or an enquiry record. Pure. */
export function processThread(thread, messages, day, nowMs){
  if (thread && thread.spam) return { noise:"Spam / other" };
  const msgs = (messages||[]).filter(m=>m && m.type==="MESSAGE")
    .map(m=>({ ...m, _ts: m.createdAt ? Date.parse(m.createdAt) : 0 }))
    .sort((a,b)=>a._ts-b._ts);
  const enquiry = msgs.find(m=>m.direction==="INCOMING" && londonDate(m._ts)===day);
  if (!enquiry) return null;
  const from = senderEmail(enquiry);
  const subject = enquiry.subject || "";
  const text = enquiry.text || "";
  const nb = noiseBucket(from, subject, text);
  if (nb) return { noise:nb };

  const atg = parseATG(subject, text);
  const cat = classify(from, subject, text, atg);
  if (cat==="partnership" && !looksHuman(from, text)) return { noise:"Other / non-enquiry" };

  // "dealt with" = the team closed the thread once actioned (phone, booking, or reply)
  const reply = msgs.find(m=>m.direction==="OUTGOING" && m._ts > enquiry._ts);
  const handler = reply ? personFromActor(reply.senders && reply.senders[0] && reply.senders[0].actorId) : "—";
  let status = (thread.status==="CLOSED") ? "actioned" : "open";
  if (status==="open" && (nowMs-enquiry._ts)/86400000 > OVERDUE_DAYS) status = "overdue";

  return { enquiry:{
    id: thread.id, cat,
    who: atg?.buyerName || (from ? from.split("@")[0] : (thread.associatedContactId?("Contact "+thread.associatedContactId):"Unknown")),
    subj: (atg ? (atg.platform+" lot "+(atg.lot||"?")) : (subject||"(no subject)")).slice(0,90),
    time: hhmm(enquiry._ts),
    handler, status,
    summary: (atg?.message || text || subject || "").slice(0,400),
    response: reply ? ("Replied "+hhmm(reply._ts)+(handler!=="—"?" by "+handler:"")) : "",
    note: (atg && !atg.buyerName) ? "i-bidder/BidSpotter buyer — name not in enquiry." : "",
    buyerEmail: atg?.buyerEmail || from || null, buyerName: atg?.buyerName||null,
    buyerPhone: atg?.buyerPhone||null, lot: atg?.lot||null, threadStatus: thread.status||null
  }};
}

function json(obj, status){ return new Response(JSON.stringify(obj), { status:status||200,
  headers:{ "Content-Type":"application/json","Cache-Control":"no-store","Access-Control-Allow-Origin":"*" } }); }

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("diagnostics")==="1")
    return json({ ok:true, credentials:{ HUBSPOT_TOKEN:!!HUBSPOT_TOKEN, SUPABASE_URL:!!SUPABASE_URL, SUPABASE_SERVICE_KEY:!!SUPABASE_KEY } });
  if (!HUBSPOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY)
    return json({ error:"Missing one of HUBSPOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY" },500);
  if (url.searchParams.get("inboxes")==="1")
    return json(await hsGet("/conversations/v3/conversations/inboxes"));

  try{
    const now = Date.now();
    const day = url.searchParams.get("date") || yesterdayLondon(now);
    const inbox = url.searchParams.get("inbox") || INBOX_ID;
    const sinceISO = new Date(Date.parse(day+"T00:00:00Z") - 3*3600*1000).toISOString();

    let threads = await listThreads(inbox, sinceISO);
    threads = threads.filter(t=>{
      const rec = t.latestMessageReceivedTimestamp ? Date.parse(t.latestMessageReceivedTimestamp) : (t.latestMessageTimestamp?Date.parse(t.latestMessageTimestamp):0);
      return rec && londonDate(rec)>=day;
    });
    const limit = Number(url.searchParams.get("limit")||0);
    if (limit>0) threads = threads.slice(0, limit);

    const processed = await mapPool(threads, async t=>{
      try { const msgs = await getMessages(t.id); return processThread(t, msgs, day, now); }
      catch(e){ return { error:String(e.message||e) }; }
    }, CONCURRENCY);

    const enquiries=[]; const noise={};
    for (const p of processed){
      if (!p) continue;
      if (p.noise){ noise[p.noise]=(noise[p.noise]||0)+1; continue; }
      if (p.enquiry) enquiries.push(p.enquiry);
    }
    const inbox_replies={};
    for (const e of enquiries) if (e.handler && e.handler!=="—") inbox_replies[e.handler]=(inbox_replies[e.handler]||0)+1;

    const quality=[];
    for (const q of enquiries.filter(x=>x.status==="overdue")) quality.push(["&#9873;","<b>"+q.who+"</b> — "+CAT_LABELS[q.cat]+" open "+OVERDUE_DAYS+"+ days. "+(q.summary||"").slice(0,120)]);
    const nameless = enquiries.filter(x=>x.lot && x.buyerName && x.buyerEmail);
    if (nameless.length) quality.push(["&#9888;", nameless.length+" i-bidder/BidSpotter buyer(s) arrived with name + phone in the enquiry — check the CRM contact captured them (auto-fix is v2)."]);
    for (const q of enquiries.filter(x=>x.status==="open").slice(0,6)) quality.push(["&#9888;","<b>"+q.who+"</b> ("+CAT_LABELS[q.cat]+", "+q.time+") — still open (not actioned). Check it gets dealt with."]);

    const noiseTotal = Object.values(noise).reduce((a,b)=>a+b,0);
    const payload = {
      date: new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(new Date(Date.parse(day+"T00:00:00Z")+12*3600000)),
      generated_at: new Date().toISOString(),
      logged: enquiries.length + noiseTotal,
      replies:{ inbox: inbox_replies },
      outreach:{},
      noise: Object.entries(noise).sort((a,b)=>b[1]-a[1]),
      quality,
      cats: Object.fromEntries(Object.keys(CAT_LABELS).map(k=>[k,{label:CAT_LABELS[k]}])),
      enquiries
    };

    if (url.searchParams.get("dry")==="1")
      return json({ dry:true, report_date:day, inbox, threads_seen:threads.length,
        counts:{ logged:payload.logged, genuine:enquiries.length, actioned:enquiries.filter(e=>e.status==="actioned").length, open:enquiries.filter(e=>e.status!=="actioned").length, noise:noiseTotal }, payload });

    await sbUpsert({ report_date:day, payload });
    return json({ ok:true, report_date:day, genuine:enquiries.length, noise:noiseTotal, written:true });
  } catch(e){
    return json({ error:String((e&&e.message)||e) },500);
  }
};
