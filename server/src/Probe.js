import { DurableObject } from 'cloudflare:workers';

// Latency probe. One instance per region, created with that region's
// location hint, so a browser timing a round trip to /probe/<region> gets
// the same path a match in that region would use (browser -> nearest
// Cloudflare edge -> the region). Also reports which datacenter it's in.

export class Probe extends DurableObject {
  async fetch() {
    this.colo ??= await datacenter();
    return new Response(JSON.stringify({ ok: true, colo: this.colo }), { headers: { 'Content-Type': 'application/json' } });
  }
}

// The three-letter code of the Cloudflare datacenter this code runs in.
export async function datacenter() {
  try {
    const text = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text();
    return /colo=(\w+)/.exec(text)?.[1] ?? '?';
  } catch {
    return '?';
  }
}
