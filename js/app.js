// State
let currentGraph = null;
let currentDistMap = null;
let currentMaxTimeSec = null;
let currentVizMode = 'isochrone';
let currentLng = null;
let currentLat = null;
let runId = 0;

// Custom vector styles (OpenFreeMap tiles; dark palette centered on #08013A)
const STYLES = {
  dark: 'styles/map-dark.json',
  light: 'https://tiles.openfreemap.org/styles/liberty',
};

const map = new maplibregl.Map({
  container: 'map',
  style: STYLES.dark,
  center: [30.52, 50.45],
  zoom: 13,
});

// Dark mode
let isDarkMode = true;

// UI refs
const maxTimeSlider  = document.getElementById('max-time');
const maxTimeLabel   = document.getElementById('max-time-label');
const travelMode     = document.getElementById('travel-mode');
const btnStreets     = document.getElementById('btn-streets');
const btnIsochrone   = document.getElementById('btn-isochrone');
const chkStreetOverlay = document.getElementById('chk-street-overlay');
const streetDetail   = document.getElementById('street-detail');
const colorScheme    = document.getElementById('color-scheme');
const colorBackground = document.getElementById('color-background');
const schemePreview  = document.getElementById('scheme-preview');
const btnExport      = document.getElementById('btn-export');
const btnExportPng   = document.getElementById('btn-export-png');
const statusEl       = document.getElementById('status');
const loadingEl      = document.getElementById('loading');
const loadingMsgEl   = document.getElementById('loading-msg');
const legendEl       = document.getElementById('legend');

function updateLabel() {
  maxTimeLabel.textContent = maxTimeSlider.value + ' хв';
}
maxTimeSlider.addEventListener('input', updateLabel);
updateLabel();

travelMode.addEventListener('change', () => {
  if (travelMode.value === 'drive') {
    maxTimeSlider.max = 90;
  } else {
    maxTimeSlider.max = 60;
    if (parseInt(maxTimeSlider.value) > 60) maxTimeSlider.value = 60;
  }
  updateLabel();
});

btnStreets.addEventListener('click', () => {
  if (currentVizMode === 'streets') return;
  currentVizMode = 'streets';
  btnStreets.classList.add('active');
  btnIsochrone.classList.remove('active');
  if (currentGraph) void rerender();
});

btnIsochrone.addEventListener('click', () => {
  if (currentVizMode === 'isochrone') return;
  currentVizMode = 'isochrone';
  btnIsochrone.classList.add('active');
  btnStreets.classList.remove('active');
  if (currentGraph) void rerender();
});

// Overlay detail level, or null when the overlay is off
function streetOverlayDetail() {
  return chkStreetOverlay.checked ? streetDetail.value : null;
}

function syncStreetDetail() {
  streetDetail.hidden = !chkStreetOverlay.checked;
}
syncStreetDetail();

chkStreetOverlay.addEventListener('change', () => {
  syncStreetDetail();
  if (currentGraph && currentVizMode === 'isochrone') void rerender();
});

streetDetail.addEventListener('change', () => {
  if (currentGraph && currentVizMode === 'isochrone') void rerender();
});

document.getElementById('btn-dark').addEventListener('click', () => {
  isDarkMode = !isDarkMode;
  const btn = document.getElementById('btn-dark');
  btn.textContent = isDarkMode ? '☀️' : '🌙';
  btn.title = isDarkMode ? 'Світла тема' : 'Темна тема';
  document.body.classList.toggle('dark', isDarkMode);

  // Swap vector basemap (setStyle re-creates the base; custom layers restored after)
  map.setStyle(isDarkMode ? STYLES.dark : STYLES.light);

  // Re-render isochrone/streets layers once the new base style is ready
  map.once('styledata', () => {
    if (currentLng != null && currentLat != null) {
      Renderer.showStartPoint(map, currentLng, currentLat);
    }
    if (currentGraph && currentDistMap) {
      void doRender(++runId, Math.round(currentMaxTimeSec / 60));
    }
  });
});

colorScheme.addEventListener('change', () => {
  Colors.setScheme(colorScheme.value);
  updateSchemePreview();
  if (currentGraph) void rerender();
});

colorBackground.addEventListener('change', () => {
  Colors.setBackground(colorBackground.value);
  updateSchemePreview();
  if (currentGraph) void rerender();
});

Colors.setScheme(colorScheme.value);
Colors.setBackground(colorBackground.value);
updateSchemePreview();

function exportFilename(ext) {
  const maxTimeMin = Math.round(currentMaxTimeSec / 60);
  const mode = currentVizMode === 'streets' ? 'streets' : 'isochrone';
  return `isochrone_${mode}_${maxTimeMin}min.${ext}`;
}

function setExportEnabled(enabled) {
  btnExport.disabled = !enabled;
  btnExportPng.disabled = !enabled;
}

btnExport.addEventListener('click', () => {
  if (!currentGraph || !currentDistMap) return;
  const svg = Export.exportSVG(map, currentGraph, currentDistMap, currentMaxTimeSec, currentVizMode, currentLng, currentLat, streetOverlayDetail());
  Export.download(svg, exportFilename('svg'));
});

btnExportPng.addEventListener('click', async () => {
  if (!currentGraph || !currentDistMap) return;
  setExportEnabled(false);
  try {
    const svg = Export.exportSVG(map, currentGraph, currentDistMap, currentMaxTimeSec, currentVizMode, currentLng, currentLat, streetOverlayDetail());
    await Export.downloadPNG(svg, exportFilename('png'));
  } catch (err) {
    setStatus('Помилка експорту PNG: ' + err.message, true);
    console.error(err);
  } finally {
    setExportEnabled(true);
  }
});

map.on('click', e => {
  currentLng = e.lngLat.lng;
  currentLat = e.lngLat.lat;
  Renderer.showStartPoint(map, currentLng, currentLat);
  void runPipeline();
});

async function runPipeline() {
  const thisId = ++runId;
  const maxTimeMin = parseInt(maxTimeSlider.value);
  const mode = travelMode.value;
  const maxTimeSec = maxTimeMin * 60;
  const avgSpeed = mode === 'walk' ? 1.389 : 13.889;
  const radiusM = maxTimeSec * avgSpeed * 1.3;

  Renderer.clearLayers(map);
  currentGraph = null;
  currentDistMap = null;
  legendEl.innerHTML = '';
  setExportEnabled(false);

  try {
    setLoading('Завантаження дорожньої мережі…');
    const osmData = await Overpass.fetchRoadNetwork(currentLat, currentLng, radiusM, mode);
    if (thisId !== runId) return;

    setLoading('Побудова графу…');
    await tick();
    const graph = Graph.buildGraph(osmData, mode);

    if (graph.edges.length === 0) throw new Error('Дороги не знайдено в цьому районі.');

    setLoading(`Обрахунок (${graph.nodes.size} вузлів)…`);
    await tick();

    const sourceId = Graph.nearestNode(graph, currentLng, currentLat);
    if (!sourceId) throw new Error('Не знайдено найближчий вузол мережі.');

    const distMap = Dijkstra.dijkstra(graph, sourceId);
    if (thisId !== runId) return;

    currentGraph = graph;
    currentDistMap = distMap;
    currentMaxTimeSec = maxTimeSec;

    await doRender(thisId, maxTimeMin);
  } catch (err) {
    if (thisId !== runId) return;
    setLoading(null);
    setStatus('Помилка: ' + err.message, true);
    console.error(err);
  }
}

async function rerender() {
  if (!currentGraph || !currentDistMap) return;
  const thisId = ++runId;
  const maxTimeMin = parseInt(maxTimeSlider.value);
  await doRender(thisId, maxTimeMin);
}

async function doRender(thisId, maxTimeMin) {
  Renderer.clearLayers(map);
  setLoading('Відображення…');

  try {
    if (currentVizMode === 'streets') {
      Renderer.renderStreets(map, currentGraph, currentDistMap, currentMaxTimeSec);
    } else {
      await Renderer.renderIsochrone(
        map, currentGraph, currentDistMap, currentMaxTimeSec,
        (bandIdx, total) => {
          if (thisId === runId) {
            setLoading(`Відображення бенду ${total - bandIdx}/${total}…`);
          }
        },
        streetOverlayDetail()
      );
    }
    if (thisId !== runId) return;
    if (currentLng != null && currentLat != null) {
      Renderer.showStartPoint(map, currentLng, currentLat);
    }
    buildLegend(maxTimeMin);
    setExportEnabled(true);
    setLoading(null);
    setStatus('Готово. Клікніть на карту для нового розрахунку.');
  } catch (err) {
    if (thisId !== runId) return;
    setLoading(null);
    setStatus('Помилка відображення: ' + err.message, true);
    console.error(err);
  }
}

function buildLegend(maxTimeMin) {
  const step = maxTimeMin / Colors.BANDS.length;
  legendEl.innerHTML = Colors.BANDS.map((b, i) => {
    const to = Math.round((i + 1) * step);
    const border = isLightColor(b.color) ? ' border:1px solid #ccc;' : '';
    return `<div class="legend-row">
      <span class="legend-swatch" style="background:${b.color};${border}"></span>
      <span class="legend-label">&lt; ${to} хв</span>
    </div>`;
  }).join('');
}

function isLightColor(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 225;
}

function updateSchemePreview() {
  schemePreview.innerHTML = Colors.BANDS.map(({ color }) => {
    const lightClass = isLightColor(color) ? ' is-light' : '';
    return `<span class="scheme-preview-swatch${lightClass}" style="background:${color}"></span>`;
  }).join('');
}

function setLoading(msg) {
  if (msg) {
    loadingEl.classList.remove('hidden');
    loadingMsgEl.textContent = msg;
  } else {
    loadingEl.classList.add('hidden');
  }
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

function tick() {
  return new Promise(r => setTimeout(r, 0));
}
