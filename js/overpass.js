const Overpass = (() => {
  const HIGHWAY_FILTER = {
    walk: 'highway~"^(primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|cycleway|path|track)$"',
    drive: 'highway~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$|^(unclassified|residential|living_street|service)$"][access!~"^(private|no)$"',
  };

  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];

  async function fetchRoadNetwork(lat, lon, radiusMeters, mode) {
    const filter = HIGHWAY_FILTER[mode];
    const query = `[out:json][timeout:60][maxsize:50000000];
(
  way[${filter}](around:${Math.round(radiusMeters)},${lat},${lon});
);
out body;
>;
out skel qt;`;

    let lastErr;
    for (const endpoint of ENDPOINTS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 65000);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        return parseOSM(json);
      } catch (e) {
        lastErr = e.name === 'AbortError'
          ? new Error('Перевищено час очікування (65 с)')
          : e;
      }
    }
    throw new Error('Не вдалося отримати дані: ' + (lastErr?.message || 'невідома помилка'));
  }

  function parseOSM(json) {
    const nodes = new Map();
    const ways = [];
    for (const el of json.elements) {
      if (el.type === 'node') {
        nodes.set(el.id, { lat: el.lat, lon: el.lon });
      } else if (el.type === 'way') {
        ways.push({ id: el.id, nodes: el.nodes, tags: el.tags || {} });
      }
    }
    return { nodes, ways };
  }

  return { fetchRoadNetwork };
})();
