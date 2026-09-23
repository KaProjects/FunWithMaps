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
