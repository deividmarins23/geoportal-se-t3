# -*- coding: utf-8 -*-
"""
Pre-processamento do GEOPORTAL SE-T3.

Roda uma unica vez (ou sempre que os arquivos de origem mudarem):
  1. Le "VEGETACAO CLASSIFICADA.geojson" (EPSG:32724), simplifica as geometrias
     e reprojeta para EPSG:4326, gravando data/vegetacao_4326.geojson.
  2. Le "ORTO_WEBGIS.tif" (RGBA, EPSG:4326) e gera uma piramide de tiles XYZ
     (EPSG:3857) em data/tiles/{z}/{x}/{y}.png para uso offline no Leaflet.

Uso:
    python build_data.py [--skip-vector] [--skip-raster]
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.windows import from_bounds
from PIL import Image
from pyproj import Transformer
from shapely.geometry import shape, mapping

WEBGIS_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.dirname(WEBGIS_DIR)

SRC_GEOJSON = os.path.join(SRC_DIR, "VEGETAÇAO CLASSIFICADA.geojson")
SRC_TIF = os.path.join(SRC_DIR, "ORTO_WEBGIS.tif")

OUT_GEOJSON = os.path.join(WEBGIS_DIR, "data", "vegetacao_4326.geojson")
OUT_TILES = os.path.join(WEBGIS_DIR, "data", "tiles")

SIMPLIFY_TOLERANCE_M = 0.20  # metros, aplicado em UTM antes de reprojetar
MIN_ZOOM = 15
MAX_ZOOM = 21
TILE_SIZE = 256

WEB_MERCATOR_R = 6378137.0
WEB_MERCATOR_ORIGIN = math.pi * WEB_MERCATOR_R  # 20037508.342789244


def log(msg):
    print(f"[build_data] {msg}", flush=True)


# ----------------------------------------------------------------------
# 1. Vetor: simplifica + reprojeta
# ----------------------------------------------------------------------
def build_vector():
    log(f"Lendo {SRC_GEOJSON} ...")
    t0 = time.time()
    with open(SRC_GEOJSON, "r", encoding="utf-8") as f:
        data = json.load(f)

    src_size = os.path.getsize(SRC_GEOJSON)
    transformer = Transformer.from_crs("EPSG:32724", "EPSG:4326", always_xy=True)

    out_features = []
    for feat in data["features"]:
        geom = shape(feat["geometry"])
        # simplifica em UTM (metros) para remover ruido de vetorizacao de raster
        geom = geom.simplify(SIMPLIFY_TOLERANCE_M, preserve_topology=True)
        if geom.is_empty:
            continue

        # reprojeta para WGS84
        geom = shapely_transform(geom, transformer)

        props = feat.get("properties", {})
        out_features.append({
            "type": "Feature",
            "properties": {
                "classe_id": props.get("classe_id"),
                "classe_nome": props.get("classe_nome"),
                "rotulo": props.get("rotulo"),
                "area_m2": props.get("area_m2"),
            },
            "geometry": mapping(geom),
        })

    out = {
        "type": "FeatureCollection",
        "name": "vegetacao_4326",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": out_features,
    }

    os.makedirs(os.path.dirname(OUT_GEOJSON), exist_ok=True)
    with open(OUT_GEOJSON, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)

    out_size = os.path.getsize(OUT_GEOJSON)
    log(f"Vegetacao: {len(out_features)} feicoes | {src_size/1e6:.1f} MB -> {out_size/1e6:.1f} MB "
        f"| {time.time()-t0:.1f}s")


def shapely_transform(geom, transformer):
    from shapely.ops import transform as shp_transform
    return shp_transform(lambda x, y, z=None: transformer.transform(x, y), geom)


# ----------------------------------------------------------------------
# 2. Raster: piramide de tiles XYZ (EPSG:3857)
# ----------------------------------------------------------------------
def lonlat_to_mercator(lon, lat):
    x = lon * WEB_MERCATOR_ORIGIN / 180.0
    y = math.log(math.tan((90.0 + lat) * math.pi / 360.0)) / (math.pi / 180.0)
    y = y * WEB_MERCATOR_ORIGIN / 180.0
    return x, y


def tile_bounds_merc(z, x, y):
    n = 2 ** z
    tile_size_m = 2 * WEB_MERCATOR_ORIGIN / n
    minx = -WEB_MERCATOR_ORIGIN + x * tile_size_m
    maxx = minx + tile_size_m
    maxy = WEB_MERCATOR_ORIGIN - y * tile_size_m
    miny = maxy - tile_size_m
    return minx, miny, maxx, maxy


def merc_to_tile_xy(z, mx, my):
    n = 2 ** z
    tile_size_m = 2 * WEB_MERCATOR_ORIGIN / n
    x = int((mx + WEB_MERCATOR_ORIGIN) / tile_size_m)
    y = int((WEB_MERCATOR_ORIGIN - my) / tile_size_m)
    return x, y


def build_raster():
    log(f"Abrindo {SRC_TIF} ...")
    t0 = time.time()
    with rasterio.open(SRC_TIF) as src:
        with WarpedVRT(src, crs="EPSG:3857", resampling=Resampling.bilinear) as vrt:
            left, bottom, right, top = vrt.bounds
            log(f"Bounds (EPSG:3857): {left:.1f}, {bottom:.1f}, {right:.1f}, {top:.1f}")

            total_tiles = 0
            written_tiles = 0
            for z in range(MIN_ZOOM, MAX_ZOOM + 1):
                x0, y0 = merc_to_tile_xy(z, left, top)
                x1, y1 = merc_to_tile_xy(z, right, bottom)
                xs = range(min(x0, x1), max(x0, x1) + 1)
                ys = range(min(y0, y1), max(y0, y1) + 1)

                z_written = 0
                for x in xs:
                    for y in ys:
                        total_tiles += 1
                        minx, miny, maxx, maxy = tile_bounds_merc(z, x, y)
                        window = from_bounds(minx, miny, maxx, maxy, transform=vrt.transform)
                        try:
                            data = vrt.read(
                                out_shape=(vrt.count, TILE_SIZE, TILE_SIZE),
                                window=window,
                                resampling=Resampling.bilinear,
                            )
                        except Exception:
                            continue

                        if data.shape[0] < 4:
                            continue
                        alpha = data[3]
                        if not np.any(alpha):
                            continue  # tile totalmente transparente, pula

                        arr = np.moveaxis(data[:4], 0, -1)
                        img = Image.fromarray(arr, mode="RGBA")

                        tile_dir = os.path.join(OUT_TILES, str(z), str(x))
                        os.makedirs(tile_dir, exist_ok=True)
                        img.save(os.path.join(tile_dir, f"{y}.png"), optimize=True)
                        written_tiles += 1
                        z_written += 1
                log(f"  zoom {z}: {z_written} tiles gravados")

    dur = time.time() - t0
    log(f"Raster: {written_tiles}/{total_tiles} tiles gravados em {dur:.1f}s")

    size = 0
    for root, _, files in os.walk(OUT_TILES):
        for fn in files:
            size += os.path.getsize(os.path.join(root, fn))
    log(f"Tamanho total data/tiles: {size/1e6:.1f} MB")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-vector", action="store_true")
    parser.add_argument("--skip-raster", action="store_true")
    args = parser.parse_args()

    if not args.skip_vector:
        build_vector()
    if not args.skip_raster:
        build_raster()

    log("Concluido.")


if __name__ == "__main__":
    main()
