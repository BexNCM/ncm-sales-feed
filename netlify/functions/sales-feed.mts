/* =====================================================================
   LotOut Live Sales Report — data feed  (Netlify Function, v2 / .mts)
   Route: /.netlify/functions/sales-feed
   Reads Supabase auctions + costings and HubSpot calls + deals, returns
   the dashboard JSON contract INCLUDING the Activity detail lists
   (recentCalls + noOutcomeCalls). Rate-limited under HubSpot's 4/sec cap.
   ?diagnostics=1 reports credential presence only.
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
const
