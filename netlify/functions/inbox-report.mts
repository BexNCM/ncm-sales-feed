/* =====================================================================
   LotOut Inbox Report — data feed  (Netlify Function, .mts)
   Route: /.netlify/functions/inbox-report
   Pulls yesterday's inbound + sent emails from HubSpot, strips noise,
   parses i-bidder / BidSpotter enquiries into buyer detail, classifies
   the rest, matches replies to work out received vs responded, and
   upserts ONE row into Supabase public.inbox_reports (one per day).
   ?diagnostics=1  -> credential presence only
   ?dry=1          -> return the payload WITHOUT writing to Supabase
   ?date=YYYY-MM-DD-> run for a specific day (defaults to yesterday, London)
   Read-only against HubSpot. Does not write back to the CRM.
   ===================================================================== */

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const MIN_GAP_MS = 300;                 // HubSpot 4/sec cap, same as sales-feed
const OVERDUE_DAYS = 3;                  // an open complaint/refund older than this = overdue

// info@ shared-inbox sends are attributed via hs_created_by (HubSpot user id).
// Verify these against your users if a name looks wrong.
const USER_BY_ID = {
  "78639512":"Elliot Corney", "51982711":"Anthony Worth", "51110999":"Emma Humble",
  "51108339":"Amy Rutherford", "65901157":"Ross Gilfillan", "29383896":"Neil Rayner",
  "50019395":"Andy Smith"
};
// Individual send addresses map straight to a person.
const PERSON_BY_ADDR = {
  "neil@ncmauctions.co.uk":"Neil Rayner", "emma.humble@ncmauctions.co.uk":"Emma Humble",
  "amy@ncmauctions.co.uk":"Amy Rutherford", "anthony@ncmauctions.co.uk":"Anthony Worth",
  "ross@ncmauctions.co.uk":"Ross Gilfillan", "elliot@ncmauctions.co.uk":"Elliot Corney",
  "andy@ncmauctions.co.uk":"Andy Smith"
};

const CAT_LABELS = {
  buyer:"Buyer & lot", seller:"Seller leads", collection:"Collections/RAMS",
  payment:"Payments/invoices", viewing:"Viewings", complaint:"Complaints", partnership:"Partnerships"
};

const sleep = ms => new Promise(r=>setTimeout(r,ms));
let lastStart = 0;
async function gate(){ const now=Date.now(); const wait=Math.max(0,lastStart+MIN_GAP_MS-now); lastStart=now+wait; if(wait) await sleep(wait); }

async function hsPost(path, body){
  for (let attempt=0; attempt<6; attempt++){
    await gate();
    const r = await fetch("https://api.hubapi.com"+path, {
      method:"POST",
      headers:{ "Authorization":"Bearer "+HUBSPOT_TOKEN, "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });
    if (r.status===429){ const ra=Number(r.headers.get("retry-after"))||1; await sleep(ra*1000+250); continue; }
    if (!r.ok) throw new Error("HubSpot "+path+" "+r.status+" "+(await r.text()).slice(0,300));
    return r.json();
  }
  throw new Error("HubSpot rate limit: retries exhausted on "+path);
}
async function emailSearch(direction, sinceMs, untilMs){
  const out=[]; let after;
  do{
    const j = await hsPost("/crm/v3/objects/emails/search", {
      filterGroups:[{ filters:[
        { propertyName:"hs_email_direction", operator:"EQ", value:direction },
        { propertyName:"hs_timestamp", operator:"GTE", value:String(sinceMs) },
        { propertyName:"hs_timestamp", operator:"LT",  value:String(untilMs) }
      ]}],
      properties:["hs_email_subject","hs_email_direction","hs_email_from_email","hs_email_to_email","hs_timestamp","hs_email_text","hs_created_by"],
      limit:100, ...(after?{after}:{})
    });
    for (const o of (j.results||[])){
      const p=o.properties||{};
      out.push({
        id:o.id, subject:p.hs_email_subject||"", from:(p.hs_email_from_email||"").toLowerCase(),
        to:(p.hs_email_to_email||"").toLowerCase(), ts:p.hs_timestamp?Date.parse(p.hs_timestamp):null,
        text:p.hs_email_text||"", createdBy:p.hs_created_by||null
      });
    }
    after = j.paging && j.paging.next && j.paging.next.after;
  } while(after);
  return out;
}
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
function yesterdayLondon(now){
  const [y,m,d] = londonDate(now).split("-").map(Number);
  const noonYesterdayish = Date.UTC(y,m-1,d,12) - 86400000; // noon avoids DST edges
  return londonDate(noonYesterdayish);
}
function normSubj(s){ return (s||"").replace(/^(re|fw|fwd)\s*:\s*/i,"").replace(/^(re|fw|fwd)\s*:\s*/i,"").trim().toLowerCase(); }

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

export function noiseBucket(from, subject){
  const f=(from||"").toLowerCase(), s=(subject||"").toLowerCase();
  if (f.includes("googlealerts")) return "Google Alerts";
  if (s.includes("auction approved") || ((f.includes("bidspotter")||f.includes("i-bidder")) && !s.includes("enquiry") && (s.includes("approved")||s.includes("registration")))) return "Auction \"approved\"";
  if (f.includes("linkedin.com")) return "LinkedIn";
  if (/^(automatic reply|out of office|auto)/i.test(s) || s.includes("automatic reply")) return "Auto-replies/bounces";
  if (s.includes("undeliverable")||s.includes("delivery status")||s.includes("mail delivery")||f.includes("mailer-daemon")||f.includes("postmaster")) return "Auto-replies/bounces";
  if (f.includes("find-a-tender")||f.includes("find a tender")||f.includes("due-north")||f.includes("proactis")||f.includes("in-tend")||f.includes("coupa")||f.includes("procontract")||s.includes("tender")) return "Tender/procurement";
  if (f.includes("newsletter")||f.includes("noreply@")||f.includes("no-reply@")||f.includes("mailchimp")||f.includes("news@")||f.includes("marketing@")) return "Newsletters/marketing";
  // stylised unicode-heavy cold openers = spam
  if (/[\u{1D400}-\u{1D7FF}]/u.test(subject+ " " + (s))) return "Spam / other";
  return null; // genuine
}

export function classify(from, subject, text, atg){
  if (atg) return "buyer";
  const s=(subject||"").toLowerCase(), t=(text||"").toLowerCase(), blob=s+" "+t;
  if (/wrong item|missing|damaged|refund|complaint|not as (described|pictured)/.test(blob)) return "complaint";
  if (/collection|collect|rams|collected|au1\d{4}/.test(blob)) return "collection";
  if (/invoice|statement|payment|paid|figures|buyer number|remittance/.test(blob)) return "payment";
  if (/viewing|view this|view the|arrange a view/.test(blob)) return "viewing";
  if (/asset disposal|surplus|site closure|relocation|clearance|sell (our|my|the)|dispose|liquidat|furniture|plant equipment|release value|assets to/.test(blob)) return "seller";
  if (/lot\s+\d+|enquiry re lot|is (it|this) working|reserve|condition|bid on/.test(blob)) return "buyer";
  return "partnership";
}
function personFromSend(e){
  if (PERSON_BY_ADDR[e.from]) return PERSON_BY_ADDR[e.from];
  if (e.from && e.from.includes("info@ncmauctions") && e.createdBy && USER_BY_ID[e.createdBy]) return USER_BY_ID[e.createdBy];
  if (e.createdBy && USER_BY_ID[e.createdBy]) return USER_BY_ID[e.createdBy];
  return "—";
}
function isOutreach(e){
  const s=(e.subject||"").toLowerCase();
  return e.from.includes("ncmassetmanagement") || /^ncm x /i.test(e.subject||"") || s.includes("asset opportunity") || s.includes("site closure") || s.includes("asset strategy");
}

function json(obj, status){
  return new Response(JSON.stringify(obj), { status:status||200,
    headers:{ "Content-Type":"application/json","Cache-Control":"no-store","Access-Control-Allow-Origin":"*" } });
}

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("diagnostics")==="1")
    return json({ ok:true, credentials:{ HUBSPOT_TOKEN:!!HUBSPOT_TOKEN, SUPABASE_URL:!!SUPABASE_URL, SUPABASE_SERVICE_KEY:!!SUPABASE_KEY } });
  if (!HUBSPOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY)
    return json({ error:"Missing one of HUBSPOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY" },500);

  try{
    const now = Date.now();
    const day = url.searchParams.get("date") || yesterdayLondon(now);
    // generous UTC window around the London day, then filter precisely in code
    const dayStartUTC = Date.parse(day+"T00:00:00Z");
    const sinceMs = dayStartUTC - 3*3600*1000;
    const untilMs = dayStartUTC + 27*3600*1000;

    const [incomingRaw, sentRaw] = await Promise.all([
      emailSearch("INCOMING_EMAIL", sinceMs, untilMs),
      emailSearch("EMAIL", sinceMs, untilMs)
    ]);
    const incoming = incomingRaw.filter(e=>e.ts && londonDate(e.ts)===day);
    const sent     = sentRaw.filter(e=>e.ts && londonDate(e.ts)===day);

    // reply matching: index sent by recipient and by normalised subject
    const sentByTo = new Map();     // recipient email -> sent[]
    const sentBySubj = new Map();   // normalised subject -> sent[]
    for (const e of sent){
      for (const addr of e.to.split(/[;,]/).map(x=>x.trim()).filter(Boolean)){
        if (!sentByTo.has(addr)) sentByTo.set(addr,[]); sentByTo.get(addr).push(e);
      }
      const k=normSubj(e.subject); if(!sentBySubj.has(k)) sentBySubj.set(k,[]); sentBySubj.get(k).push(e);
    }
    const matchReply = (buyerEmail, subject) => {
      let cands = buyerEmail && sentByTo.get(buyerEmail);
      if (!cands || !cands.length) cands = sentBySubj.get(normSubj(subject));
      if (!cands || !cands.length) return null;
      return cands.sort((a,b)=>(b.ts||0)-(a.ts||0))[0];
    };

    const enquiries=[]; const noise={}; let genuineCount=0;
    for (const e of incoming){
      const nb = noiseBucket(e.from, e.subject);
      if (nb){ noise[nb]=(noise[nb]||0)+1; continue; }
      genuineCount++;
      const atg = parseATG(e.subject, e.text);
      const cat = classify(e.from, e.subject, e.text, atg);
      const buyerEmail = atg?.buyerEmail || e.from;
      const who = atg?.buyerName || (e.from.split("@")[0]) || "Unknown";
      const reply = matchReply(buyerEmail, e.subject);
      let status = reply ? "responded" : "open";
      const ageDays = (now - e.ts)/86400000;
      if (!reply && (cat==="complaint") && ageDays>OVERDUE_DAYS) status="overdue";
      const handler = reply ? personFromSend(reply) : "—";
      enquiries.push({
        id:e.id, cat, who,
        subj: (atg? (atg.platform+" lot "+(atg.lot||"?")) : (e.subject||"(no subject)")).slice(0,90),
        time: new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",hour:"2-digit",minute:"2-digit"}).format(new Date(e.ts)),
        handler, status,
        summary: (atg?.message || e.subject || "").slice(0,400),
        response: reply ? ("Replied "+new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",hour:"2-digit",minute:"2-digit"}).format(new Date(reply.ts))+(handler!=="—"?" by "+handler:"")) : "",
        note: (atg && atg.buyerName ? "" : (atg? "i-bidder/BidSpotter buyer — name not in enquiry." : "")),
        buyerEmail, buyerName:atg?.buyerName||null, buyerPhone:atg?.buyerPhone||null, lot:atg?.lot||null
      });
    }

    // reply + outreach tallies by sender (from sent items)
    const inbox={}, outreach={};
    for (const e of sent){
      const person = personFromSend(e);
      if (isOutreach(e)){ const key = e.from.includes("ncmassetmanagement") ? "Ross (for Emma)" : person; outreach[key]=(outreach[key]||0)+1; }
      else { const k=normSubj(e.subject); if (sentBySubj.has(k)) { inbox[person]=(inbox[person]||0)+1; } }
    }

    // auto quality flags
    const quality=[];
    for (const q of enquiries.filter(x=>x.status==="overdue")) quality.push(["&#9873;","<b>"+q.who+"</b> — "+CAT_LABELS[q.cat]+" open "+OVERDUE_DAYS+"+ days. "+ (q.summary||"")]);
    const namelessAtg = enquiries.filter(x=>x.lot && x.buyerName && x.buyerEmail);
    if (namelessAtg.length) quality.push(["&#9888;", namelessAtg.length+" i-bidder/BidSpotter buyer(s) came in with name + phone in the enquiry — make sure the CRM contact captured them (auto-fix is v2)."]);
    for (const q of enquiries.filter(x=>x.status==="open" && x.cat!=="complaint").slice(0,5)) quality.push(["&#9888;","<b>"+q.who+"</b> ("+CAT_LABELS[q.cat]+", "+q.time+") — no reply matched. Check it was handled."]);

    const payload = {
      date: new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(new Date(dayStartUTC+12*3600000)),
      generated_at: new Date().toISOString(),
      logged: incoming.length,
      replies:{ inbox },
      outreach,
      noise: Object.entries(noise).sort((a,b)=>b[1]-a[1]),
      quality,
      cats: Object.fromEntries(Object.keys(CAT_LABELS).map(k=>[k,{label:CAT_LABELS[k]}])),
      enquiries
    };

    if (url.searchParams.get("dry")==="1")
      return json({ dry:true, report_date:day, counts:{ logged:payload.logged, genuine:genuineCount, responded:enquiries.filter(e=>e.status==="responded").length, open:enquiries.filter(e=>e.status!=="responded").length }, payload });

    await sbUpsert({ report_date:day, payload });
    return json({ ok:true, report_date:day, logged:payload.logged, genuine:genuineCount, written:true });
  } catch(e){
    return json({ error:String((e&&e.message)||e) },500);
  }
};
