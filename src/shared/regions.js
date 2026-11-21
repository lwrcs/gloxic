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

// Region hints are best effort: Cloudflare runs a region's servers in the
// nearest place it can host them (e.g. "sam" has been running in Ashburn,
// Virginia; "afr" in Madrid; "me" in Milan). The pick is still right, since it
// uses measured pings, but labels must come from the datacenter the server
// actually reports (an airport code), never from the hint's name.
export const COLO_PLACES = {
  // North America
  IAD: 'Ashburn, US', EWR: 'Newark, US', ATL: 'Atlanta, US', ORD: 'Chicago, US', DFW: 'Dallas, US',
  DEN: 'Denver, US', LAX: 'Los Angeles, US', SJC: 'San Jose, US', SEA: 'Seattle, US', PHX: 'Phoenix, US',
  MIA: 'Miami, US', BOS: 'Boston, US', IAH: 'Houston, US', MSP: 'Minneapolis, US', SLC: 'Salt Lake City, US',
  PDX: 'Portland, US', LAS: 'Las Vegas, US', YYZ: 'Toronto, CA', YUL: 'Montreal, CA', YVR: 'Vancouver, CA',
  QRO: 'Queretaro, MX',
  // South America
  GRU: 'Sao Paulo, BR', GIG: 'Rio de Janeiro, BR', EZE: 'Buenos Aires, AR', SCL: 'Santiago, CL',
  BOG: 'Bogota, CO', LIM: 'Lima, PE',
  // Europe
  AMS: 'Amsterdam, NL', FRA: 'Frankfurt, DE', LHR: 'London, UK', CDG: 'Paris, FR', MAD: 'Madrid, ES',
  MXP: 'Milan, IT', ARN: 'Stockholm, SE', WAW: 'Warsaw, PL', VIE: 'Vienna, AT', PRG: 'Prague, CZ',
  HEL: 'Helsinki, FI', ZRH: 'Zurich, CH', DUB: 'Dublin, IE', CPH: 'Copenhagen, DK', OSL: 'Oslo, NO',
  BRU: 'Brussels, BE', MRS: 'Marseille, FR', BCN: 'Barcelona, ES', LIS: 'Lisbon, PT', MUC: 'Munich, DE',
  DUS: 'Dusseldorf, DE', HAM: 'Hamburg, DE', BER: 'Berlin, DE', MAN: 'Manchester, UK', OTP: 'Bucharest, RO',
  SOF: 'Sofia, BG', BUD: 'Budapest, HU', ATH: 'Athens, GR', KBP: 'Kyiv, UA', IST: 'Istanbul, TR',
  // Asia-Pacific
  NRT: 'Tokyo, JP', KIX: 'Osaka, JP', HKG: 'Hong Kong', SIN: 'Singapore', ICN: 'Seoul, KR',
  TPE: 'Taipei, TW', BOM: 'Mumbai, IN', DEL: 'Delhi, IN', MAA: 'Chennai, IN', BLR: 'Bangalore, IN',
  CGK: 'Jakarta, ID', KUL: 'Kuala Lumpur, MY', BKK: 'Bangkok, TH', MNL: 'Manila, PH',
  SYD: 'Sydney, AU', MEL: 'Melbourne, AU', BNE: 'Brisbane, AU', PER: 'Perth, AU', AKL: 'Auckland, NZ',
  // Africa / Middle East
  JNB: 'Johannesburg, ZA', CPT: 'Cape Town, ZA', LOS: 'Lagos, NG', NBO: 'Nairobi, KE', CAI: 'Cairo, EG',
  DXB: 'Dubai, AE', TLV: 'Tel Aviv, IL', DOH: 'Doha, QA', BAH: 'Bahrain', RUH: 'Riyadh, SA',
};

// "Ashburn, US (IAD)" for a known datacenter, the bare code for an unknown
// one, else the region's name (before anything has been measured).
export function placeName(colo, region) {
  if (colo && Object.hasOwn(COLO_PLACES, colo)) return `${COLO_PLACES[colo]} (${colo})`;
  if (colo && /^[A-Z]{3}$/.test(colo)) return colo;
  return Object.hasOwn(REGIONS, region) ? REGIONS[region] : '';
}

// Short city name for the in-game ping readout ("Ashburn").
export function cityName(colo) {
  return colo && Object.hasOwn(COLO_PLACES, colo) ? COLO_PLACES[colo].split(',')[0] : (colo ?? '');
}
