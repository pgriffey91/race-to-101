// netlify/functions/ros-projections.js
//
// Serverless proxy + consensus blender for rest-of-season (ROS) player projections.
// Sources: FantasyPros (real API, free tier — see caveat below) + ESPN's public,
// undocumented, keyless fantasy-projections feed. Runs server-side only — this is what
// keeps your FantasyPros key out of the browser (ESPN's endpoint needs no key at all).
//
// Required environment variable (set in Netlify's dashboard, Site configuration ->
// Environment variables — NEVER commit this to your repo):
//   FANTASYPROS_API_KEY
//
// FANTASYPROS FREE-TIER CAVEAT
// FantasyPros' own terms say free API access is "limited to non-production use" — building,
// testing, and prototyping. A live tool your league uses all season plausibly counts as
// production, which by their terms needs a paid HOF subscription for Premium API access.
// Start on the free key while you build/test; budget for HOF if you keep this running live.
// Request a key at: https://secure.fantasypros.com/api-keys/request/
//
// VERIFY comments mark anything I could not confirm against a live response from my
// environment (no live test call was possible). Log the raw JSON from each provider on your
// first real call and check field names against what's below before trusting the output.

const SLEEPER_PLAYERS_URL = 'https://api.sleeper.app/v1/players/nfl';

// VERIFY: confirmed to exist per FantasyPros' own endpoint list ("Weekly & rest-of-season
// player projections with full stat lines" at GET /nfl/{season}/projections) — but I have not
// seen a live response, so the exact query params for "rest of season" vs "weekly" and the
// response envelope below are my best reconstruction, not a verified contract.
const FANTASYPROS_URL = (season) =>
  `https://api.fantasypros.com/public/v2/json/nfl/${season}/projections?type=ROS`;

// ESPN's public "league defaults" player pool — undocumented, but widely used by community
// tools and requires no auth/cookie for this specific (non-private-league) endpoint. Returns
// projected + actual stats for every rostered-eligible player league-wide.
const ESPN_URL = (season) =>
  `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`;
const ESPN_FILTER_HEADER = JSON.stringify({
  players: { limit: 3000, sortPercOwned: { sortPriority: 1, sortAsc: false } }
});
// VERIFY: ESPN's stats array is a mix of actual + projected entries per player, distinguished
// by statSourceId (0 = actual, 1 = projection) and statSplitTypeId (0 = season total). This is
// the convention documented by several community ESPN API clients, not an official spec.
const ESPN_PROJECTED_SOURCE_ID = 1;
const ESPN_SEASON_SPLIT_ID = 0;

let sleeperPlayerCache = null; // in-memory cache, lives for the function's warm lifetime only

async function getSleeperPlayers() {
  if (sleeperPlayerCache) return sleeperPlayerCache;
  const res = await fetch(SLEEPER_PLAYERS_URL);
  if (!res.ok) throw new Error(`Sleeper players fetch failed: ${res.status}`);
  sleeperPlayerCache = await res.json(); // { [sleeper_id]: { fantasy_data_id, search_full_name, ... } }
  return sleeperPlayerCache;
}

function normalizeNameForMatch(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Build a name -> sleeper_id index. Name matching is inherently fuzzier than a shared numeric
// ID (suffix handling, "D.J." vs "DJ", etc.) -- this covers the common cases but won't be
// perfect. Log unmatched players during testing and special-case them if it matters to you.
function buildNameIndex(sleeperPlayers) {
  const bySearchName = new Map();
  for (const [sleeperId, p] of Object.entries(sleeperPlayers)) {
    if (p.search_full_name) bySearchName.set(p.search_full_name, sleeperId);
    else if (p.full_name) bySearchName.set(normalizeNameForMatch(p.full_name), sleeperId);
  }
  return bySearchName;
}

async function fetchFantasyProsProjections(season) {
  const apiKey = process.env.FANTASYPROS_API_KEY;
  if (!apiKey) return null; // gracefully degrade if the key isn't configured
  try {
    const res = await fetch(FANTASYPROS_URL(season), {
      headers: { 'x-api-key': apiKey }
    });
    if (!res.ok) {
      console.error(`FantasyPros fetch failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    // VERIFY: adjust to the real envelope -- this assumes { players: [{ player_name, fpts, ... }] }
    return (data.players || []).map(p => ({
      rosPts: Number(p.fpts ?? p.proj_pts ?? p.points),
      searchName: normalizeNameForMatch(p.player_name)
    })).filter(p => Number.isFinite(p.rosPts));
  } catch (err) {
    console.error('FantasyPros fetch threw:', err);
    return null;
  }
}

async function fetchEspnProjections(season) {
  try {
    const res = await fetch(ESPN_URL(season), {
      headers: { 'X-Fantasy-Filter': ESPN_FILTER_HEADER }
    });
    if (!res.ok) {
      console.error(`ESPN fetch failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const players = (data.players || []).map(entry => entry.player).filter(Boolean);
    return players.map(p => {
      const projStat = (p.stats || []).find(s =>
        s.statSourceId === ESPN_PROJECTED_SOURCE_ID && s.statSplitTypeId === ESPN_SEASON_SPLIT_ID
      );
      // VERIFY: appliedTotal is ESPN's own precomputed point total under whatever scoring
      // ruleset this "leaguedefaults" view uses -- it's an approximation of your league's exact
      // custom scoring, not a guaranteed match, similar to the pts_ppr fallback used elsewhere.
      const rosPts = projStat ? Number(projStat.appliedTotal) : null;
      const fullName = p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim();
      return { rosPts, searchName: normalizeNameForMatch(fullName) };
    }).filter(p => Number.isFinite(p.rosPts));
  } catch (err) {
    console.error('ESPN fetch threw:', err);
    return null;
  }
}

exports.handler = async function (event) {
  try {
    const season = (event.queryStringParameters && event.queryStringParameters.season) || new Date().getFullYear();

    const sleeperPlayers = await getSleeperPlayers();
    const bySearchName = buildNameIndex(sleeperPlayers);

    const [fpData, espnData] = await Promise.all([
      fetchFantasyProsProjections(season),
      fetchEspnProjections(season)
    ]);

    // sleeper_id -> { fpPts, espnPts }
    const bySleeperId = {};

    (fpData || []).forEach(p => {
      const sleeperId = bySearchName.get(p.searchName);
      if (!sleeperId) return;
      bySleeperId[sleeperId] = bySleeperId[sleeperId] || {};
      bySleeperId[sleeperId].fpPts = p.rosPts;
    });

    (espnData || []).forEach(p => {
      const sleeperId = bySearchName.get(p.searchName);
      if (!sleeperId) return;
      bySleeperId[sleeperId] = bySleeperId[sleeperId] || {};
      bySleeperId[sleeperId].espnPts = p.rosPts;
    });

    const output = {};
    for (const [sleeperId, pts] of Object.entries(bySleeperId)) {
      const meta = sleeperPlayers[sleeperId] || {};
      const values = [pts.fpPts, pts.espnPts].filter(v => typeof v === 'number' && !Number.isNaN(v));
      if (values.length === 0) continue;
      const consensusRosPts = values.reduce((a, b) => a + b, 0) / values.length;

      output[sleeperId] = {
        name: meta.full_name || `${meta.first_name || ''} ${meta.last_name || ''}`.trim() || sleeperId,
        pos: (meta.fantasy_positions && meta.fantasy_positions[0]) || meta.position || null,
        consensusRosPts: Math.round(consensusRosPts * 100) / 100,
        fpPts: pts.fpPts ?? null,
        espnPts: pts.espnPts ?? null,
        sources: values.length // 1 = single-source fallback, 2 = true consensus
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // cache at the CDN edge so repeat client loads don't re-trigger this function
        // (and don't re-spend your FantasyPros quota) -- tune the max-age to your update cadence
        'Cache-Control': 'public, max-age=21600' // 6 hours
      },
      body: JSON.stringify({ season, generatedAt: new Date().toISOString(), players: output })
    };
  } catch (err) {
    console.error('ros-projections function failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
