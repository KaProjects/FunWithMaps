'use strict';

/**
 * Age of Empires basemap: a flat, poster-bright version of the Detailed style.
 *
 * The reference is the AoE minimap -- saturated blue sea, grass-green land,
 * dark green woodland, tan desert, pale rivers, and nothing else. No roads, no
 * buildings, no labels, no political borders, no shaded relief.
 *
 * Rather than ship a second style document, this rewrites the Detailed one in
 * place, so it keeps tracking upstream and only the palette is ours. Layers it
 * does not recognise keep their original paint, so an upstream rename degrades
 * to "looks like the normal map" instead of breaking.
 */

const AOE = {
  land: '#43a038',
  sea: '#1b5fc8',
  wood: '#1d6b23',
  grass: '#4cb03f',
  sand: '#d8ab6b',
  ice: '#eaf2f6',
  wetland: '#4f9e6a',
  river: '#8ecdf2',
  border: '#1c3a16',
};

// Everything the minimap simply does not draw. Place names are deliberately
// absent from this list: they are left to the app's own label toggle.
const HIDE = [
  /^road/, /^bridge/, /^tunnel/, /^highway/, /^poi/, /^aeroway/,
  /^airport$/, /^boundary_3$/, /^building/, /^landuse/, /^park_outline$/,
];

const FILL = {
  landcover_wood: AOE.wood,
  park: AOE.wood,
  landcover_grass: AOE.grass,
  landcover_sand: AOE.sand,
  landcover_ice: AOE.ice,
  landcover_wetland: AOE.wetland,
  water: AOE.sea,
};

function buildAoeStyle(base) {
  const style = JSON.parse(JSON.stringify(base));
  style.name = 'AOE';

  style.layers = style.layers.map((layer) => {
    if (HIDE.some((pattern) => pattern.test(layer.id))) {
      return { ...layer, layout: { ...(layer.layout || {}), visibility: 'none' } };
    }

    // National outlines stay: without them the revealed land is an unreadable
    // green field. Province lines (boundary_3) are left out, to keep the
    // minimap feel.
    if (layer.id.startsWith('boundary')) {
      return {
        ...layer,
        paint: {
          ...layer.paint,
          'line-color': AOE.border,
          'line-opacity': 0.8,
        },
      };
    }

    if (layer.id === 'natural_earth') {
      // The shaded-relief raster is the only land detail these tiles carry at
      // continental zoom. Desaturated and held back to a third, it modulates
      // the flat green into something with terrain in it, without dragging the
      // map back towards realism.
      return {
        ...layer,
        paint: {
          'raster-saturation': -0.55,
          'raster-contrast': 0.15,
          'raster-opacity': 0.35,
        },
      };
    }

    if (layer.id === 'background') {
      // There is no global land polygon in these tiles: land *is* the
      // background, with water drawn over it.
      return { ...layer, paint: { 'background-color': AOE.land } };
    }

    if (FILL[layer.id] && layer.type === 'fill') {
      return {
        ...layer,
        paint: { ...layer.paint, 'fill-color': FILL[layer.id], 'fill-opacity': 1 },
      };
    }

    // Match on type as well as name: waterway_line_label is a symbol layer, and
    // writing line paint onto it makes the whole style invalid.
    if (layer.id.startsWith('waterway') && layer.type === 'line') {
      return {
        ...layer,
        paint: {
          ...layer.paint,
          'line-color': AOE.river,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 10, 2, 16, 5],
        },
      };
    }

    return layer;
  });

  return style;
}

window.buildAoeStyle = buildAoeStyle;

/* ---------- EUIV: a political map ---------- */

/**
 * A stable colour per country. Hashing the name keeps neighbours from shifting
 * about between runs, and holding saturation and lightness steady means every
 * country reads as the same kind of colour -- only the hue changes.
 */
function countryColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const saturation = 58 + (hash >> 9) % 22;   // 58-79%
  const lightness = 58 + (hash >> 17) % 12;   // 58-69%
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * Built on the AOE style, with the land repainted by who owns it.
 *
 * The tiles carry no country polygons -- only boundary lines -- so the fills
 * come from the same region file that draws the borders, inserted directly
 * above the background so everything else still lands on top of them.
 *
 * Terrain then stops being green and becomes shading: woodland darkens whatever
 * colour is underneath and open ground lightens it, so a forest in Poland is
 * dark Poland rather than green. Water is left alone.
 */
function buildEuivStyle(base, countries) {
  const style = buildAoeStyle(base);
  style.name = 'EUIV';

  // Neutral ground for anywhere the region file does not cover.
  const background = style.layers.find((l) => l.id === 'background');
  if (background) background.paint = { 'background-color': '#cfd3c4' };

  // AOE keeps a faint relief raster to give its flat green some texture. Here
  // it only greys the political colours down, and the game's map is flat, so
  // it goes.
  const relief = style.layers.find((l) => l.id === 'natural_earth');
  if (relief) relief.layout = { ...(relief.layout || {}), visibility: 'none' };

  style.sources = {
    ...style.sources,
    countries: { type: 'geojson', data: countries },
  };

  // Light enough to read as terrain without dulling the colour underneath.
  const shading = {
    landcover_wood: 'rgba(0, 0, 0, 0.17)',
    park: 'rgba(0, 0, 0, 0.13)',
    landcover_wetland: 'rgba(0, 0, 0, 0.10)',
    landcover_grass: 'rgba(255, 255, 255, 0.15)',
    landcover_sand: 'rgba(255, 255, 255, 0.30)',
    landcover_ice: 'rgba(255, 255, 255, 0.70)',
  };

  style.layers = style.layers.map((layer) => (
    shading[layer.id] && layer.type === 'fill'
      ? { ...layer, paint: { ...layer.paint, 'fill-color': shading[layer.id], 'fill-opacity': 1 } }
      : layer
  ));

  const at = style.layers.findIndex((l) => l.id === 'background') + 1;
  style.layers.splice(at, 0,
    {
      id: 'country_fill',
      type: 'fill',
      source: 'countries',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1 },
    },
    {
      // Province outlines, as the reference has. Thin and dark enough to divide
      // the land without competing with the national borders drawn later.
      id: 'country_outline',
      type: 'line',
      source: 'countries',
      paint: {
        'line-color': 'rgba(40, 42, 34, 0.45)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 7, 0.8, 12, 1.4],
      },
    });

  return style;
}

window.countryColor = countryColor;
window.buildEuivStyle = buildEuivStyle;
