/* =====================================================================
   LotOut Live Sales Report — data feed  (Netlify Function, v2 / .mts)
   Route: /.netlify/functions/sales-feed
   Reads Supabase auctions + costings and HubSpot calls + deals, returns
   the dashboard JSON contract INCLUDING the Activity detail lists
   (recentCalls + noOutcomeCalls) with call direction. Rate-limited under
   HubSpot's 4/sec cap. ?diagnostics=1 reports credential presence only.
   ===================================================================== */

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const PORTAL = "26951047";
const WINDOW_DAYS = 14;
const OVERDUE_AFTER_DAYS = 1;
const MIN_GAP_MS = 300;
const RECENT_MAX = 12;
const NOOUT_MAX  = 15;

const REPS = [
  { id:"29383896",  name:"Neil Rayner",    initials:"NR", role:"National Business Development Manager" },
  { id:"896985590", name:"Amy Rutherford", initials:"AR", role:"Partnerships Lead" },
  { id:"897221581", name:"Emma Humble",    initials:"EH", role:"Head of Partnerships" }
];
const SOURCERS = [
  { id:"1883899423", name:"Ross Gilfillan", initials:"RG" },
  { id:"78639512",   name:"Elliot Corney",  initials:"EC" }
];
const SOURCED_BY = ["1883899423","78639512"];

const D_CONNECTED   = "f240bbac-87c9-4f6e-bf70-924b57d47db7";
const D_VOICEMAIL   = "500f182a-5b5b-470b-87fc-efe134c7dd8c";
const D_BOOKED_PRES = "7314743c-20c3-49a8-8991-02d909acedf3";
const DM_OUTCOMES = [
  "5990e369-3250-4045-afec-07515dc528da", "779932b4-ec9a-4f59-8eb4-662ee268de68",
  "7314743c-20c3-49a8-8991-02d909acedf3", "9a27a880-d6d3-4ac1-a118-c9e11eac1f5d",
  "8611f9dc-50e2-4af1-81af-1aaca36f8119", "0a8578ae-0252-49e7-a311-f7eaae89b6dc",
  "6f7c1694-ea19-4d7a-9cba-a5ec85dacb7f"
];
const CONNECTED_OUTCOMES = new Set([D_CONNECTED, ...DM_OUTCOMES]);
const DM_SET = new Set(DM_OUTCOMES);
const STAGE_NEW_LEAD    = "2685757647";
const STAGE_FIRST_TOUCH = "2685757651";
const OUTCOME_LABELS = {
  "500f182a-5b5b-470b-87fc-efe134c7dd8c":"Left voicemail",
  "c7a99ae2-7fed-4872-b5e9-f2c1ed428997":"No answer",
  "cfc8b370-e227-45ff-8f45-18f8efb740cc":"Requires attention",
  "5990e369-3250-4045-afec-07515dc528da":"Resolved",
  "779932b4-ec9a-4f59-8eb4-662ee268de68":"Requires further information",
  "7314743c-20c3-49a8-8991-02d909acedf3":"Booked Presentation",
  "9a27a880-d6d3-4ac1-a118-c9e11eac1f5d":"Has Collective Assets",
  "8611f9dc-50e2-4af1-81af-1aaca36f8119":"Sent terms",
  "0a8578ae-0252-49e7-a311-f7eaae89b6dc":"New Exclusive Deal",
  "6f7c1694-ea19-4d7a-9cba-a5ec85dacb7f":"New Collective Deal",
  "4686ce01-e640-4bed-8a0d-ac9322f56416":"Not interested",
  "f240bbac-87c9-4f6e-bf70-924b57d47db7":"Connected"
};

const sleep = ms => new Promise(r=>setTimeout(r,ms));
let lastStart = 0;
async function gate(){
  const now = Date.now();
  const wait = Math.max(0, lastStart + MIN_GAP_MS - now);
  lastStart = now + wait;
  if (wait) await sleep(wait);
}
function workingDaysBetween(from, to){
  let d = new Date(from), n = 0;
  while (d < to){ const w = d.getUTCDay(); if (w!==0 && w!==6) n++; d = new Date(d.getTime()+86400000); }
  return Math.max(n,1);
}
function startOfUTCDay(ms){ const d=new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
function dayKey(ms){ return new Date(ms).toISOString().slice(0,10); }
function shortDate(ms){ return ms ? new Date(ms).toLocaleDateString("en-GB",{day:"2-digit",month:"short"}) : ""; }

async function hsPost(path, body){
  for (let attempt=0; attempt<6; attempt++){
    await gate();
    const r = await fetch("https://api.hubapi.com"+path, {
      method:"POST",
      headers:{ "Authorization":"Bearer "+HUBSPOT_TOKEN, "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });
    if (r.status === 429){ const ra = Number(r.headers.get("retry-after"))||1; await sleep(ra*1000+250); continue; }
    if (!r.ok) throw new Error("HubSpot "+path+" "+r.status+" "+(await r.text()).slice(0,300));
    return r.json();
  }
  throw new Error("HubSpot rate limit: retries exhausted on "+path);
}
async function callsForOwner(ownerId, sinceMs, untilMs){
  const out = []; let after;
  do {
    const j = await hsPost("/crm/v3/objects/calls/search", {
      filterGroups:[{ filters:[
        { propertyName:"hubspot_owner_id", operator:"EQ", value: ownerId },
        { propertyName:"hs_timestamp", operator:"GTE", value: String(sinceMs) },
        { propertyName:"hs_timestamp", operator:"LTE", value: String(untilMs) }
      ]}],
      properties:["hs_call_disposition","hs_timestamp","hs_call_duration","hs_call_direction"],
      limit:100, ...(after?{after}:{})
    });
    for (const o of (j.results||[])) out.push({
      id:o.id,
      dispo:o.properties.hs_call_disposition || null,
      dir: o.properties.hs_call_direction || null,
      ts: o.properties.hs_timestamp ? Date.parse(o.properties.hs_timestamp) : null,
      dur: Number(o.properties.hs_call_duration||0)
    });
    after = j.paging && j.paging.next && j.paging.next.after;
  } while (after);
  return out;
}
async function assocMap(callIds, toType){
  const map = {};
  for (let i=0;i<callIds.length;i+=100){
    const inputs = callIds.slice(i,i+100).map(id=>({id}));
    try {
      const j = await hsPost("/crm/v4/associations/calls/"+toType+"/batch/read", { inputs });
      for (const row of (j.results||[])){ const to = row.to && row.to[0]; if (to) map[row.from.id] = String(to.toObjectId); }
    } catch(e){}
  }
  return map;
}
async function readObjects(objType, ids, props){
  const map = {};
  const uniq = [...new Set(ids)].filter(Boolean);
  for (let i=0;i<uniq.length;i+=100){
    const inputs = uniq.slice(i,i+100).map(id=>({id}));
    try {
      const j = await hsPost("/crm/v3/objects/"+objType+"/batch/read", { properties:props, inputs });
      for (const o of (j.results||[])) map[o.id] = o.properties || {};
    } catch(e){}
  }
  return map;
}
async function dealSearch(filters, properties){
  const out = []; let after;
  do {
    const j = await hsPost("/crm/v3/objects/deals/search", { filterGroups:[{filters}], properties, limit:100, ...(after?{after}:{}) });
    for (const o of (j.results||[])) out.push(o);
    after = j.paging && j.paging.next && j.paging.next.after;
  } while (after);
  return out;
}
async function dealCount(filters){
  const j = await hsPost("/crm/v3/objects/deals/search", { filterGroups:[{filters}], limit:1 });
  return j.total || 0;
}

async function sbGet(pathQuery){
  const r = await fetch(SUPABASE_URL+"/rest/v1/"+pathQuery, { headers:{ apikey:SUPABASE_KEY, Authorization:"Bearer "+SUPABASE_KEY } });
  if (!r.ok) throw new Error("Supabase "+r.status+" "+(await r.text()).slice(0,200));
  return r.json();
}

function callMetrics(calls, companyMap, workingDays, weeks){
  let dials=0, connected=0, dm=0, pres=0, vm=0, needs=0, durSum=0;
  const companyDay = new Set();
  for (const c of calls){
    dials++; durSum += c.dur;
    if (!c.dispo) needs++;
    if (CONNECTED_OUTCOMES.has(c.dispo)) connected++;
    if (DM_SET.has(c.dispo)) dm++;
    if (c.dispo===D_BOOKED_PRES) pres++;
    if (c.dispo===D_VOICEMAIL) vm++;
    const co = companyMap[c.id];
    if (co && c.ts) companyDay.add(dayKey(c.ts)+"|"+co);
  }
  return {
    dialsPerDay: dials/workingDays, companiesPerDay: companyDay.size/workingDays,
    dmPerDay: dm/workingDays, presPerWeek: pres/weeks, presBooked: pres,
    connectRate: dials? Math.round(connected/dials*100):0,
    voicemailPct: dials? Math.round(vm/dials*100):0,
    avgDurationS: dials? Math.round(durSum/dials/1000):0, needsOutcome: needs
  };
}
function lotoutFor(name, auctions, costings){
  const mine = auctions.filter(a=>a.sales_lead===name);
  const stages = {}; let fh = 0;
  for (const a of mine){ stages[a.stage]=(stages[a.stage]||0)+1; fh += Number(a.forecast_hammer||0); }
  const cs = costings.filter(c=>c.sales_lead===name);
  const costingsBy = { Draft:0, Submitted:0, Approved:0 };
  for (const c of cs){ if (costingsBy[c.status]!=null) costingsBy[c.status]++; }
  return { jobsAsLead: mine.length, stages, jobForecast: fh, costings: costingsBy };
}
function json(obj, status){
  return new Response(JSON.stringify(obj), {
    status: status||200,
    headers:{ "Content-Type":"application/json", "Cache-Control":"no-store", "Access-Control-Allow-Origin":"*" }
  });
}

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("diagnostics") === "1"){
    return json({ ok:true, credentials:{ HUBSPOT_TOKEN: !!HUBSPOT_TOKEN, SUPABASE_URL: !!SUPABASE_URL, SUPABASE_SERVICE_KEY: !!SUPABASE_KEY } });
  }
  if (!HUBSPOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY){
    return json({ error:"Missing one of HUBSPOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY" }, 500);
  }
  try {
    const now = Date.now();
    const sinceMs = now - WINDOW_DAYS*86400000;
    const workingDays = workingDaysBetween(sinceMs, now);
    const weeks = workingDays/5;
    const overdueCut = startOfUTCDay(now) - OVERDUE_AFTER_DAYS*86400000;
    const yStart = startOfUTCDay(now) - 86400000;
    const yEnd   = startOfUTCDay(now);

    const [auctions, costings] = await Promise.all([
      sbGet("auctions?select=sales_lead,stage,status,forecast_hammer&status=eq.active"),
      sbGet("costings?select=sales_lead,status,forecast_hammer")
    ]);

    const reps = [];
    for (const rep of REPS){
      const calls = await callsForOwner(rep.id, sinceMs, now);
      const companyMap = await assocMap(calls.map(c=>c.id), "companies");
      const cm = callMetrics(calls, companyMap, workingDays, weeks);

      const sorted = calls.slice().sort((a,b)=>(b.ts||0)-(a.ts||0));
      const recent = sorted.slice(0, RECENT_MAX);
      const noOut  = sorted.filter(c=>!c.dispo).slice(0, NOOUT_MAX);
      const detailIds = [...new Set([...recent, ...noOut].map(c=>c.id))];
      const contactAssoc = await assocMap(detailIds, "contacts");
      const contactNames = await readObjects("contacts", Object.values(contactAssoc), ["firstname","lastname"]);
      const companyNames = await readObjects("companies", detailIds.map(id=>companyMap[id]), ["name"]);
      const rowOf = c => {
        const ct = contactAssoc[c.id] ? contactNames[contactAssoc[c.id]] : null;
        const coId = companyMap[c.id];
        const co = coId ? companyNames[coId] : null;
        return {
          at: shortDate(c.ts),
          direction: c.dir==="INBOUND" ? "in" : (c.dir==="OUTBOUND" ? "out" : ""),
          contact: ct ? (((ct.firstname||"")+" "+(ct.lastname||"")).trim() || "Unknown") : "Unknown",
          company: co && co.name ? co.name : "Unknown",
          durationS: Math.round(c.dur/1000),
          url: contactAssoc[c.id] ? "https://app-eu1.hubspot.com/contacts/"+PORTAL+"/record/0-1/"+contactAssoc[c.id] : (coId ? "https://app-eu1.hubspot.com/contacts/"+PORTAL+"/record/0-2/"+coId : "https://app-eu1.hubspot.com/contacts/"+PORTAL+"/objects/0-48/views/all/list")
        };
      };
      const recentCalls = recent.map(c => ({ ...rowOf(c), outcome: OUTCOME_LABELS[c.dispo] || (c.dispo ? "Logged" : "No outcome") }));
      const noOutcomeCalls = noOut.map(rowOf);

      const sd = await dealSearch([
        { propertyName:"sourced_by", operator:"IN", values:SOURCED_BY },
        { propertyName:"hubspot_owner_id", operator:"EQ", value:rep.id },
        { propertyName:"hs_is_closed", operator:"EQ", value:"false" }
      ], ["dealstage","createdate"]);
      let allocated = sd.length, firstTouch = 0, overdue = 0;
      for (const d of sd){
        const st = d.properties.dealstage;
        const cd = d.properties.createdate ? Date.parse(d.properties.createdate) : 0;
        if (st===STAGE_FIRST_TOUCH) firstTouch++;
        if (st===STAGE_NEW_LEAD && cd < overdueCut) overdue++;
      }

      reps.push({
        name:rep.name, role:rep.role, initials:rep.initials, ...cm,
        sourced:{ allocated, awaiting: allocated - firstTouch, overdue,
                  firstTouchPct: allocated? Math.round(firstTouch/allocated*100):0 },
        lotout: lotoutFor(rep.name, auctions, costings),
        recentCalls, noOutcomeCalls
      });
    }

    const sourcers = [];
    for (const s of SOURCERS){
      const base = [{ propertyName:"sourced_by", operator:"EQ", value:s.id }];
      const sourcedYesterday = await dealCount([...base,
        { propertyName:"createdate", operator:"GTE", value:String(yStart) },
        { propertyName:"createdate", operator:"LT",  value:String(yEnd) }]);
      const openPool = await dealCount([...base, { propertyName:"hs_is_closed", operator:"EQ", value:"false" }]);
      const own = await dealSearch([...base,
        { propertyName:"hubspot_owner_id", operator:"EQ", value:s.id },
        { propertyName:"hs_is_closed", operator:"EQ", value:"false" }], ["dealstage","createdate"]);
      let unallocated = own.length, unallocatedOverdue = 0;
      for (const d of own){
        if (d.properties.dealstage===STAGE_NEW_LEAD){
          const cd = d.properties.createdate ? Date.parse(d.properties.createdate) : 0;
          if (cd < overdueCut) unallocatedOverdue++;
        }
      }
      sourcers.push({ name:s.name, initials:s.initials, sourcedYesterday, openPool, unallocated, unallocatedOverdue });
    }

    return json({
      generated_at: new Date().toISOString(),
      period: { label:"trailing "+WINDOW_DAYS+" days", working_days:workingDays, weeks:Number(weeks.toFixed(1)) },
      targets: { companiesPerDay:25, dmPerDay:3, presPerWeek:5 },
      sourcers, reps
    });
  } catch (e){
    return json({ error: String((e && e.message) || e) }, 500);
  }
};
