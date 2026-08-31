# -*- coding: utf-8 -*-
"""
Pre-processamento do GEOPORTAL SE-T3.

Processa UM voo de UM projeto por execucao:
  1. Le o GeoJSON de vegetacao (EPSG:32724), simplifica as geometrias e reprojeta
     para EPSG:4326, gravando data/<projeto>/<data>/vegetacao_4326.geojson.
  2. Le a ortofoto (RGBA) e gera uma piramide de tiles XYZ (EPSG:3857) em WebP
     em data/<projeto>/<data>/tiles/{z}/{x}/{y}.webp.
  3. Grava data/<projeto>/<data>/meta.json (bounds, contagem/area por classe).
  4. Reconstroi data/catalog.json varrendo todos os meta.json existentes.

Uso:
    python build_data.py --project se-t3 --project-name "SE-T3" --date 2026-08-03 ^
        [--src-geojson "...VEGETAÇAO CLASSIFICADA.geojson"] [--src-tif "...ORTO_WEBGIS.tif"] ^
        [--skip-vector] [--skip-raster]

Para so reconstruir o catalogo (depois de mexer/remover uma pasta de voo a mao):
    python build_data.py --catalog-only
"""
import argparse
import glob
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
DATA_DIR = os.path.join(WEBGIS_DIR, "data")
CATALOG_PATH = os.path.join(DATA_DIR, "catalog.json")

DEFAULT_SRC_GEOJSON = os.path.join(SRC_DIR, "VEGETAÇAO CLASSIFICADA.geojson")
DEFAULT_SRC_TIF = os.path.join(SRC_DIR, "ORTO_WEBGIS.tif")

SIMPLIFY_TOLERANCE_M = 0.20  # metros, aplicado em UTM antes de reprojetar
MIN_ZOOM = 15
MAX_ZOOM = 21
TILE_SIZE = 256
TILE_EXT = "webp"

# id -> nome de exibicao da classe, usado so pra montar o resumo em meta.json
# (o app.js tem sua propria copia, com as cores; aqui e so pra estatistica)
CLASS_NAMES = {
    1: "Solo",
    2: "Roço (até 0,40 m)",
    3: "Poda Leve (0,40 m a 3,00 m)",
    4: "Poda Seletiva (3,00 m a 8,00 m)",
    6: "Não Identificado",
}

WEB_MERCATOR_R = 6378137.0
WEB_MERCATOR_ORIGIN = math.pi * WEB_MERCATOR_R  # 20037508.342789244


def log(msg):
    print(f"[build_data] {msg}", flush=True)


def flight_dir(project, date):
    return os.path.join(DATA_DIR, project, date)


# ----------------------------------------------------------------------
# 1. Vetor: simplifica + reprojeta
# ----------------------------------------------------------------------
def build_vector(src_geojson, out_dir):
    log(f"Lendo {src_geojson} ...")
    t0 = time.time()
    with open(src_geojson, "r", encoding="utf-8") as f:
        data = json.load(f)

    src_size = os.path.getsize(src_geojson)
    transformer = Transformer.from_crs("EPSG:32724", "EPSG:4326", always_xy=True)

    out_features = []
    class_stats = {}  # classe_id -> {count, area_m2}

    for feat in data["features"]:
        geom = shape(feat["geometry"])
        # simplifica em UTM (metros) para remover ruido de vetorizacao de raster
        geom = geom.simplify(SIMPLIFY_TOLERANCE_M, preserve_topology=True)
        if geom.is_empty:
            continue

        # reprojeta para WGS84
        geom = shapely_transform(geom, transformer)

        props = feat.get("properties", {})
        classe_id = props.get("classe_id")
        area_m2 = float(props.get("area_m2") or 0)

        st = class_stats.setdefault(classe_id, {"count": 0, "areaM2": 0.0})
        st["count"] += 1
        st["areaM2"] += area_m2

        out_features.append({
            "type": "Feature",
            "properties": {
                "classe_id": classe_id,
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

    out_path = os.path.join(out_dir, "vegetacao_4326.geojson")
    os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)

    out_size = os.path.getsize(out_path)
    log(f"Vegetacao: {len(out_features)} feicoes | {src_size/1e6:.1f} MB -> {out_size/1e6:.1f} MB "
        f"| {time.time()-t0:.1f}s")

    classes = []
    for cid, st in sorted(class_stats.items(), key=lambda kv: (kv[0] is None, kv[0])):
        classes.append({
            "id": cid,
            "name": CLASS_NAMES.get(cid, f"Classe {cid}"),
            "count": st["count"],
            "areaM2": round(st["areaM2"], 2),
        })
    return classes


def shapely_transform(geom, transformer):
    from shapely.ops import transform as shp_transform
    return shp_transform(lambda x, y, z=None: transformer.transform(x, y), geom)


# ----------------------------------------------------------------------
# 2. Raster: piramide de tiles XYZ (EPSG:3857), formato WebP
# ----------------------------------------------------------------------
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


def build_raster(src_tif, out_dir):
    log(f"Abrindo {src_tif} ...")
    t0 = time.time()
    out_tiles = os.path.join(out_dir, "tiles")

    with rasterio.open(src_tif) as src:
        bounds_4326 = src.bounds  # (left, bottom, right, top), ja em EPSG:4326

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

                        tile_dir = os.path.join(out_tiles, str(z), str(x))
                        os.makedirs(tile_dir, exist_ok=True)
                        img.save(
                            os.path.join(tile_dir, f"{y}.{TILE_EXT}"),
                            "WEBP", quality=85, method=6,
                        )
                        written_tiles += 1
                        z_written += 1
                log(f"  zoom {z}: {z_written} tiles gravados")

    dur = time.time() - t0
    log(f"Raster: {written_tiles}/{total_tiles} tiles gravados em {dur:.1f}s")

    size = 0
    for root, _, files in os.walk(out_tiles):
        for fn in files:
            size += os.path.getsize(os.path.join(root, fn))
    log(f"Tamanho total tiles ({TILE_EXT}): {size/1e6:.1f} MB")

    return bounds_4326


# ----------------------------------------------------------------------
# 3. meta.json por voo + catalog.json agregado
# ----------------------------------------------------------------------
def write_flight_meta(out_dir, project, project_name, date, bounds_4326, classes):
    left, bottom, right, top = bounds_4326
    meta = {
        "project": project,
        "projectName": project_name,
        "date": date,
        "bounds": [[bottom, left], [top, right]],  # [[south, west], [north, east]]
        "tileExt": TILE_EXT,
        "minNativeZoom": MIN_ZOOM,
        "maxNativeZoom": MAX_ZOOM,
        "classes": classes,
    }
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    return meta


def rebuild_catalog():
    log("Reconstruindo catalog.json ...")
    projects = {}  # id -> {"id","name","flights":[...]}

    for meta_path in sorted(glob.glob(os.path.join(DATA_DIR, "*", "*", "meta.json"))):
        flight_folder = os.path.dirname(meta_path)
        date_folder = os.path.basename(flight_folder)
        project_folder = os.path.basename(os.path.dirname(flight_folder))

        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)

        pid = meta.get("project", project_folder)
        pname = meta.get("projectName", pid)
        date = meta.get("date", date_folder)

        rel_base = f"{pid}/{date}"
        entry = projects.setdefault(pid, {"id": pid, "name": pname, "flights": []})
        entry["name"] = pname  # ultima vista vence, mas normalmente e sempre igual
        entry["flights"].append({
            "date": date,
            "bounds": meta["bounds"],
            "tiles": f"{rel_base}/tiles",
            "tileExt": meta.get("tileExt", TILE_EXT),
            "minNativeZoom": meta.get("minNativeZoom", MIN_ZOOM),
            "maxNativeZoom": meta.get("maxNativeZoom", MAX_ZOOM),
            "vegetation": f"{rel_base}/vegetacao_4326.geojson",
            "classes": meta.get("classes", []),
        })

    project_list = []
    for pid in sorted(projects.keys()):
        p = projects[pid]
        p["flights"].sort(key=lambda fl: fl["date"], reverse=True)
        project_list.append(p)

    catalog = {"projects": project_list}
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CATALOG_PATH, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)

    n_flights = sum(len(p["flights"]) for p in project_list)
    log(f"Catalogo: {len(project_list)} projeto(s), {n_flights} voo(s) -> {CATALOG_PATH}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", help="slug do projeto, ex: se-t3")
    parser.add_argument("--project-name", help="nome de exibicao do projeto (default: --project)")
    parser.add_argument("--date", help="data do voo, AAAA-MM-DD")
    parser.add_argument("--src-geojson", default=DEFAULT_SRC_GEOJSON)
    parser.add_argument("--src-tif", default=DEFAULT_SRC_TIF)
    parser.add_argument("--skip-vector", action="store_true")
    parser.add_argument("--skip-raster", action="store_true")
    parser.add_argument("--catalog-only", action="store_true",
                         help="so reconstroi data/catalog.json a partir dos meta.json existentes")
    args = parser.parse_args()

    if args.catalog_only:
        rebuild_catalog()
        log("Concluido.")
        return

    if not args.project or not args.date:
        parser.error("--project e --date sao obrigatorios (ou use --catalog-only)")

    project = args.project
    project_name = args.project_name or args.project
    date = args.date
    out_dir = flight_dir(project, date)
    os.makedirs(out_dir, exist_ok=True)

    classes = []
    if not args.skip_vector:
        classes = build_vector(args.src_geojson, out_dir)
    elif os.path.exists(os.path.join(out_dir, "meta.json")):
        with open(os.path.join(out_dir, "meta.json"), "r", encoding="utf-8") as f:
            classes = json.load(f).get("classes", [])

    bounds_4326 = None
    if not args.skip_raster:
        bounds_4326 = build_raster(args.src_tif, out_dir)
    elif os.path.exists(os.path.join(out_dir, "meta.json")):
        with open(os.path.join(out_dir, "meta.json"), "r", encoding="utf-8") as f:
            b = json.load(f)["bounds"]
            bounds_4326 = (b[0][1], b[0][0], b[1][1], b[1][0])

    if bounds_4326 is None:
        with rasterio.open(args.src_tif) as src:
            bounds_4326 = src.bounds

    write_flight_meta(out_dir, project, project_name, date, bounds_4326, classes)
    rebuild_catalog()

    log("Concluido.")


if __name__ == "__main__":
    main()
