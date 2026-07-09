const Colors = (() => {
  const SCHEMES = {
    default: {
      name: 'Нічне сяйво',
      hue: [102, 34, 187],
      stops: [
        [0.00, [255, 255, 255]],
        [0.20, [255, 238,  68]],
        [0.40, [255, 153,  51]],
        [0.60, [255, 102, 136]],
        [0.80, [204,  68, 170]],
        [1.00, [102,  34, 187]],
      ],
      bands: ['#FFFFFF', '#FFEE44', '#FF9933', '#FF6688', '#CC44AA', '#6622BB'],
    },
    fire: {
      name: '🔥 Вогонь',
      hue: [255, 130, 0],
      stops: [
        [0.00, [255, 255, 200]],
        [0.20, [255, 220,  50]],
        [0.45, [255, 130,   0]],
        [0.70, [220,  30,  10]],
        [0.88, [130,   0,   0]],
        [1.00, [ 50,   0,   0]],
      ],
      bands: ['#FFFFC8', '#FFDC32', '#FF8200', '#DC1E0A', '#820000', '#320000'],
    },
    ocean: {
      name: '🌊 Океан',
      hue: [30, 150, 220],
      stops: [
        [0.00, [240, 250, 255]],
        [0.20, [140, 220, 255]],
        [0.45, [ 30, 150, 220]],
        [0.70, [  5,  80, 160]],
        [0.88, [  0,  35,  90]],
        [1.00, [  0,  10,  35]],
      ],
      bands: ['#F0FAFF', '#8CDCFF', '#1E96DC', '#0550A0', '#00235A', '#000A23'],
    },
    forest: {
      name: '🌲 Ліс',
      hue: [80, 175, 55],
      stops: [
        [0.00, [255, 255, 224]],
        [0.20, [190, 235, 110]],
        [0.45, [ 80, 175,  55]],
        [0.70, [ 25, 105,  25]],
        [0.88, [ 10,  55,  10]],
        [1.00, [  4,  22,   4]],
      ],
      bands: ['#FFFFE0', '#BEEB6E', '#50AF37', '#196919', '#0A370A', '#041604'],
    },
    sunset: {
      name: '🌅 Захід',
      hue: [255, 90, 60],
      stops: [
        [0.00, [255, 252, 220]],
        [0.20, [255, 200,  80]],
        [0.45, [255,  90,  60]],
        [0.70, [190,  30, 130]],
        [0.88, [100,   0, 120]],
        [1.00, [ 35,   0,  55]],
      ],
      bands: ['#FFFCDC', '#FFC850', '#FF5A3C', '#BE1E82', '#640078', '#230037'],
    },
    lightgreen: {
      name: '🌿 Світло-зелений',
      hue: [68, 153, 40],
      stops: [
        [0.00, [240, 255, 240]],
        [0.20, [212, 245, 200]],
        [0.40, [168, 232, 144]],
        [0.60, [114, 200,  80]],
        [0.80, [ 68, 153,  40]],
        [1.00, [ 42, 102,  24]],
      ],
      bands: ['#F0FFF0', '#D4F5C8', '#A8E890', '#72C850', '#449928', '#2A6618'],
    },
    transport: {
      name: 'Транспортна',
      hue: [98, 190, 110],
      stops: [
        [0.00, [148, 215, 151]],
        [0.20, [122, 205, 130]],
        [0.40, [ 98, 190, 110]],
        [0.60, [ 58, 175,  83]],
        [0.80, [ 36, 150,  74]],
        [1.00, [  7,  55,  65]],
      ],
      bands: ['#94D797', '#7ACD82', '#62BE6E', '#3AAF53', '#24964A', '#073741'],
      roadColor: '#9FF588',
      lightStops: [
        [0.00, [207, 255, 194]],
        [0.20, [183, 253, 165]],
        [0.40, [159, 245, 136]],
        [0.60, [133, 237, 105]],
        [0.80, [108, 229,  76]],
        [1.00, [ 82, 196,  56]],
      ],
      lightBands: ['#CFFFC2', '#B7FDA5', '#9FF588', '#85ED69', '#6CE54C', '#52C438'],
    },
  };

  const LIGHT_STOPS = [0.00, 0.20, 0.40, 0.60, 0.80, 1.00];

  let _schemeName = 'transport';
  let _background = 'dark';

  function rgbToHex([r, g, b]) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function blendHueToWhite(hue, t) {
    return [
      Math.round(hue[0] + t * (255 - hue[0])),
      Math.round(hue[1] + t * (255 - hue[1])),
      Math.round(hue[2] + t * (255 - hue[2])),
    ];
  }

  function buildLightPalette(hue) {
    const stops = LIGHT_STOPS.map(t => [t, blendHueToWhite(hue, t)]);
    const bands = stops.map(([, rgb]) => rgbToHex(rgb));
    return { stops, bands };
  }

  function activePalette() {
    const scheme = SCHEMES[_schemeName];
    if (_background === 'dark') {
      return { stops: scheme.stops, bands: scheme.bands };
    }
    if (scheme.lightStops && scheme.lightBands) {
      return { stops: scheme.lightStops, bands: scheme.lightBands };
    }
    return buildLightPalette(scheme.hue);
  }

  function setScheme(name) {
    if (SCHEMES[name]) _schemeName = name;
  }

  function setBackground(mode) {
    if (mode === 'light' || mode === 'dark') _background = mode;
  }

  function interpolateColor(t) {
    t = Math.max(0, Math.min(1, t));
    const stops = activePalette().stops;
    for (let i = 1; i < stops.length; i++) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      if (t <= t1) {
        const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
        const r = Math.round(c0[0] + f * (c1[0] - c0[0]));
        const g = Math.round(c0[1] + f * (c1[1] - c0[1]));
        const b = Math.round(c0[2] + f * (c1[2] - c0[2]));
        return rgbToHex([r, g, b]);
      }
    }
    const last = stops[stops.length - 1][1];
    return rgbToHex(last);
  }

  function roadColor() {
    const scheme = SCHEMES[_schemeName];
    if (_background === 'dark' && scheme.roadColor) {
      return scheme.roadColor;
    }
    return '#FFFFFF';
  }

  return {
    setScheme,
    setBackground,
    interpolateColor,
    roadColor,
    get BANDS() {
      return activePalette().bands.map(color => ({ color }));
    },
    get SCHEMES() {
      return SCHEMES;
    },
    get background() {
      return _background;
    },
  };
})();
