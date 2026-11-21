// Server regions: Cloudflare Durable Object location hints. A match is
// created in the region that gives the fairest pings for the players in it
// (see pickRegion), measured from each player's browser.

export const REGIONS = {
  wnam: 'Western North America',
  enam: 'Eastern North America',
  sam: 'South America',
  weur: 'Western Europe',
  eeur: 'Eastern Europe',
  apac: 'Asia-Pacific',
  oc: 'Oceania',
  afr: 'Africa',
  me: 'Middle East',
};

// Best region for a group: the lowest worst-case ping (nobody gets a
// terrible connection), with ties (within 5 ms) broken by total ping.
// `pings` has one { region: ms } object per player; a region someone
// couldn't reach is skipped. Returns { region, worst } or null.
export function pickRegion(pings) {
  const valid = pings.filter((p) => p && Object.keys(p).length);
  if (!valid.length) return null;
  let best = null;
  for (const region of Object.keys(REGIONS)) {
    let worst = 0;
    let total = 0;
    let ok = true;
    for (const p of valid) {
      const ms = p[region];
      if (!Number.isFinite(ms)) {
        ok = false;
        break;
      }
      worst = Math.max(worst, ms);
      total += ms;
    }
    if (!ok) continue;
    if (!best || worst < best.worst - 5 || (Math.abs(worst - best.worst) <= 5 && total < best.total)) {
      best = { region, worst, total };
    }
  }
  return best && { region: best.region, worst: best.worst };
}

// Fallback when nobody has ping data: nearest region by continent.
export const CONTINENT_REGION = { NA: 'enam', SA: 'sam', EU: 'weur', AS: 'apac', OC: 'oc', AF: 'afr', AN: 'oc' };
